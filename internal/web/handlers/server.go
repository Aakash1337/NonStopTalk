package handlers

import (
	"bytes"
	"context"
	"errors"
	"html/template"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Aakash1337/NonStopTalk/internal/game"
	"github.com/Aakash1337/NonStopTalk/internal/judge"
	"github.com/Aakash1337/NonStopTalk/internal/room"
	"github.com/Aakash1337/NonStopTalk/internal/topics"
)

const (
	tokenCookie       = "nonstoptalk_token"
	legacyTokenCookie = "dst_token"
	maxRequestBody    = 64 << 10 // 64 KiB

	// completionGraceSeconds forgives clock skew between the browser timer
	// and the server turn clock when awarding the completion bonus.
	completionGraceSeconds = 2

	// maxTranscriptBytes caps the browser-supplied transcript sent to the
	// judge; a 5-minute turn is well under this.
	maxTranscriptBytes      = 8 << 10
	judgeTimeout            = 30 * time.Second
	maxProviderCalls        = 4
	maxLiveEventStreams     = 256
	maxProviderCallsPerHour = 30
	maxProviderCallsPerDay  = 120
)

type Server struct {
	rooms            *room.Manager
	packs            []topics.Pack
	template         *template.Template
	static           http.FileSystem
	limiter          *rateLimiter
	judge            judge.Provider
	generator        judge.TopicGenerator
	externalProvider bool
	// providerSlots prevents a burst of rooms from creating unbounded paid
	// provider calls. A full slot set fails closed to classic scoring.
	providerSlots chan struct{}
	// eventSlots bounds process-wide long-lived SSE connections in addition
	// to each room's and member's limits.
	eventSlots chan struct{}
	// trustCloudflareIP enables CF-Connecting-IP only when an operator has
	// explicitly placed the Go server behind a trusted Cloudflare proxy.
	trustCloudflareIP bool
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
	Code    string
	Base    string
	IsHost  bool
	YouID   string
	IsActor bool
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
	CanClaimHost    bool
	HostClaimWaitMS int64

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
	tmpl, err := template.New("app").Funcs(templateFunctions()).ParseGlob(templatePattern)
	if err != nil {
		return nil, err
	}
	return newServer(tmpl, http.Dir("web/static")), nil
}

// NewServerFromFS builds a server from a filesystem containing the repository
// asset paths. Production binaries use an embedded filesystem so templates and
// static files remain available regardless of the process working directory.
func NewServerFromFS(assets fs.FS) (*Server, error) {
	tmpl, err := template.New("app").Funcs(templateFunctions()).ParseFS(assets, "internal/web/templates/*.html")
	if err != nil {
		return nil, err
	}
	staticFiles, err := fs.Sub(assets, "web/static")
	if err != nil {
		return nil, err
	}
	return newServer(tmpl, http.FS(staticFiles)), nil
}

func templateFunctions() template.FuncMap {
	return template.FuncMap{
		"joinLines": func(lines []string) string { return strings.Join(lines, "\n") },
		"fmtTime":   func(t time.Time) string { return t.Format("Jan 2, 15:04") },
		"reverseHistory": func(records []game.GameRecord) []game.GameRecord {
			reversed := make([]game.GameRecord, len(records))
			for i, record := range records {
				reversed[len(records)-1-i] = record
			}
			return reversed
		},
	}
}

func newServer(tmpl *template.Template, staticFiles http.FileSystem) *Server {
	// The Claude judge and topic generator are used when credentials are
	// configured; otherwise transparent offline fallbacks keep both features
	// playable and testable.
	var relevanceJudge judge.Provider = judge.Heuristic{}
	var generator judge.TopicGenerator = judge.Heuristic{}
	externalProvider := false
	if os.Getenv("ANTHROPIC_API_KEY") != "" {
		claude := judge.NewAnthropic()
		relevanceJudge = claude
		generator = claude
		externalProvider = true
	}
	return &Server{
		rooms:             room.NewManager(),
		packs:             topics.PresetPacks(),
		template:          tmpl,
		static:            staticFiles,
		limiter:           newRateLimiter(),
		judge:             relevanceJudge,
		generator:         generator,
		externalProvider:  externalProvider,
		providerSlots:     make(chan struct{}, maxProviderCalls),
		eventSlots:        make(chan struct{}, maxLiveEventStreams),
		trustCloudflareIP: strings.EqualFold(os.Getenv("NONSTOPTALK_TRUST_CLOUDFLARE_IP"), "true"),
		hostClaimGrace:    30 * time.Second,
	}
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
	mux.HandleFunc("POST /room/{code}/presets/apply", s.roomHandler(s.handleApplyPreset))

	fileServer := http.FileServer(s.static)
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
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			var err error
			if strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "multipart/form-data") {
				err = r.ParseMultipartForm(maxRequestBody)
				if r.MultipartForm != nil {
					defer r.MultipartForm.RemoveAll()
				}
			} else {
				err = r.ParseForm()
			}
			if err != nil {
				var tooLarge *http.MaxBytesError
				if errors.As(err, &tooLarge) {
					http.Error(w, "request body is too large", http.StatusRequestEntityTooLarge)
				} else {
					http.Error(w, "could not read form data", http.StatusBadRequest)
				}
				return
			}
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
	if cookie, err := r.Cookie(tokenCookie); err == nil && validToken(cookie.Value) {
		return cookie.Value
	}
	if cookie, err := r.Cookie(legacyTokenCookie); err == nil && validToken(cookie.Value) {
		setTokenCookie(w, r, cookie.Value)
		return cookie.Value
	}
	token, err := room.NewToken()
	if err != nil {
		return ""
	}
	setTokenCookie(w, r, token)
	return token
}

func setTokenCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     tokenCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int((30 * 24 * time.Hour).Seconds()),
	})
}

func validToken(token string) bool {
	if len(token) != 64 {
		return false
	}
	for _, char := range token {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
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
	case "started":
		message = "That game has already started. Ask the host to reset it before joining."
	}
	s.renderTemplate(w, "landingPage", ViewData{Error: message})
}

func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.allow(s.clientKey(r), 10, time.Minute) {
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
	if !s.limiter.allow(s.clientKey(r), 20, time.Minute) {
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

	joinError := ""
	joined := rm.DoAuthorized(token, func(_ bool, _ string, session *game.Session) bool {
		if session.Started {
			joinError = "started"
			return false
		}
		if len(session.Players) >= room.MaxPlayersPerRoom {
			joinError = "full"
			return false
		}
		return true
	}, func() {
		player := rm.Session.AddPlayer(r.FormValue("name"))
		rm.BindMemberLocked(token, player.ID)
	})
	if !joined {
		if joinError == "" {
			joinError = "started"
		}
		http.Redirect(w, r, "/?err="+joinError, http.StatusSeeOther)
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
	select {
	case s.eventSlots <- struct{}{}:
		defer func() { <-s.eventSlots }()
	default:
		http.Error(w, "the server has too many live connections; try again shortly", http.StatusServiceUnavailable)
		return
	}
	updates, unsubscribe, err := rr.room.Subscribe(rr.token)
	if err != nil {
		status := http.StatusServiceUnavailable
		message := "this room has too many live connections; close an extra tab and try again"
		if errors.Is(err, room.ErrNotRoomMember) {
			status = http.StatusForbidden
			message = "join this room before opening live updates"
		}
		http.Error(w, message, status)
		return
	}
	defer unsubscribe()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	writeEvent := func(event, data string) bool {
		_, err := w.Write([]byte("event: " + event + "\ndata: " + data + "\n\n"))
		if err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !writeEvent("update", strconv.FormatInt(rr.room.Version(), 10)) {
		return
	}

	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	idleCheck := time.NewTicker(time.Minute)
	defer idleCheck.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-rr.room.Done():
			writeEvent("gone", "room expired")
			return
		case <-updates:
			if !writeEvent("update", strconv.FormatInt(rr.room.Version(), 10)) {
				return
			}
		case <-idleCheck.C:
			if s.rooms.ExpireIfIdle(rr.room.Code) {
				writeEvent("gone", "room expired")
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
	message := ""
	allowed := rr.room.DoAsHostInSetup(rr.token, func() {
		if len(rr.room.Session.Players) >= room.MaxPlayersPerRoom {
			message = "The room is full."
			return
		}
		rr.room.Session.AddPlayer(r.FormValue("name"))
	})
	if !allowed {
		s.renderRoomState(w, rr, "Only the host can add players before the game starts.", false)
		return
	}
	s.renderRoomState(w, rr, message, false)
}

func (s *Server) handleRenamePlayer(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	id := r.FormValue("id")
	allowed := rr.room.DoAuthorized(rr.token, func(isHost bool, playerID string, session *game.Session) bool {
		return !session.Started && (isHost || (playerID != "" && playerID == id))
	}, func() {
		rr.room.Session.RenamePlayer(id, r.FormValue("name"))
	})
	if !allowed {
		s.renderRoomState(w, rr, "Players can only be renamed before the game starts, by themselves or the host.", false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleMovePlayer(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !rr.room.DoAsHostInSetup(rr.token, func() {
		rr.room.Session.MovePlayer(r.FormValue("id"), parseInt(r.FormValue("offset"), 0))
	}) {
		s.renderRoomState(w, rr, "Only the host can reorder players before the game starts.", false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleRemovePlayer(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	id := r.FormValue("id")
	if !rr.room.DoAsHostInSetup(rr.token, func() {
		rr.room.Session.RemovePlayer(id)
		rr.room.UnbindPlayerLocked(id)
	}) {
		s.renderRoomState(w, rr, "Only the host can remove players before the game starts.", false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleLeave(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	playerID := rr.playerID()
	left := rr.room.DoAuthorized(rr.token, func(_ bool, currentPlayerID string, session *game.Session) bool {
		return !session.Started && playerID != "" && currentPlayerID == playerID
	}, func() {
		rr.room.Session.RemovePlayer(playerID)
		rr.room.UnbindMemberLocked(rr.token)
	})
	if !left {
		s.renderRoomState(w, rr, "Players can only leave before the game starts.", true)
		return
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

// --- Host migration ---

// handleTransferHost lets the current host hand control to a remote player.
func (s *Server) handleTransferHost(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	playerID := r.FormValue("playerID")
	if !rr.room.TransferHostByPlayer(rr.token, playerID) {
		message := "Only the host can transfer hosting."
		if rr.isHost() {
			message = "That player is not connected from their own device."
		}
		s.renderRoomState(w, rr, message, false)
		return
	}
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
	if !rr.room.ClaimHost(rr.token, s.hostClaimGrace) {
		s.renderRoomState(w, rr, "The host is still here — ask them to hand over hosting instead.", false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

// --- Setup ---

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !rr.room.DoAsHostInSetup(rr.token, func() {
		rr.room.InvalidateTopicGenerationLocked()
		session := rr.room.Session
		settings := game.Settings{
			SpeakingDurationSeconds: parseInt(r.FormValue("duration"), session.Settings.SpeakingDurationSeconds),
			SilenceTimeoutSeconds:   parseInt(r.FormValue("silence"), session.Settings.SilenceTimeoutSeconds),
			Rounds:                  parseInt(r.FormValue("rounds"), session.Settings.Rounds),
			TopicPackID:             r.FormValue("topicPack"),
			AIJudgeEnabled:          r.FormValue("aiJudge") == "on",
		}
		session.UpdateSettings(settings)
		if pack, ok := topics.FindPack(session.Settings.TopicPackID); ok {
			session.SetTopics(pack.Topics)
		}
	}) {
		s.renderRoomState(w, rr, "Only the host can change settings before the game starts.", false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleCustomTopics(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	raw := strings.ReplaceAll(r.FormValue("topics"), "\r\n", "\n")
	lines := strings.Split(raw, "\n")
	if !rr.room.DoAsHostInSetup(rr.token, func() {
		rr.room.InvalidateTopicGenerationLocked()
		session := rr.room.Session
		session.SetTopics(lines)
		settings := session.Settings
		settings.TopicPackID = "custom"
		session.UpdateSettings(settings)
	}) {
		s.renderRoomState(w, rr, "Only the host can change topics before the game starts.", false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

// handleGenerateTopics builds a topic list from a host-supplied theme. Only
// the theme text reaches the AI provider.
func (s *Server) handleGenerateTopics(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !s.limiter.allow("topics-ip:"+s.clientKey(r), 12, time.Minute) ||
		!s.limiter.allow("topics-token:"+rr.token, 6, time.Minute) {
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
	select {
	case s.providerSlots <- struct{}{}:
		defer func() { <-s.providerSlots }()
	default:
		s.renderRoomState(w, rr, "Topic generation is busy right now — try again in a moment.", false)
		return
	}
	generation, authorized := rr.room.BeginTopicGeneration(rr.token)
	if !authorized {
		s.renderRoomState(w, rr, "Only the host can generate topics before the game starts.", false)
		return
	}
	if !s.allowProviderCall() {
		s.renderRoomState(w, rr, "The server's AI request budget is used up; write topics manually or try again later.", false)
		return
	}
	generated, err := s.generator.GenerateTopics(ctx, theme)
	if err != nil {
		s.renderRoomState(w, rr, "Could not generate topics right now — try again or write your own.", false)
		return
	}
	if !rr.room.ApplyTopicGeneration(rr.token, generation, func() {
		session := rr.room.Session
		session.SetTopics(generated)
		settings := session.Settings
		settings.TopicPackID = "custom"
		session.UpdateSettings(settings)
	}) {
		s.renderRoomState(w, rr, "The game started or a newer host or topic request won, so this older result was ignored.", false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

// handleApplyPreset applies settings and topics in one request. Presets are
// stored on the host's device; this endpoint just installs one atomically.
func (s *Server) handleApplyPreset(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	packID := r.FormValue("topicPack")
	raw := strings.ReplaceAll(r.FormValue("topics"), "\r\n", "\n")
	customTopics := strings.Split(raw, "\n")

	if !rr.room.DoAsHostInSetup(rr.token, func() {
		rr.room.InvalidateTopicGenerationLocked()
		session := rr.room.Session
		settings := game.Settings{
			SpeakingDurationSeconds: parseInt(r.FormValue("duration"), session.Settings.SpeakingDurationSeconds),
			SilenceTimeoutSeconds:   parseInt(r.FormValue("silence"), session.Settings.SilenceTimeoutSeconds),
			Rounds:                  parseInt(r.FormValue("rounds"), session.Settings.Rounds),
			TopicPackID:             packID,
			AIJudgeEnabled:          r.FormValue("aiJudge") == "on",
		}
		session.UpdateSettings(settings)
		if pack, ok := topics.FindPack(session.Settings.TopicPackID); ok {
			session.SetTopics(pack.Topics)
		} else if strings.TrimSpace(raw) != "" {
			session.SetTopics(customTopics)
		}
	}) {
		s.renderRoomState(w, rr, "Only the host can apply presets before the game starts.", false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

// --- Game flow ---

func (s *Server) handleStartGame(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	var startErr error
	allowed := rr.room.DoAsHost(rr.token, func() {
		if rr.room.Session.Started {
			return // an immediate duplicate is an idempotent refresh
		}
		rr.room.InvalidateTopicGenerationLocked()
		if startErr = rr.room.Session.Start(); startErr != nil {
			return
		}
		_, startErr = rr.room.StartTurnLocked()
	})
	if !allowed {
		s.renderRoomState(w, rr, "Only the host can start the game.", false)
		return
	}
	if startErr != nil {
		s.renderRoomState(w, rr, startErr.Error(), false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleReset(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !rr.room.DoAuthorized(rr.token, func(isHost bool, _ string, session *game.Session) bool {
		return isHost && (!session.Started || session.Finished)
	}, func() {
		rr.room.InvalidateTopicGenerationLocked()
		rr.room.Session.ResetForNewGame()
		rr.room.ClearTurnClockLocked()
	}) {
		s.renderRoomState(w, rr, "Only the host can reset setup or a finished game.", false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleStartTurn(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	afterTurnID := strings.TrimSpace(r.FormValue("afterTurnID"))
	var turnErr error
	allowed := rr.room.DoAuthorized(rr.token, func(isHost bool, playerID string, session *game.Session) bool {
		if !isHost {
			next := ""
			if session.CurrentPlayer >= 0 && session.CurrentPlayer < len(session.Players) {
				next = session.Players[session.CurrentPlayer].ID
			}
			if playerID == "" || playerID != next {
				return false
			}
		}
		return true
	}, func() {
		session := rr.room.Session
		if !session.Started || session.Finished {
			turnErr = errors.New("the game is not waiting for another turn")
			return
		}
		if session.ActiveTurn != nil {
			return // retry while the same next turn is active
		}
		if len(session.CompletedTurns) > 0 {
			latest := session.CompletedTurns[len(session.CompletedTurns)-1]
			if afterTurnID == "" || afterTurnID != latest.ID {
				turnErr = errors.New("that next-turn request is stale")
				return
			}
		}
		_, turnErr = rr.room.StartTurnLocked()
	})
	if !allowed {
		s.renderRoomState(w, rr, "Waiting for the host or the next player to start the turn.", false)
		return
	}
	if turnErr != nil {
		s.renderRoomState(w, rr, turnErr.Error(), false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

// handleBeginTurn starts the server-side clock when the speaker actually
// begins talking. Scoring uses this clock, not the client's claims.
func (s *Server) handleBeginTurn(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	turnID := strings.TrimSpace(r.FormValue("turnID"))
	allowed := rr.room.DoAuthorized(rr.token, func(isHost bool, playerID string, session *game.Session) bool {
		turn := session.ActiveTurn
		return turnID != "" && turn != nil && turn.ID == turnID &&
			(isHost || (playerID != "" && turn.PlayerID == playerID))
	}, func() {
		rr.room.BeginTurnLocked()
	})
	if !allowed {
		s.renderRoomState(w, rr, "Only the host or the current speaker can run the turn.", false)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRedrawTurn(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	turnID := strings.TrimSpace(r.FormValue("turnID"))
	var redrawErr error
	allowed := rr.room.DoAuthorized(rr.token, func(isHost bool, playerID string, session *game.Session) bool {
		turn := session.ActiveTurn
		return turnID != "" && turn != nil && turn.ID == turnID &&
			(isHost || (playerID != "" && turn.PlayerID == playerID))
	}, func() {
		if rr.room.Session.ActiveTurn == nil || rr.room.Session.ActiveTurn.ID != turnID {
			redrawErr = errors.New("that turn has already ended")
			return
		}
		_, redrawErr = rr.room.RedrawActiveTurnLocked()
	})
	if !allowed {
		s.renderRoomState(w, rr, "Only the host or the current speaker can redraw the current topic.", false)
		return
	}
	if redrawErr != nil {
		s.renderRoomState(w, rr, redrawErr.Error(), false)
		return
	}
	s.renderRoomState(w, rr, "", false)
}

func (s *Server) handleSubmitTurn(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	turnID := strings.TrimSpace(r.FormValue("turnID"))
	claimedSpoken := parseInt(r.FormValue("spokenSeconds"), -1)
	claimedCompleted := r.FormValue("completed") == "true"
	eliminated := r.FormValue("eliminated") == "true"
	transcript := truncateUTF8Bytes(strings.TrimSpace(r.FormValue("transcript")), maxTranscriptBytes)

	var submitErr error
	gradeIndex := -1
	var gradedTurn game.Turn
	callerIsHost := false
	allowed := rr.room.DoAuthorized(rr.token, func(isHost bool, playerID string, session *game.Session) bool {
		turn := session.ActiveTurn
		callerIsHost = isHost
		return turnID != "" && turn != nil && turn.ID == turnID &&
			(isHost || (playerID != "" && turn.PlayerID == playerID))
	}, func() {
		session := rr.room.Session
		elapsed := rr.room.EndTurnClockLocked()
		spoken := claimedSpoken
		// A negative claim means "use the server clock" (host override
		// controls for turns running on another device).
		if spoken < 0 {
			spoken = 0
			if elapsed > 0 {
				spoken = elapsed
			}
		}
		completed := claimedCompleted
		if !callerIsHost {
			spoken, completed = normalizeRemoteTurnClaim(
				spoken, completed, elapsed, session.ActiveTurn.Duration,
			)
		}
		if eliminated {
			completed = false
		}
		var turn game.Turn
		turn, submitErr = session.SubmitTurn(spoken, completed, eliminated)
		if submitErr != nil || !session.Settings.AIJudgeEnabled {
			return
		}
		index := session.MarkTurnAIPending()
		if transcript == "" {
			session.ResolveTurnAI(index, turn.ID, nil, nil,
				"No transcript was captured, so there is no relevance bonus.", game.AIStatusSkipped)
			return
		}
		if !s.limiter.allow("judge-ip:"+s.clientKey(r), 60, time.Hour) ||
			!s.limiter.allow("judge-token:"+rr.token, 30, time.Hour) {
			session.ResolveTurnAI(index, turn.ID, nil, nil,
				"The AI review limit was reached, so scoring stays classic.", game.AIStatusSkipped)
			return
		}
		if !s.allowProviderCall() {
			session.ResolveTurnAI(index, turn.ID, nil, nil,
				"The server's AI request budget was reached, so scoring stays classic.", game.AIStatusSkipped)
			return
		}
		gradeIndex = index
		gradedTurn = turn
	})
	if !allowed {
		s.renderRoomState(w, rr, "Only the host or the current speaker can end the current turn.", false)
		return
	}
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
	select {
	case s.providerSlots <- struct{}{}:
		defer func() { <-s.providerSlots }()
	default:
		rm.Do(func() {
			rm.Session.ResolveTurnAI(index, turn.ID, nil, nil,
				"The AI judge was busy, so scoring stays classic.", game.AIStatusFailed)
		})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), judgeTimeout)
	defer cancel()
	verdict, err := s.judge.Grade(ctx, turn.Topic, transcript)
	rm.Do(func() {
		if err != nil {
			rm.Session.ResolveTurnAI(index, turn.ID, nil, nil,
				"The judge could not review this turn, so scoring stays classic.", game.AIStatusFailed)
			return
		}
		relevance := verdict.Relevance
		confidence := verdict.Confidence
		rm.Session.ResolveTurnAI(index, turn.ID, &relevance, &confidence, verdict.Feedback, game.AIStatusDone)
	})
}

func (s *Server) handleScoreOverride(w http.ResponseWriter, r *http.Request, rr roomRequest) {
	if !rr.room.DoAsHost(rr.token, func() {
		rr.room.Session.OverrideScore(r.FormValue("playerID"), parseInt(r.FormValue("delta"), 0))
	}) {
		s.renderRoomState(w, rr, "Only the host can adjust scores.", false)
		return
	}
	s.renderRoomState(w, rr, "", false)
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
	hostOfflineFor := rr.room.HostOfflineFor()
	canClaimHost := !isHost && playerID != "" && hostOfflineFor >= s.hostClaimGrace
	hostClaimWaitMS := int64(0)
	if !isHost && playerID != "" && !canClaimHost {
		remaining := s.hostClaimGrace - hostOfflineFor
		if remaining > 0 {
			hostClaimWaitMS = remaining.Milliseconds()
		}
	}

	var buf bytes.Buffer
	var renderErr error
	rr.room.View(func() {
		session := rr.room.Session
		data := ViewData{
			Code:            rr.room.Code,
			Base:            "/room/" + rr.room.Code,
			IsHost:          isHost,
			YouID:           playerID,
			TurnRunning:     turnRunning,
			Online:          online,
			Bound:           bound,
			HostPlayerID:    hostPlayerID,
			CanClaimHost:    canClaimHost,
			HostClaimWaitMS: hostClaimWaitMS,
			Session:         session,
			Packs:           s.packs,
			Selected:        selectedPack(session),
			Error:           message,
			Standings:       session.Standings(),
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

func normalizeRemoteTurnClaim(claimed int, wantsCompleted bool, elapsed, duration int) (int, bool) {
	observed := 0
	if elapsed >= 0 {
		observed = elapsed + 1 // whole-second truncation tolerance
		if observed > duration {
			observed = duration
		}
	}
	if claimed < 0 {
		claimed = 0
	}
	if claimed > observed {
		claimed = observed
	}
	completed := wantsCompleted && elapsed >= 0 && elapsed+completionGraceSeconds >= duration
	if completed {
		// Accepting the browser's full-time signal within the clock-skew grace
		// also accepts the full duration, keeping the completion flag and bonus
		// internally consistent.
		claimed = duration
	}
	return claimed, completed
}

func truncateUTF8Bytes(value string, limit int) string {
	value = strings.ToValidUTF8(value, "")
	if limit < 1 {
		return ""
	}
	if len(value) <= limit {
		return value
	}
	value = value[:limit]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}

func lastTurn(session *game.Session) *game.Turn {
	if len(session.CompletedTurns) == 0 {
		return nil
	}
	turn := session.CompletedTurns[len(session.CompletedTurns)-1]
	return &turn
}

func (s *Server) clientKey(r *http.Request) string {
	if s.trustCloudflareIP {
		if connectingIP := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); net.ParseIP(connectingIP) != nil {
			return connectingIP
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

// allowProviderCall is a process-wide spend ceiling that cannot be bypassed by
// rotating browser cookies or spoofing client-IP headers. Operators who do not
// configure ANTHROPIC_API_KEY use the free offline provider regardless.
func (s *Server) allowProviderCall() bool {
	if !s.externalProvider {
		return true
	}
	return s.limiter.allow("provider-global-hour", maxProviderCallsPerHour, time.Hour) &&
		s.limiter.allow("provider-global-day", maxProviderCallsPerDay, 24*time.Hour)
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
