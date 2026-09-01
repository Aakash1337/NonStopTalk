package game

import (
	"errors"
	"math/rand"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	DefaultSpeakingDuration = 60 * time.Second
	DefaultSilenceTimeout   = 2 * time.Second
	DefaultRounds           = 1
	CompletionBonus         = 25
	MaxScoreCorrectionDelta = 100
	// MaxTurnIDNumber is JavaScript's largest safe integer, keeping every ID in
	// the cross-runtime JSON range exact rather than relying on sparse larger
	// representable values.
	MaxTurnIDNumber         int64 = 9007199254740991
	turnIDExhaustedSentinel int64 = MaxTurnIDNumber + 1

	MaxPlayerNameLength = 40
	MaxTopicLength      = 200
	MaxTopics           = 500
)

var ErrTopicsRequired = errors.New("choose at least one topic")
var ErrTurnIDsExhausted = errors.New("this room has exhausted its turn IDs")

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
	// ID is unique for the lifetime of the session and identifies one exact
	// active-topic generation. A redraw deliberately rotates it so delayed
	// actions cannot affect the replacement topic.
	ID            string
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
	ID       string
	Players  []Player
	Settings Settings
	Topics   []string
	// TopicDeck is a shuffled list of indexes into Topics. Keeping the order
	// separate means random play never mutates the host's source topic list.
	// The deck and its cursor are exported so an in-progress cycle survives
	// persistence.
	TopicDeck       []int
	TopicDeckCursor int
	TopicCursor     int
	LastTopicIndex  int
	HasLastTopic    bool
	CurrentPlayer   int
	CurrentRound    int
	Started         bool
	Finished        bool
	ActiveTurn      *Turn
	CompletedTurns  []Turn
	History         []GameRecord
	CreatedAt       time.Time
	// NextPlayerNumber is exported so sessions survive serialization; new
	// player IDs must not collide with ones handed out before a restart.
	NextPlayerNumber int
	// NextTurnNumber is likewise persisted so delayed asynchronous results can
	// never collide with a turn created after a reset or restart.
	NextTurnNumber int64
}

func NewSession(id string) *Session {
	return &Session{
		ID:               id,
		Settings:         DefaultSettings(),
		CurrentRound:     1,
		CreatedAt:        time.Now(),
		NextPlayerNumber: 1,
		NextTurnNumber:   1,
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

// NormalizeTopics applies the shared custom-topic limits without changing the
// caller's slice. Handlers can use it to validate a complete replacement
// before entering a room mutation.
func NormalizeTopics(topics []string) []string {
	cleaned := make([]string, 0, len(topics))
	seen := map[string]bool{}
	for _, topic := range topics {
		topic = trimGameSpace(topic)
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
	return cleaned
}

// SetTopics replaces the complete topic collection. An empty replacement is
// rejected before any deck or cursor state changes, so validation failures are
// atomic for both direct callers and request handlers.
func (s *Session) SetTopics(topics []string) error {
	cleaned := NormalizeTopics(topics)
	if len(cleaned) == 0 {
		return ErrTopicsRequired
	}
	s.Topics = cleaned
	s.TopicDeck = nil
	s.TopicDeckCursor = 0
	s.TopicCursor = 0
	s.LastTopicIndex = 0
	s.HasLastTopic = false
	return nil
}

// resetTopicDeck starts a fresh shuffled cycle while remembering the most
// recently drawn topic. That memory prevents the last topic of one cycle or
// game from immediately becoming the first topic of the next.
func (s *Session) resetTopicDeck() {
	s.TopicDeck = nil
	s.TopicDeckCursor = 0
	s.TopicCursor = 0
}

func (s *Session) topicDeckValid() bool {
	if len(s.TopicDeck) != len(s.Topics) || s.TopicDeckCursor < 0 || s.TopicDeckCursor > len(s.TopicDeck) {
		return false
	}
	seen := make([]bool, len(s.Topics))
	for _, index := range s.TopicDeck {
		if index < 0 || index >= len(s.Topics) || seen[index] {
			return false
		}
		seen[index] = true
	}
	return true
}

func (s *Session) shuffleTopicDeck() {
	s.TopicDeck = make([]int, len(s.Topics))
	for index := range s.TopicDeck {
		s.TopicDeck[index] = index
	}
	rand.Shuffle(len(s.TopicDeck), func(i, j int) {
		s.TopicDeck[i], s.TopicDeck[j] = s.TopicDeck[j], s.TopicDeck[i]
	})

	// A fresh cycle must not begin with the topic that ended the previous one.
	// Swapping with a random later entry retains randomness among the allowed
	// first topics. A one-topic pack necessarily repeats.
	if len(s.TopicDeck) > 1 && s.HasLastTopic &&
		s.LastTopicIndex >= 0 && s.LastTopicIndex < len(s.Topics) &&
		s.TopicDeck[0] == s.LastTopicIndex {
		swapWith := 1 + rand.Intn(len(s.TopicDeck)-1)
		s.TopicDeck[0], s.TopicDeck[swapWith] = s.TopicDeck[swapWith], s.TopicDeck[0]
	}
	s.TopicDeckCursor = 0
}

func (s *Session) drawTopic() (int, error) {
	if len(s.Topics) == 0 {
		return 0, errors.New("choose at least one topic")
	}
	if !s.topicDeckValid() || s.TopicDeckCursor >= len(s.TopicDeck) {
		s.shuffleTopicDeck()
	}
	index := s.TopicDeck[s.TopicDeckCursor]
	s.TopicDeckCursor++
	s.TopicCursor++
	s.LastTopicIndex = index
	s.HasLastTopic = true
	return index, nil
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
func (s *Session) ResetForNewGame() error {
	if err := s.repairNextTurnNumber(); err != nil {
		return err
	}
	s.archiveFinishedGame()
	s.Started = false
	s.Finished = false
	s.CurrentPlayer = 0
	s.CurrentRound = 1
	s.ActiveTurn = nil
	s.CompletedTurns = nil
	s.resetTopicDeck()
	for i := range s.Players {
		s.Players[i].Score = 0
	}
	return nil
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
	if err := s.repairNextTurnNumber(); err != nil {
		return err
	}
	s.archiveFinishedGame()
	s.Started = true
	s.Finished = false
	s.CurrentPlayer = 0
	s.CurrentRound = 1
	s.ActiveTurn = nil
	s.CompletedTurns = nil
	s.resetTopicDeck()
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
		if s.ActiveTurn.ID == "" {
			id, err := s.nextTurnID()
			if err != nil {
				return nil, err
			}
			s.ActiveTurn.ID = id
		}
		return s.ActiveTurn, nil
	}
	if len(s.Players) == 0 || len(s.Topics) == 0 {
		return nil, errors.New("game is not ready")
	}
	player := s.Players[s.CurrentPlayer]
	turnID, err := s.nextTurnID()
	if err != nil {
		return nil, err
	}
	topicIndex, err := s.drawTopic()
	if err != nil {
		return nil, err
	}
	turn := &Turn{
		ID:           turnID,
		PlayerID:     player.ID,
		PlayerName:   player.Name,
		Round:        s.CurrentRound,
		Topic:        s.Topics[topicIndex],
		TopicIndex:   topicIndex,
		Duration:     s.Settings.SpeakingDurationSeconds,
		SilenceLimit: s.Settings.SilenceTimeoutSeconds,
	}
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

	turnID, err := s.nextTurnID()
	if err != nil {
		return nil, err
	}
	nextIndex, err := s.drawTopic()
	if err != nil {
		return nil, err
	}

	s.ActiveTurn.TopicIndex = nextIndex
	s.ActiveTurn.Topic = s.Topics[nextIndex]
	// A redraw invalidates every request rendered for the previous topic.
	// Give the replacement its own ID so delayed begin/redraw/submit actions
	// cannot operate on the newly displayed topic.
	s.ActiveTurn.ID = turnID
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
	// Completion is a derived fact, not a trusted flag. A short or eliminated
	// turn cannot retain a completion marker (or its bonus) even when a caller
	// requests one directly through the game package.
	completed = completed && !eliminated && spokenSeconds >= turn.Duration
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
	turn := &s.CompletedTurns[index]
	if turn.ID == "" {
		id, err := s.nextTurnID()
		if err != nil {
			return -1
		}
		turn.ID = id
	}
	switch turn.AIStatus {
	case "":
		turn.AIStatus = AIStatusPending
	case AIStatusPending:
		// Marking an already-pending turn is idempotent.
	default:
		// A resolved turn must never be reopened for another bonus.
		return -1
	}
	return index
}

// ResolveTurnAI records the judge's outcome for a previously submitted turn
// and applies the bonus to the player's score. The persisted turn ID guards
// against a reset creating the same player/topic/index combination while the
// judge was thinking. Only a pending turn can resolve, so applying a verdict is
// exactly-once.
func (s *Session) ResolveTurnAI(index int, turnID string, relevance *float64, confidence *float64, feedback string, status string) bool {
	if index < 0 || index >= len(s.CompletedTurns) {
		return false
	}
	turn := &s.CompletedTurns[index]
	if turnID == "" || turn.ID != turnID || turn.AIStatus != AIStatusPending {
		return false
	}
	if status != AIStatusDone && status != AIStatusSkipped && status != AIStatusFailed {
		return false
	}
	if status == AIStatusDone && relevance == nil {
		return false
	}
	turn.AIStatus = status
	turn.AIFeedback = feedback
	turn.AIConfidence = confidence
	if relevance == nil || status != AIStatusDone {
		turn.AIRelevance = nil
		return true
	}
	turn.AIRelevance = relevance
	bonus := aiRelevanceBonus(*relevance)
	turn.Score += bonus
	for i := range s.Players {
		if s.Players[i].ID == turn.PlayerID {
			s.Players[i].Score += bonus
			break
		}
	}
	return true
}

const restoredPendingAIFeedback = "The judge did not finish before the game was restored, so scoring stays classic."

// ReconcilePendingAI fails any grading work that could not survive a process
// restart. Pending turns have no committed AI bonus, but recomputing their
// classic score also repairs an inconsistent snapshot without disturbing any
// separate host score override.
func (s *Session) ReconcilePendingAI() int {
	reconciled := 0
	for index := range s.CompletedTurns {
		turn := &s.CompletedTurns[index]
		if turn.AIStatus != AIStatusPending {
			continue
		}
		classicScore := Score(ScoreInput{
			DurationSeconds: turn.Duration,
			SpokenSeconds:   turn.SpokenSeconds,
			Completed:       turn.Completed,
		})
		delta := classicScore - turn.Score
		turn.Score = classicScore
		turn.AIStatus = AIStatusFailed
		turn.AIRelevance = nil
		turn.AIConfidence = nil
		turn.AIFeedback = restoredPendingAIFeedback
		if delta != 0 {
			for playerIndex := range s.Players {
				if s.Players[playerIndex].ID == turn.PlayerID {
					s.Players[playerIndex].Score += delta
					if s.Players[playerIndex].Score < 0 {
						s.Players[playerIndex].Score = 0
					}
					break
				}
			}
		}
		reconciled++
	}
	return reconciled
}

func (s *Session) HasPlayer(playerID string) bool {
	for i := range s.Players {
		if s.Players[i].ID == playerID {
			return true
		}
	}
	return false
}

// OverrideScore applies a bounded host correction. The returned delta is the
// bounded request (the zero-point floor may make the effective change smaller)
// and accepted is false when the player no longer exists.
func (s *Session) OverrideScore(playerID string, delta int) (appliedDelta int, accepted bool) {
	if delta > MaxScoreCorrectionDelta {
		delta = MaxScoreCorrectionDelta
	}
	if delta < -MaxScoreCorrectionDelta {
		delta = -MaxScoreCorrectionDelta
	}
	for i := range s.Players {
		if s.Players[i].ID == playerID {
			s.Players[i].Score += delta
			if s.Players[i].Score < 0 {
				s.Players[i].Score = 0
			}
			return delta, true
		}
	}
	return 0, false
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

func (s *Session) nextTurnID() (string, error) {
	if err := s.repairNextTurnNumber(); err != nil {
		return "", err
	}
	if s.NextTurnNumber < 1 || s.NextTurnNumber > MaxTurnIDNumber {
		return "", ErrTurnIDsExhausted
	}
	id := "t" + strconv.FormatInt(s.NextTurnNumber, 10)
	if s.NextTurnNumber == MaxTurnIDNumber {
		s.NextTurnNumber = turnIDExhaustedSentinel
	} else {
		s.NextTurnNumber++
	}
	return id, nil
}

// ValidateTurnIDs checks whether another cross-runtime-safe turn ID can ever
// be allocated without changing the persisted counter. Request handlers use
// it inside their authorization transaction so an exhausted room can reject
// start/reset without creating a no-op room version.
func (s *Session) ValidateTurnIDs() error {
	_, err := s.repairedNextTurnNumber()
	return err
}

func (s *Session) repairNextTurnNumber() error {
	next, err := s.repairedNextTurnNumber()
	if err != nil {
		return err
	}
	s.NextTurnNumber = next
	return nil
}

func (s *Session) repairedNextTurnNumber() (int64, error) {
	maxUsed := int64(0)
	remember := func(id string) {
		if len(id) < 2 || id[0] != 't' || id[1] < '1' || id[1] > '9' {
			return
		}
		for _, digit := range id[2:] {
			if digit < '0' || digit > '9' {
				return
			}
		}
		number, err := strconv.ParseUint(id[1:], 10, 63)
		if err == nil && number <= uint64(MaxTurnIDNumber) && int64(number) > maxUsed {
			maxUsed = int64(number)
		}
	}
	if s.ActiveTurn != nil {
		remember(s.ActiveTurn.ID)
	}
	for _, turn := range s.CompletedTurns {
		remember(turn.ID)
	}
	if s.NextTurnNumber >= turnIDExhaustedSentinel || maxUsed >= MaxTurnIDNumber {
		return 0, ErrTurnIDsExhausted
	}
	next := s.NextTurnNumber
	if next <= maxUsed {
		next = maxUsed + 1
	}
	if next < 1 {
		next = 1
	}
	return next, nil
}

func cleanName(name string) string {
	return truncate(trimGameSpace(name), MaxPlayerNameLength)
}

func truncate(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return trimGameSpace(string(runes[:max]))
}

func trimGameSpace(value string) string {
	value = strings.ToValidUTF8(value, "\uFFFD")
	return strings.TrimFunc(value, func(r rune) bool {
		return unicode.IsSpace(r) || r == '\uFEFF'
	})
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
