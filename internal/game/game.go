package game

import (
	"errors"
	"sort"
	"strings"
	"time"
)

const (
	DefaultSpeakingDuration = 60 * time.Second
	DefaultSilenceTimeout   = 2 * time.Second
	DefaultRounds           = 1
	CompletionBonus         = 25

	MaxPlayerNameLength = 40
	MaxTopicLength      = 200
	MaxTopics           = 500
)

type Settings struct {
	SpeakingDurationSeconds int
	SilenceTimeoutSeconds   int
	Rounds                  int
	TopicPackID             string
	// AIJudgeEnabled turns on the optional relevance bonus. Off by default:
	// AI is an optional judge, never the core game.
	AIJudgeEnabled bool
}

func DefaultSettings() Settings {
	return Settings{
		SpeakingDurationSeconds: int(DefaultSpeakingDuration.Seconds()),
		SilenceTimeoutSeconds:   int(DefaultSilenceTimeout.Seconds()),
		Rounds:                  DefaultRounds,
		TopicPackID:             "everyday",
	}
}

func (s Settings) Normalize() Settings {
	if s.SpeakingDurationSeconds < 10 {
		s.SpeakingDurationSeconds = 10
	}
	if s.SpeakingDurationSeconds > 300 {
		s.SpeakingDurationSeconds = 300
	}
	if s.SilenceTimeoutSeconds < 1 {
		s.SilenceTimeoutSeconds = 1
	}
	if s.SilenceTimeoutSeconds > 10 {
		s.SilenceTimeoutSeconds = 10
	}
	if s.Rounds < 1 {
		s.Rounds = 1
	}
	if s.Rounds > 10 {
		s.Rounds = 10
	}
	if strings.TrimSpace(s.TopicPackID) == "" {
		s.TopicPackID = "everyday"
	}
	return s
}

type Player struct {
	ID    string
	Name  string
	Score int
}

// AI judge status values for a turn.
const (
	AIStatusPending = "pending"
	AIStatusDone    = "done"
	AIStatusSkipped = "skipped"
	AIStatusFailed  = "failed"
)

type Turn struct {
	PlayerID      string
	PlayerName    string
	Round         int
	Topic         string
	TopicIndex    int
	Duration      int
	SilenceLimit  int
	SpokenSeconds int
	Completed     bool
	Eliminated    bool
	Score         int
	Scored        bool

	// AI judge results ("" means the judge was not involved).
	AIStatus    string
	AIRelevance *float64
	AIFeedback  string
	// AIConfidence (0..1) is how sure the judge was; nil when unknown.
	AIConfidence *float64
}

// AIConfidenceLabel renders the judge's confidence for players.
func (t Turn) AIConfidenceLabel() string {
	if t.AIConfidence == nil {
		return ""
	}
	switch {
	case *t.AIConfidence >= 0.75:
		return "high confidence"
	case *t.AIConfidence >= 0.4:
		return "medium confidence"
	default:
		return "low confidence"
	}
}

func (t Turn) ScoreParts() []ScorePart {
	return ScoreParts(ScoreInput{
		DurationSeconds:  t.Duration,
		SpokenSeconds:    t.SpokenSeconds,
		Completed:        t.Completed,
		AIRelevanceScore: t.AIRelevance,
	})
}

// GameRecord summarizes one finished game for the room's history.
type GameRecord struct {
	FinishedAt time.Time
	Standings  []Player
	Turns      int
}

// MaxHistory caps how many finished games a room remembers.
const MaxHistory = 20

type Session struct {
	ID               string
	Players          []Player
	Settings         Settings
	Topics           []string
	TopicCursor      int
	CurrentPlayer    int
	CurrentRound     int
	Started          bool
	Finished         bool
	ActiveTurn       *Turn
	CompletedTurns   []Turn
	History          []GameRecord
	CreatedAt        time.Time
	// NextPlayerNumber is exported so sessions survive serialization; new
	// player IDs must not collide with ones handed out before a restart.
	NextPlayerNumber int
}

func NewSession(id string) *Session {
	return &Session{
		ID:               id,
		Settings:         DefaultSettings(),
		CurrentRound:     1,
		CreatedAt:        time.Now(),
		NextPlayerNumber: 1,
	}
}

func (s *Session) AddPlayer(name string) Player {
	name = cleanName(name)
	if name == "" {
		name = "Player " + itoa(s.NextPlayerNumber)
	}
	player := Player{
		ID:   "p" + itoa(s.NextPlayerNumber),
		Name: name,
	}
	s.NextPlayerNumber++
	s.Players = append(s.Players, player)
	return player
}

func (s *Session) RemovePlayer(id string) {
	index := -1
	for i, player := range s.Players {
		if player.ID == id {
			index = i
			break
		}
	}
	if index == -1 {
		return
	}
	s.Players = append(s.Players[:index], s.Players[index+1:]...)
	if s.ActiveTurn != nil && s.ActiveTurn.PlayerID == id {
		s.ActiveTurn = nil
	}
	if index < s.CurrentPlayer {
		s.CurrentPlayer--
	}
	if len(s.Players) == 0 || s.CurrentPlayer >= len(s.Players) {
		s.CurrentPlayer = 0
	}
}

func (s *Session) RenamePlayer(id string, name string) bool {
	name = cleanName(name)
	if name == "" {
		return false
	}
	for i := range s.Players {
		if s.Players[i].ID == id {
			s.Players[i].Name = name
			if s.ActiveTurn != nil && s.ActiveTurn.PlayerID == id {
				s.ActiveTurn.PlayerName = name
			}
			return true
		}
	}
	return false
}

func (s *Session) MovePlayer(id string, offset int) bool {
	if offset == 0 || len(s.Players) < 2 {
		return false
	}

	currentPlayerID := ""
	if s.CurrentPlayer >= 0 && s.CurrentPlayer < len(s.Players) {
		currentPlayerID = s.Players[s.CurrentPlayer].ID
	}

	from := -1
	for i, player := range s.Players {
		if player.ID == id {
			from = i
			break
		}
	}
	if from == -1 {
		return false
	}

	to := from + offset
	if to < 0 || to >= len(s.Players) {
		return false
	}

	s.Players[from], s.Players[to] = s.Players[to], s.Players[from]
	if currentPlayerID != "" {
		for i, player := range s.Players {
			if player.ID == currentPlayerID {
				s.CurrentPlayer = i
				break
			}
		}
	}
	return true
}

func (s *Session) UpdateSettings(settings Settings) {
	s.Settings = settings.Normalize()
}

func (s *Session) SetTopics(topics []string) {
	cleaned := make([]string, 0, len(topics))
	seen := map[string]bool{}
	for _, topic := range topics {
		topic = strings.TrimSpace(topic)
		if topic == "" {
			continue
		}
		topic = truncate(topic, MaxTopicLength)
		key := strings.ToLower(topic)
		if seen[key] {
			continue
		}
		seen[key] = true
		cleaned = append(cleaned, topic)
		if len(cleaned) >= MaxTopics {
			break
		}
	}
	s.Topics = cleaned
	s.TopicCursor = 0
}

// archiveFinishedGame records a completed game in the room history before
// its turns and scores are cleared.
func (s *Session) archiveFinishedGame() {
	if !s.Finished || len(s.CompletedTurns) == 0 {
		return
	}
	record := GameRecord{
		FinishedAt: time.Now(),
		Standings:  s.Standings(),
		Turns:      len(s.CompletedTurns),
	}
	s.History = append(s.History, record)
	if len(s.History) > MaxHistory {
		s.History = s.History[len(s.History)-MaxHistory:]
	}
}

// ResetForNewGame clears play state while keeping the roster, settings, and
// topics so remote players stay bound to their seats across games.
func (s *Session) ResetForNewGame() {
	s.archiveFinishedGame()
	s.Started = false
	s.Finished = false
	s.CurrentPlayer = 0
	s.CurrentRound = 1
	s.ActiveTurn = nil
	s.CompletedTurns = nil
	s.TopicCursor = 0
	for i := range s.Players {
		s.Players[i].Score = 0
	}
}

func (s *Session) CanStart() bool {
	return len(s.Players) >= 2 && len(s.Topics) > 0
}

func (s *Session) Start() error {
	if len(s.Players) < 2 {
		return errors.New("add at least two players")
	}
	if len(s.Topics) == 0 {
		return errors.New("choose at least one topic")
	}
	s.archiveFinishedGame()
	s.Started = true
	s.Finished = false
	s.CurrentPlayer = 0
	s.CurrentRound = 1
	s.ActiveTurn = nil
	s.CompletedTurns = nil
	for i := range s.Players {
		s.Players[i].Score = 0
	}
	return nil
}

func (s *Session) StartTurn() (*Turn, error) {
	if !s.Started {
		if err := s.Start(); err != nil {
			return nil, err
		}
	}
	if s.Finished {
		return nil, errors.New("game is finished")
	}
	if s.ActiveTurn != nil {
		return s.ActiveTurn, nil
	}
	if len(s.Players) == 0 || len(s.Topics) == 0 {
		return nil, errors.New("game is not ready")
	}
	player := s.Players[s.CurrentPlayer]
	topicIndex := s.TopicCursor % len(s.Topics)
	turn := &Turn{
		PlayerID:     player.ID,
		PlayerName:   player.Name,
		Round:        s.CurrentRound,
		Topic:        s.Topics[topicIndex],
		TopicIndex:   topicIndex,
		Duration:     s.Settings.SpeakingDurationSeconds,
		SilenceLimit: s.Settings.SilenceTimeoutSeconds,
	}
	s.TopicCursor++
	s.ActiveTurn = turn
	return turn, nil
}

func (s *Session) RedrawActiveTurn() (*Turn, error) {
	if s.ActiveTurn == nil {
		return nil, errors.New("no active turn")
	}
	if len(s.Topics) == 0 {
		return nil, errors.New("choose at least one topic")
	}

	nextIndex := s.ActiveTurn.TopicIndex
	for attempts := 0; attempts < len(s.Topics); attempts++ {
		candidate := s.TopicCursor % len(s.Topics)
		s.TopicCursor++
		if len(s.Topics) == 1 || candidate != s.ActiveTurn.TopicIndex {
			nextIndex = candidate
			break
		}
	}

	s.ActiveTurn.TopicIndex = nextIndex
	s.ActiveTurn.Topic = s.Topics[nextIndex]
	return s.ActiveTurn, nil
}

func (s *Session) SubmitTurn(spokenSeconds int, completed bool, eliminated bool) (Turn, error) {
	if s.ActiveTurn == nil {
		return Turn{}, errors.New("no active turn")
	}
	if spokenSeconds < 0 {
		spokenSeconds = 0
	}
	if spokenSeconds > s.ActiveTurn.Duration {
		spokenSeconds = s.ActiveTurn.Duration
	}
	turn := *s.ActiveTurn
	turn.SpokenSeconds = spokenSeconds
	turn.Completed = completed
	turn.Eliminated = eliminated
	turn.Score = Score(ScoreInput{
		DurationSeconds: turn.Duration,
		SpokenSeconds:   spokenSeconds,
		Completed:       completed,
	})
	turn.Scored = true

	for i := range s.Players {
		if s.Players[i].ID == turn.PlayerID {
			s.Players[i].Score += turn.Score
			break
		}
	}

	s.CompletedTurns = append(s.CompletedTurns, turn)
	s.ActiveTurn = nil
	s.advance()
	return turn, nil
}

// MarkTurnAIPending flags the most recent completed turn as awaiting an AI
// verdict and returns its index, or -1 if there is no turn to grade.
func (s *Session) MarkTurnAIPending() int {
	if len(s.CompletedTurns) == 0 {
		return -1
	}
	index := len(s.CompletedTurns) - 1
	s.CompletedTurns[index].AIStatus = AIStatusPending
	return index
}

// ResolveTurnAI records the judge's outcome for a previously submitted turn
// and applies the bonus to the player's score. The playerID and topic guard
// against the roster or game changing while the judge was thinking.
func (s *Session) ResolveTurnAI(index int, playerID, topic string, relevance *float64, confidence *float64, feedback string, status string) bool {
	if index < 0 || index >= len(s.CompletedTurns) {
		return false
	}
	turn := &s.CompletedTurns[index]
	if turn.PlayerID != playerID || turn.Topic != topic {
		return false
	}
	turn.AIStatus = status
	turn.AIFeedback = feedback
	turn.AIConfidence = confidence
	if relevance == nil || status != AIStatusDone {
		return true
	}
	turn.AIRelevance = relevance
	bonus := int(*relevance * 20)
	turn.Score += bonus
	for i := range s.Players {
		if s.Players[i].ID == playerID {
			s.Players[i].Score += bonus
			break
		}
	}
	return true
}

func (s *Session) OverrideScore(playerID string, delta int) {
	for i := range s.Players {
		if s.Players[i].ID == playerID {
			s.Players[i].Score += delta
			if s.Players[i].Score < 0 {
				s.Players[i].Score = 0
			}
			return
		}
	}
}

func (s *Session) Standings() []Player {
	players := append([]Player(nil), s.Players...)
	sort.SliceStable(players, func(i, j int) bool {
		return players[i].Score > players[j].Score
	})
	return players
}

func (s *Session) Winner() *Player {
	if len(s.Players) == 0 {
		return nil
	}
	standings := s.Standings()
	return &standings[0]
}

func (s *Session) advance() {
	s.CurrentPlayer++
	if s.CurrentPlayer >= len(s.Players) {
		s.CurrentPlayer = 0
		s.CurrentRound++
	}
	if s.CurrentRound > s.Settings.Rounds {
		s.Finished = true
	}
}

func cleanName(name string) string {
	return truncate(strings.TrimSpace(name), MaxPlayerNameLength)
}

func truncate(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return strings.TrimSpace(string(runes[:max]))
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}
