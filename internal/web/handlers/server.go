package handlers

import (
	"html/template"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"dontstoptalking/internal/game"
	"dontstoptalking/internal/topics"
)

type Server struct {
	mu       sync.Mutex
	session  *game.Session
	packs    []topics.Pack
	template *template.Template
}

type ViewData struct {
	Session     *game.Session
	Packs       []topics.Pack
	Selected    topics.Pack
	Error       string
	LastTurn    *game.Turn
	Standings   []game.Player
	CurrentTurn *game.Turn
}

func NewServer(templatePattern string) (*Server, error) {
	tmpl, err := template.ParseGlob(templatePattern)
	if err != nil {
		return nil, err
	}
	packs := topics.PresetPacks()
	session := game.NewSession("local")
	session.AddPlayer("Player 1")
	session.AddPlayer("Player 2")
	session.SetTopics(packs[0].Topics)

	return &Server{
		session:  session,
		packs:    packs,
		template: tmpl,
	}, nil
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleHome)
	mux.HandleFunc("/players", s.handlePlayers)
	mux.HandleFunc("/players/rename", s.handleRenamePlayer)
	mux.HandleFunc("/players/move", s.handleMovePlayer)
	mux.HandleFunc("/players/remove", s.handleRemovePlayer)
	mux.HandleFunc("/settings", s.handleSettings)
	mux.HandleFunc("/topics/custom", s.handleCustomTopics)
	mux.HandleFunc("/game/start", s.handleStartGame)
	mux.HandleFunc("/turn/start", s.handleStartTurn)
	mux.HandleFunc("/turn/redraw", s.handleRedrawTurn)
	mux.HandleFunc("/turn/submit", s.handleSubmitTurn)
	mux.HandleFunc("/score/override", s.handleScoreOverride)
	mux.HandleFunc("/game/reset", s.handleReset)
	fileServer := http.FileServer(http.Dir("web/static"))
	mux.Handle("/static/", http.StripPrefix("/static/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		fileServer.ServeHTTP(w, r)
	})))
	return mux
}

func (s *Server) handleHome(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session.ActiveTurn != nil {
		data := s.view("")
		data.CurrentTurn = s.session.ActiveTurn
		s.render(w, "playPage", data)
		return
	}
	if s.session.Finished {
		s.render(w, "winnerPage", s.view(""))
		return
	}
	if s.session.Started && len(s.session.CompletedTurns) > 0 {
		data := s.view("")
		data.LastTurn = lastTurn(s.session)
		s.render(w, "scorePage", data)
		return
	}
	s.render(w, "home", s.view(""))
}

func (s *Server) handlePlayers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.session.AddPlayer(r.FormValue("name"))
	s.render(w, "players", s.view(""))
}

func (s *Server) handleRenamePlayer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.session.RenamePlayer(r.FormValue("id"), r.FormValue("name"))
	s.render(w, "players", s.view(""))
}

func (s *Server) handleMovePlayer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.session.MovePlayer(r.FormValue("id"), parseInt(r.FormValue("offset"), 0))
	s.render(w, "players", s.view(""))
}

func (s *Server) handleRemovePlayer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.session.RemovePlayer(r.FormValue("id"))
	s.render(w, "players", s.view(""))
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	settings := game.Settings{
		SpeakingDurationSeconds: parseInt(r.FormValue("duration"), s.session.Settings.SpeakingDurationSeconds),
		SilenceTimeoutSeconds:   parseInt(r.FormValue("silence"), s.session.Settings.SilenceTimeoutSeconds),
		Rounds:                  parseInt(r.FormValue("rounds"), s.session.Settings.Rounds),
		TopicPackID:             r.FormValue("topicPack"),
	}
	s.session.UpdateSettings(settings)
	if pack, ok := topics.FindPack(settings.TopicPackID); ok {
		s.session.SetTopics(pack.Topics)
	}
	s.render(w, "setup", s.view(""))
}

func (s *Server) handleCustomTopics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	raw := strings.ReplaceAll(r.FormValue("topics"), "\r\n", "\n")
	lines := strings.Split(raw, "\n")
	s.session.SetTopics(lines)
	s.session.UpdateSettings(game.Settings{
		SpeakingDurationSeconds: s.session.Settings.SpeakingDurationSeconds,
		SilenceTimeoutSeconds:   s.session.Settings.SilenceTimeoutSeconds,
		Rounds:                  s.session.Settings.Rounds,
		TopicPackID:             "custom",
	})
	s.render(w, "setup", s.view(""))
}

func (s *Server) handleStartGame(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.session.Start(); err != nil {
		s.renderState(w, err.Error())
		return
	}
	turn, err := s.session.StartTurn()
	if err != nil {
		s.renderState(w, err.Error())
		return
	}
	data := s.view("")
	data.CurrentTurn = turn
	s.render(w, "play", data)
}

func (s *Server) handleStartTurn(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	turn, err := s.session.StartTurn()
	if err != nil {
		s.renderState(w, err.Error())
		return
	}
	data := s.view("")
	data.CurrentTurn = turn
	s.render(w, "play", data)
}

func (s *Server) handleRedrawTurn(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	turn, err := s.session.RedrawActiveTurn()
	if err != nil {
		s.renderState(w, err.Error())
		return
	}
	data := s.view("")
	data.CurrentTurn = turn
	s.render(w, "play", data)
}

func (s *Server) handleSubmitTurn(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	spoken := parseInt(r.FormValue("spokenSeconds"), 0)
	completed := r.FormValue("completed") == "true"
	eliminated := r.FormValue("eliminated") == "true"
	turn, err := s.session.SubmitTurn(spoken, completed, eliminated)
	if err != nil {
		s.renderState(w, err.Error())
		return
	}
	data := s.view("")
	data.LastTurn = &turn
	if s.session.Finished {
		s.render(w, "winner", data)
		return
	}
	s.render(w, "score", data)
}

func (s *Server) handleScoreOverride(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.session.OverrideScore(r.FormValue("playerID"), parseInt(r.FormValue("delta"), 0))
	s.render(w, "standings", s.view(""))
}

func (s *Server) handleReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	packID := s.session.Settings.TopicPackID
	s.session = game.NewSession("local")
	s.session.AddPlayer("Player 1")
	s.session.AddPlayer("Player 2")
	if pack, ok := topics.FindPack(packID); ok {
		s.session.UpdateSettings(game.Settings{
			SpeakingDurationSeconds: game.DefaultSettings().SpeakingDurationSeconds,
			SilenceTimeoutSeconds:   game.DefaultSettings().SilenceTimeoutSeconds,
			Rounds:                  game.DefaultSettings().Rounds,
			TopicPackID:             pack.ID,
		})
		s.session.SetTopics(pack.Topics)
	} else {
		s.session.SetTopics(s.packs[0].Topics)
	}
	s.render(w, "setup", s.view(""))
}

// renderState renders the partial that matches the session's current state,
// so error responses land on the screen the game is actually on instead of
// nesting the full home document inside an htmx swap.
func (s *Server) renderState(w http.ResponseWriter, message string) {
	data := s.view(message)
	switch {
	case s.session.ActiveTurn != nil:
		data.CurrentTurn = s.session.ActiveTurn
		s.render(w, "play", data)
	case s.session.Finished:
		s.render(w, "winner", data)
	case s.session.Started && len(s.session.CompletedTurns) > 0:
		data.LastTurn = lastTurn(s.session)
		s.render(w, "score", data)
	default:
		s.render(w, "setup", data)
	}
}

func (s *Server) view(message string) ViewData {
	selected := topics.Pack{ID: "custom", Name: "Custom", Description: "Your custom list"}
	if pack, ok := topics.FindPack(s.session.Settings.TopicPackID); ok {
		selected = pack
	}
	return ViewData{
		Session:   s.session,
		Packs:     s.packs,
		Selected:  selected,
		Error:     message,
		Standings: s.session.Standings(),
	}
}

func (s *Server) render(w http.ResponseWriter, name string, data ViewData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := s.template.ExecuteTemplate(w, name, data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
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
