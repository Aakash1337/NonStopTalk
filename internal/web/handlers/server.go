package handlers

import (
	"bytes"
	"context"
	"html/template"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"dontstoptalking/internal/game"
	"dontstoptalking/internal/judge"
	"dontstoptalking/internal/room"
	"dontstoptalking/internal/topics"
)

const (
	tokenCookie    = "dst_token"
	maxRequestBody = 64 << 10 // 64 KiB

	// completionGraceSeconds forgives clock skew between the browser timer
	// and the server turn clock when awarding the completion bonus.
	completionGraceSeconds = 2

	// maxTranscriptBytes caps the browser-supplied transcript sent to the
	// judge; a 5-minute turn is well under this.
	maxTranscriptBytes = 8 << 10
	judgeTimeout       = 30 * time.Second
)

type Server struct {
	rooms     *room.Manager
	packs     []topics.Pack
	template  *template.Template
	limiter   *rateLimiter
	judge     judge.Provider
	generator judge.TopicGenerator
	// hostClaimGrace is how long the host must be gone before another member
	// can claim the room.
	hostClaimGrace time.Duration
}

// SetHostClaimGrace overrides the claim grace period (used by tests).
func (s *Server) SetHostClaimGrace(grace time.Duration) {
	s.hostClaimGrace = grace
}

// EnablePersistence loads previously saved rooms and starts autosaving them,
// so games survive server restarts. Failures are logged and non-fatal.
func (s *Server) EnablePersistence(path string) {
	if err := s.rooms.LoadFrom(path); err != nil {
		log.Printf("could not restore rooms from %s: %v", path, err)
	}
	s.rooms.StartAutosave(path, 10*time.Second)
}

// SetJudge swaps the relevance judge (used by tests).
func (s *Server) SetJudge(provider judge.Provider) {
	s.judge = provider
}

// SetTopicGenerator swaps the topic generator (used by tests).
func (s *Server) SetTopicGenerator(generator judge.TopicGenerator) {
	s.generator = generator
}

type ViewData struct {
	// Room context
	Code        string
	Base        string
	IsHost      bool
	YouID       string
	IsActor     bool
	// ActorIsRemote is true when the active turn belongs to a player driven
	// from another browser, so the host spectates instead of running the mic.
	ActorIsRemote bool
	IsNextUp      bool
	TurnRunning   bool
	Remaining     int
	Online        map[string]bool
	// Bound marks players driven from their own browser (eligible to host).
	Bound map[string]bool
	// HostPlayerID is the seat bound to the host, "" if the host only runs
	// the screen.
	HostPlayerID string
	// CanClaimHost is true for seated members when the host has been gone
	// past the grace period.
	CanClaimHost bool

	// Game state
	Session     *game.Session
	Packs       []topics.Pack
	Selected    topics.Pack
	Error       string
	LastTurn    *game.Turn
	Standings   []game.Player
	CurrentTurn *game.Turn
}

func NewServer(templatePattern string) (*Server, error) {
	tmpl, err := template.New("app").Funcs(template.FuncMap{
		"joinLines": func(lines []string) string { return strings.Join(lines, "\n") },
	}).ParseGlob(templatePattern)
	if err != nil {
		return nil, err
	}
	// The Claude judge and topic generator are used when credentials are
	// configured; otherwise transparent offline fallbacks keep both features
	// playable and testable.
	var relevanceJudge judge.Provider = judge.Heuristic{}
	var generator judge.TopicGenerator = judge.Heuristic{}
	if os.Getenv("ANTHROPIC_API_KEY") != "" {
		claude := judge.NewAnthropic()
		relevanceJudge = claude
		generator = claude
	}
	return &Server{
		rooms:          room.NewManager(),
		packs:          topics.PresetPacks(),
		template:       tmpl,
		limiter:        newRateLimiter(),
		judge:          relevanceJudge,
		generator:      generator,
		hostClaimGrace: 30 * time.Second,
	}, nil
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.handleLanding)
	mux.HandleFunc("POST /rooms", s.handleCreateRoom)
	mux.HandleFunc("POST /rooms/join", s.handleJoinRoom)

	mux.HandleFunc("GET /room/{code}", s.roomHandler(s.handleRoomPage))
	mux.HandleFunc("GET /room/{code}/partial", s.roomHandler(s.handleRoomPartial))
	mux.HandleFunc("GET /room/{code}/events", s.roomHandler(s.handleEvents))
	mux.HandleFunc("POST /room/{code}/players", s.roomHandler(s.handleAddPlayer))
	mux.HandleFunc("POST /room/{code}/players/rename", s.roomHandler(s.handleRenamePlayer))
	mux.HandleFunc("POST /room/{code}/players/move", s.roomHandler(s.handleMovePlayer))
	mux.HandleFunc("POST /room/{code}/players/remove", s.roomHandler(s.handleRemovePlayer))
	mux.HandleFunc("POST /room/{code}/leave", s.roomHandler(s.handleLeave))
	mux.HandleFunc("POST /room/{code}/settings", s.roomHandler(s.handleSettings))
	mux.HandleFunc("POST /room/{code}/topics/custom", s.roomHandler(s.handleCustomTopics))
	mux.HandleFunc("POST /room/{code}/topics/generate", s.roomHandler(s.handleGenerateTopics))
	mux.HandleFunc("POST /room/{code}/game/start", s.roomHandler(s.handleStartGame))
	mux.HandleFunc("POST /room/{code}/game/reset", s.roomHandler(s.handleReset))
	mux.HandleFunc("POST /room/{code}/turn/start", s.roomHandler(s.handleStartTurn))
	mux.HandleFunc("POST /room/{code}/turn/begin", s.roomHandler(s.handleBeginTurn))
	mux.HandleFunc("POST /room/{code}/turn/redraw", s.roomHandler(s.handleRedrawTurn))
	mux.HandleFunc("POST /room/{code}/turn/submit", s.roomHandler(s.handleSubmitTurn))
	mux.HandleFunc("POST /room/{code}/score/override", s.roomHandler(s.handleScoreOverride))
	mux.HandleFunc("POST /room/{code}/host/transfer", s.roomHandler(s.handleTransferHost))
	mux.HandleFunc("POST /room/{code}/host/claim", s.roomHandler(s.handleClaimHost))

	fileServer := http.FileServer(http.Dir("web/static"))
	mux.Handle("/static/", http.StripPrefix("/static/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		fileServer.ServeHTTP(w, r)
	})))

	return s.protect(mux)
}

// protect applies request hardening shared by every route: a body size cap
// and a same-origin check on state-changing requests.
func (s *Server) protect(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !sameOrigin(r) {
			http.Error(w, "cross-origin request rejected", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || origin == "null" {
		// Same-origin form posts from very old browsers omit Origin; nothing
		// sensitive is reachable without a room code plus a member token.
		return origin == ""
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return parsed.Host == r.Host
}

// ensureToken returns the browser's identity token, minting one if needed.
func (s *Server) ensureToken(w http.ResponseWriter, r *http.Request) string {
	if cookie, err := r.Cookie(tokenCookie); err == nil && len(cookie.Value) == 64 {
		return cookie.Value
	}
	token, err := room.NewToken()
	if err != nil {
		return ""
	}
	http.SetCookie(w, &http.Cookie{
		Name:     tokenCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int((30 * 24 * time.Hour).Seconds()),
	})
	return token
}

type roomRequest struct {
	room  *room.Room
	token string
}

func (rr roomRequest) isHost() bool {
	return rr.room.IsHost(rr.token)
}

func (rr roomRequest) playerID() string {
	id, _ := rr.room.MemberPlayerID(rr.token)
	return id
}

func (s *Server) roomHandler(fn func(http.ResponseWriter, *http.Request, roomRequest)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
		rm, err := s.rooms.Get(code)
		if err != nil {
			s.roomGone(w, r)
			return
		}
		token := s.ensureToken(w, r)
		// Any authenticated host request counts as presence for the
		// claim-host grace period.
		rm.HostSeen(token)
		fn(w, r, roomRequest{room: rm, token: token})
	}
}

// roomGone answers requests for missing rooms: htmx requests get a client
// redirect header, navigations get a plain redirect.
func (s *Server) roomGone(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("HX-Request") == "true" {
		w.Header().Set("HX-Redirect", "/?err=gone")
		w.WriteHeader(http.StatusOK)
		return
	}
	http.Redirect(w, r, "/?err=gone", http.StatusSeeOther)
}

// --- Landing, create, join ---

func (s *Server) handleLanding(w http.ResponseWriter, r *http.Request) {
	s.ensureToken(w, r)
	message := ""
	switch r.URL.Query().Get("err") {
	case "gone":
		message = "That room is no longer available."
	case "full":
		message = "That room is full."
	case "notfound":
		message = "No room with that code. Check the code and try again."
	case "busy":
		message = "Too many rooms right now. Try again in a moment."
	case "rate":
		message = "Slow down a little and try again."
	}
	s.renderTemplate(w, "landingPage", ViewData{Error: message})
}

func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.allow(clientKey(r), 10, time.Minute) {
		http.Redirect(w, r, "/?err=rate", http.StatusSeeOther)
		return
	}
	token := s.ensureToken(w, r)
	if token == "" {
		http.Error(w, "could not establish identity", http.StatusInternalServerError)
		return
	}
	rm, err := s.rooms.Create(token)
	if err != nil {
		http.Redirect(w, r, "/?err=busy", http.StatusSeeOther)
		return
	}
	rm.Do(func() {
		rm.Session.SetTopics(s.packs[0].Topics)
		hostName := strings.TrimSpace(r.FormValue("name"))
		if hostName != "" {
			player := rm.Session.AddPlayer(hostName)
			rm.BindMemberLocked(token, player.ID)
		}
	})
	http.Redirect(w, r, "/room/"+rm.Code, http.StatusSeeOther)
}

func (s *Server) handleJoinRoom(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.allow(clientKey(r), 20, time.Minute) {
		http.Redirect(w, r, "/?err=rate", http.StatusSeeOther)
		return
	}
	code := strings.ToUpper(strings.TrimSpace(r.FormValue("code")))
	rm, err := s.rooms.Get(code)
	if err != nil {
		http.Redirect(w, r, "/?err=notfound", http.StatusSeeOther)
		return
	}
	token := s.ensureToken(w, r)
	if token == "" {
		http.Error(w, "could not establish identity", http.StatusInternalServerError)
		return
	}

	// Reconnect: already seated in this room.
	if _, ok := rm.MemberPlayerID(token); ok || rm.IsHost(token) {
		http.Redirect(w, r, "/room/"+rm.Code, http.StatusSeeOther)
		return
	}

	full := false
	rm.Do(func() {
		if len(rm.Session.Players) >= room.MaxPlayersPerRoom {
			full = true
			return
		}
		player := rm.Session.AddPlayer(r.FormValue("name"))
		rm.BindMemberLocked(token, player.ID)
	})
	if full {
		http.Redirect(w, r, "/?err=full", http.StatusSeeOther)
		return
	}
	http.Redirect(w, r, "/room/"+rm.Code, http.StatusSeeOther)
}

// --- Room views ---

func (s *Server) handleRoomPage(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	s.renderRoomState(w, rr, "", true)
}

func (s *Server) handleRoomPartial(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	updates, unsubscribe := rr.room.Subscribe(rr.token)
	defer unsubscribe()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	writeEvent := func() bool {
		_, err := w.Write([]byte("event: update\ndata: " + strconv.FormatInt(rr.room.Version(), 10) + "\n\n"))
		if err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !writeEvent() {
		return
	}

	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-updates:
			if !writeEvent() {
				return
			}
		case <-heartbeat.C:
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// --- Roster ---

func (s *Server) handleAddPlayer(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !rr.isHost() {
		s.renderRoomState(w, rr, "Only the host can edit players.", false)
		return
	}
	message := ""
	rr.room.Do(func() {
		if len(rr.room.Session.Players) >= room.MaxPlayersPerRoom {
			message = "The room is full."
			return
		}
		rr.room.Session.AddPlayer(r.FormValue("name"))
	})
	s.renderRoomState(w, rr, message, false)
}

func (s *Server) handleRenamePlayer(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	id := r.FormValue("id")
	if !rr.isHost() && rr.playerID() != id {
		s.renderRoomState(w, rr, "You can only rename yourself.", false)
		return
	}
	rr.room.Do(func() {
		rr.room.Session.RenamePlayer(id, r.FormValue("name"))
	})
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleMovePlayer(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !rr.isHost() {
		s.renderRoomState(w, rr, "Only the host can reorder players.", false)
		return
	}
	rr.room.Do(func() {
		rr.room.Session.MovePlayer(r.FormValue("id"), parseInt(r.FormValue("offset"), 0))
	})
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleRemovePlayer(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	id := r.FormValue("id")
	if !rr.isHost() {
		s.renderRoomState(w, rr, "Only the host can remove players.", false)
		return
	}
	rr.room.Do(func() {
		rr.room.Session.RemovePlayer(id)
		rr.room.UnbindPlayerLocked(id)
	})
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleLeave(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	playerID := rr.playerID()
	rr.room.Do(func() {
		if playerID != "" {
			rr.room.Session.RemovePlayer(playerID)
		}
		rr.room.UnbindMemberLocked(rr.token)
	})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// --- Host migration ---

// handleTransferHost lets the current host hand control to a remote player.
func (s *Server) handleTransferHost(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !rr.isHost() {
		s.renderRoomState(w, rr, "Only the host can transfer hosting.", false)
		return
	}
	playerID := r.FormValue("playerID")
	token, ok := rr.room.TokenForPlayer(playerID)
	if !ok {
		s.renderRoomState(w, rr, "That player is not connected from their own device.", false)
		return
	}
	rr.room.TransferHostTo(token)
	s.renderRoomState(w, rr, "", false)
}

// handleClaimHost lets any seated member take over a room whose host has
// been gone past the grace period.
func (s *Server) handleClaimHost(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if rr.isHost() {
		s.renderRoomState(w, rr, "", false)
		return
	}
	if rr.playerID() == "" {
		s.renderRoomState(w, rr, "Join the room before claiming host.", false)
		return
	}
	if rr.room.HostOfflineFor() < s.hostClaimGrace {
		s.renderRoomState(w, rr, "The host is still here — ask them to hand over hosting instead.", false)
		return
	}
	rr.room.TransferHostTo(rr.token)
	s.renderRoomState(w, rr, "", false)
}

// --- Setup ---

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !rr.isHost() {
		s.renderRoomState(w, rr, "Only the host can change settings.", false)
		return
	}
	rr.room.Do(func() {
		session := rr.room.Session
		settings := game.Settings{
			SpeakingDurationSeconds: parseInt(r.FormValue("duration"), session.Settings.SpeakingDurationSeconds),
			SilenceTimeoutSeconds:   parseInt(r.FormValue("silence"), session.Settings.SilenceTimeoutSeconds),
			Rounds:                  parseInt(r.FormValue("rounds"), session.Settings.Rounds),
			TopicPackID:             r.FormValue("topicPack"),
			AIJudgeEnabled:          r.FormValue("aiJudge") == "on",
		}
		session.UpdateSettings(settings)
		if pack, ok := topics.FindPack(settings.TopicPackID); ok {
			session.SetTopics(pack.Topics)
		}
	})
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleCustomTopics(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !rr.isHost() {
		s.renderRoomState(w, rr, "Only the host can change topics.", false)
		return
	}
	raw := strings.ReplaceAll(r.FormValue("topics"), "\r\n", "\n")
	lines := strings.Split(raw, "\n")
	rr.room.Do(func() {
		session := rr.room.Session
		session.SetTopics(lines)
		settings := session.Settings
		settings.TopicPackID = "custom"
		session.UpdateSettings(settings)
	})
	s.renderRoomState(w, rr, "", false)
}

// handleGenerateTopics builds a topic list from a host-supplied theme. Only
// the theme text reaches the AI provider.
func (s *Server) handleGenerateTopics(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !rr.isHost() {
		s.renderRoomState(w, rr, "Only the host can generate topics.", false)
		return
	}
	if !s.limiter.allow("topics:"+clientKey(r), 6, time.Minute) {
		s.renderRoomState(w, rr, "Slow down a little before generating more topics.", false)
		return
	}
	theme := strings.TrimSpace(r.FormValue("theme"))
	if runes := []rune(theme); len(runes) > 100 {
		theme = string(runes[:100])
	}
	if theme == "" {
		s.renderRoomState(w, rr, "Describe a theme to generate topics.", false)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), judgeTimeout)
	defer cancel()
	generated, err := s.generator.GenerateTopics(ctx, theme)
	if err != nil {
		s.renderRoomState(w, rr, "Could not generate topics right now — try again or write your own.", false)
		return
	}
	rr.room.Do(func() {
		session := rr.room.Session
		session.SetTopics(generated)
		settings := session.Settings
		settings.TopicPackID = "custom"
		session.UpdateSettings(settings)
	})
	s.renderRoomState(w, rr, "", false)
}

// --- Game flow ---

func (s *Server) handleStartGame(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !rr.isHost() {
		s.renderRoomState(w, rr, "Only the host can start the game.", false)
		return
	}
	var startErr error
	rr.room.Do(func() {
		if startErr = rr.room.Session.Start(); startErr != nil {
			return
		}
		_, startErr = rr.room.Session.StartTurn()
	})
	rr.room.ClearTurnClock()
	if startErr != nil {
		s.renderRoomState(w, rr, startErr.Error(), false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleReset(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !rr.isHost() {
		s.renderRoomState(w, rr, "Only the host can reset the game.", false)
		return
	}
	rr.room.Do(func() {
		rr.room.Session.ResetForNewGame()
	})
	rr.room.ClearTurnClock()
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleStartTurn(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	playerID := rr.playerID()
	isHost := rr.isHost()
	var turnErr error
	allowed := true
	rr.room.Do(func() {
		session := rr.room.Session
		if !isHost {
			next := ""
			if session.CurrentPlayer >= 0 && session.CurrentPlayer < len(session.Players) {
				next = session.Players[session.CurrentPlayer].ID
			}
			if playerID == "" || playerID != next {
				allowed = false
				return
			}
		}
		_, turnErr = session.StartTurn()
	})
	if !allowed {
		s.renderRoomState(w, rr, "Waiting for the host or the next player to start the turn.", false)
		return
	}
	rr.room.ClearTurnClock()
	if turnErr != nil {
		s.renderRoomState(w, rr, turnErr.Error(), false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

// handleBeginTurn starts the server-side clock when the speaker actually
// begins talking. Scoring uses this clock, not the client's claims.
func (s *Server) handleBeginTurn(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !s.canDriveTurn(rr) {
		s.renderRoomState(w, rr, "Only the host or the current speaker can run the turn.", false)
		return
	}
	rr.room.BeginTurn()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRedrawTurn(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !s.canDriveTurn(rr) {
		s.renderRoomState(w, rr, "Only the host or the current speaker can redraw the topic.", false)
		return
	}
	var redrawErr error
	rr.room.Do(func() {
		_, redrawErr = rr.room.Session.RedrawActiveTurn()
	})
	if redrawErr != nil {
		s.renderRoomState(w, rr, redrawErr.Error(), false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleSubmitTurn(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !s.canDriveTurn(rr) {
		s.renderRoomState(w, rr, "Only the host or the current speaker can end the turn.", false)
		return
	}
	elapsed := rr.room.EndTurnClock()
	// A negative claim means "use the server clock" (host override buttons
	// for turns running on another device).
	claimedSpoken := parseInt(r.FormValue("spokenSeconds"), -1)
	if claimedSpoken < 0 {
		claimedSpoken = 0
		if elapsed > 0 {
			claimedSpoken = elapsed
		}
	}
	claimedCompleted := r.FormValue("completed") == "true"
	eliminated := r.FormValue("eliminated") == "true"
	transcript := strings.TrimSpace(r.FormValue("transcript"))
	if len(transcript) > maxTranscriptBytes {
		transcript = transcript[:maxTranscriptBytes]
	}

	var submitErr error
	gradeIndex := -1
	var gradedTurn game.Turn
	isHost := rr.isHost()
	rr.room.Do(func() {
		session := rr.room.Session
		spoken := claimedSpoken
		completed := claimedCompleted
		if !isHost {
			// Server-authoritative: remote speakers cannot claim more time
			// than the server clock observed.
			observed := 0
			if elapsed >= 0 {
				observed = elapsed + 1 // int truncation grace
			}
			if spoken > observed {
				spoken = observed
			}
			if completed && session.ActiveTurn != nil &&
				elapsed+completionGraceSeconds < session.ActiveTurn.Duration {
				completed = false
			}
		}
		var turn game.Turn
		turn, submitErr = session.SubmitTurn(spoken, completed, eliminated)
		if submitErr != nil || !session.Settings.AIJudgeEnabled {
			return
		}
		index := session.MarkTurnAIPending()
		if transcript == "" {
			session.ResolveTurnAI(index, turn.PlayerID, turn.Topic, nil,
				"No transcript was captured, so there is no relevance bonus.", game.AIStatusSkipped)
			return
		}
		gradeIndex = index
		gradedTurn = turn
	})
	if submitErr != nil {
		s.renderRoomState(w, rr, submitErr.Error(), false)
		return
	}
	if gradeIndex >= 0 {
		go s.gradeTurn(rr.room, gradeIndex, gradedTurn, transcript)
	}
	s.renderRoomState(w, rr, "", false)
}

// gradeTurn asks the judge for a verdict off the request path; the result is
// applied under the room lock and broadcast to every connected screen.
func (s *Server) gradeTurn(rm *room.Room, index int, turn game.Turn, transcript string) {
	ctx, cancel := context.WithTimeout(context.Background(), judgeTimeout)
	defer cancel()
	verdict, err := s.judge.Grade(ctx, turn.Topic, transcript)
	rm.Do(func() {
		if err != nil {
			rm.Session.ResolveTurnAI(index, turn.PlayerID, turn.Topic, nil,
				"The judge could not review this turn, so scoring stays classic.", game.AIStatusFailed)
			return
		}
		relevance := verdict.Relevance
		rm.Session.ResolveTurnAI(index, turn.PlayerID, turn.Topic, &relevance, verdict.Feedback, game.AIStatusDone)
	})
}

func (s *Server) handleScoreOverride(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !rr.isHost() {
		s.renderRoomState(w, rr, "Only the host can adjust scores.", false)
		return
	}
	rr.room.Do(func() {
		rr.room.Session.OverrideScore(r.FormValue("playerID"), parseInt(r.FormValue("delta"), 0))
	})
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) canDriveTurn(rr roomRequest) bool {
	if rr.isHost() {
		return true
	}
	playerID := rr.playerID()
	if playerID == "" {
		return false
	}
	actor := ""
	rr.room.View(func() {
		if turn := rr.room.Session.ActiveTurn; turn != nil {
			actor = turn.PlayerID
		}
	})
	return actor == playerID
}

// --- Rendering ---

var stateTemplates = map[string][2]string{
	"setup":  {"setupPage", "setup"},
	"play":   {"playPage", "play"},
	"score":  {"scorePage", "score"},
	"winner": {"winnerPage", "winner"},
}

func (s *Server) renderRoomState(w http.ResponseWriter, rr roomRequest, message string, fullPage bool) {
	online := rr.room.OnlinePlayers()
	bound := rr.room.BoundPlayers()
	turnRunning := rr.room.TurnRunning()
	elapsed := rr.room.TurnElapsedSeconds()
	playerID := rr.playerID()
	hostPlayerID := rr.room.HostPlayerID()
	isHost := rr.isHost()
	canClaimHost := !isHost && playerID != "" &&
		rr.room.HostOfflineFor() >= s.hostClaimGrace

	var buf bytes.Buffer
	var renderErr error
	rr.room.View(func() {
		session := rr.room.Session
		data := ViewData{
			Code:         rr.room.Code,
			Base:         "/room/" + rr.room.Code,
			IsHost:       isHost,
			YouID:        playerID,
			TurnRunning:  turnRunning,
			Online:       online,
			Bound:        bound,
			HostPlayerID: hostPlayerID,
			CanClaimHost: canClaimHost,
			Session:      session,
			Packs:        s.packs,
			Selected:     selectedPack(session),
			Error:        message,
			Standings:    session.Standings(),
		}

		state := "setup"
		switch {
		case session.ActiveTurn != nil:
			state = "play"
			data.CurrentTurn = session.ActiveTurn
			data.IsActor = playerID != "" && session.ActiveTurn.PlayerID == playerID
			data.ActorIsRemote = bound[session.ActiveTurn.PlayerID]
			if turnRunning && elapsed >= 0 {
				remaining := session.ActiveTurn.Duration - elapsed
				if remaining < 0 {
					remaining = 0
				}
				data.Remaining = remaining
			} else {
				data.Remaining = session.ActiveTurn.Duration
			}
		case session.Finished:
			state = "winner"
		case session.Started && len(session.CompletedTurns) > 0:
			state = "score"
			data.LastTurn = lastTurn(session)
		}
		if state == "score" && playerID != "" &&
			session.CurrentPlayer >= 0 && session.CurrentPlayer < len(session.Players) {
			data.IsNextUp = session.Players[session.CurrentPlayer].ID == playerID
		}

		names := stateTemplates[state]
		name := names[1]
		if fullPage {
			name = names[0]
		}
		renderErr = s.template.ExecuteTemplate(&buf, name, data)
	})
	if renderErr != nil {
		http.Error(w, renderErr.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(buf.Bytes())
}

func (s *Server) renderTemplate(w http.ResponseWriter, name string, data ViewData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := s.template.ExecuteTemplate(w, name, data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func selectedPack(session *game.Session) topics.Pack {
	if pack, ok := topics.FindPack(session.Settings.TopicPackID); ok {
		return pack
	}
	return topics.Pack{ID: "custom", Name: "Custom", Description: "Your custom list"}
}

func parseInt(value string, fallback int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return fallback
	}
	return parsed
}

func lastTurn(session *game.Session) *game.Turn {
	if len(session.CompletedTurns) == 0 {
		return nil
	}
	turn := session.CompletedTurns[len(session.CompletedTurns)-1]
	return &turn
}

func clientKey(r *http.Request) string {
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	return host
}

// --- Rate limiting ---

type rateLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{hits: map[string][]time.Time{}}
}

func (l *rateLimiter) allow(key string, limit int, window time.Duration) bool {
	now := time.Now()
	cutoff := now.Add(-window)
	l.mu.Lock()
	defer l.mu.Unlock()
	kept := l.hits[key][:0]
	for _, hit := range l.hits[key] {
		if hit.After(cutoff) {
			kept = append(kept, hit)
		}
	}
	if len(kept) >= limit {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, now)
	if len(l.hits) > 10000 {
		// Hard cap on tracked clients; drop everything rather than grow.
		l.hits = map[string][]time.Time{key: l.hits[key]}
	}
	return true
}
