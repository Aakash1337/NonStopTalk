// Package room manages online game rooms: short join codes, per-room game
// sessions, member identity, live update notifications, and the server-side
// turn clock used for authoritative scoring.
package room

import (
	"crypto/rand"
	"errors"
	"sync"
	"time"

	"github.com/Aakash1337/NonStopTalk/internal/game"
)

const (
	// codeAlphabet avoids ambiguous characters (0/O, 1/I/L).
	codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	CodeLength   = 6

	MaxRooms          = 200
	MaxPlayersPerRoom = 12
	MaxSubscribers    = 64
	// MaxSubscribersPerToken prevents one browser identity from consuming a
	// room's entire live-update allowance with duplicate tabs.
	MaxSubscribersPerToken = 4

	// idleTTL is how long a room survives without any activity.
	idleTTL = 3 * time.Hour
)

var (
	ErrRoomNotFound        = errors.New("room not found")
	ErrTooManyRooms        = errors.New("too many active rooms, try again later")
	ErrRoomFull            = errors.New("room is full")
	ErrTooManySubscribers  = errors.New("too many live connections in this room")
	ErrTooManyTokenStreams = errors.New("too many live connections for this member")
	ErrNotRoomMember       = errors.New("room membership required")
)

// Room owns one game session plus everything needed to share it: member
// identity, live-update subscribers, presence, and the server-side turn clock.
// All session reads and writes must go through Do (mutations) or View (reads)
// so concurrent clients stay consistent; the other exported methods take the
// lock themselves and must not be called from inside a Do/View callback.
type Room struct {
	Code    string
	Session *game.Session

	mu           sync.Mutex
	hostToken    string
	hostLastSeen time.Time
	members      map[string]string // browser token -> player ID
	subscribers  map[chan struct{}]string
	online       map[string]int // player ID -> live connection count
	tokenConns   map[string]int // browser token -> live connection count
	version      int64
	lastActive   time.Time
	turnStarted  time.Time
	done         chan struct{}
	expired      bool
	// topicGeneration identifies the newest in-flight generated-topic request
	// so a slow older response cannot overwrite a newer host choice.
	topicGeneration uint64
}

func (r *Room) touch() {
	r.lastActive = time.Now()
}

func (r *Room) finishMutationLocked(touch bool) []chan struct{} {
	r.version++
	if touch {
		r.touch()
	}
	subscribers := make([]chan struct{}, 0, len(r.subscribers))
	for ch := range r.subscribers {
		subscribers = append(subscribers, ch)
	}
	return subscribers
}

func wakeSubscribers(subscribers []chan struct{}) {
	for _, ch := range subscribers {
		select {
		case ch <- struct{}{}:
		default: // subscriber already has a pending wake-up
		}
	}
}

// Do runs fn while holding the room lock, then wakes every subscriber so
// their view refreshes. Use for any state mutation.
func (r *Room) Do(fn func()) {
	r.mu.Lock()
	fn()
	subscribers := r.finishMutationLocked(true)
	r.mu.Unlock()
	wakeSubscribers(subscribers)
}

// DoAuthorized evaluates authorize and, when allowed, runs fn under the same
// room lock. This prevents host-transfer races between permission checks and
// mutations. The callback receives the caller's current role and seat.
func (r *Room) DoAuthorized(
	token string,
	authorize func(isHost bool, playerID string, session *game.Session) bool,
	fn func(),
) bool {
	r.mu.Lock()
	isHost := token != "" && token == r.hostToken
	playerID := r.members[token]
	if !authorize(isHost, playerID, r.Session) {
		r.mu.Unlock()
		return false
	}
	fn()
	subscribers := r.finishMutationLocked(true)
	r.mu.Unlock()
	wakeSubscribers(subscribers)
	return true
}

// DoAsHost atomically checks host ownership and applies fn.
func (r *Room) DoAsHost(token string, fn func()) bool {
	return r.DoAuthorized(token, func(isHost bool, _ string, _ *game.Session) bool {
		return isHost
	}, fn)
}

// DoAsHostInSetup applies a setup-only host mutation atomically. Keeping the
// phase check under the room lock prevents delayed setup requests from changing
// a game after it has started.
func (r *Room) DoAsHostInSetup(token string, fn func()) bool {
	return r.DoAuthorized(token, func(isHost bool, _ string, session *game.Session) bool {
		return isHost && !session.Started
	}, fn)
}

// View runs fn while holding the room lock without notifying subscribers.
func (r *Room) View(fn func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	fn()
}

func (r *Room) Version() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.version
}

// --- Host identity ---

// IsHost reports whether the token currently controls the room.
func (r *Room) IsHost(token string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return token != "" && token == r.hostToken
}

// HostSeen records host activity: any HTTP request or live connection from
// the host token counts as presence for the claim grace period.
func (r *Room) HostSeen(token string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if token != "" && token == r.hostToken {
		r.hostLastSeen = time.Now()
	}
}

// HostOfflineFor returns how long the host has been away: zero while any of
// the host's connections is live.
func (r *Room) HostOfflineFor() time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.tokenConns[r.hostToken] > 0 {
		return 0
	}
	return time.Since(r.hostLastSeen)
}

// TransferHostTo hands room control to another token and notifies everyone.
// It is retained for trusted internal/test setup; request handlers should use
// TransferHostByPlayer so authorization and lookup happen atomically.
func (r *Room) TransferHostTo(token string) {
	r.Do(func() {
		r.hostToken = token
		r.hostLastSeen = time.Now()
		r.topicGeneration++
	})
}

// TransferHostByPlayer atomically verifies the current host and transfers
// control to the connected browser bound to playerID.
func (r *Room) TransferHostByPlayer(actorToken, playerID string) bool {
	r.mu.Lock()
	if actorToken == "" || actorToken != r.hostToken {
		r.mu.Unlock()
		return false
	}
	targetToken := ""
	for token, id := range r.members {
		if id == playerID {
			targetToken = token
			break
		}
	}
	if targetToken == "" {
		r.mu.Unlock()
		return false
	}
	r.hostToken = targetToken
	r.hostLastSeen = time.Now()
	r.topicGeneration++
	subscribers := r.finishMutationLocked(true)
	r.mu.Unlock()
	wakeSubscribers(subscribers)
	return true
}

// ClaimHost atomically transfers an absent host's role to a seated member.
// It returns false when the caller is not seated or the current host is still
// within the grace window. An already-current host succeeds as a no-op.
func (r *Room) ClaimHost(token string, grace time.Duration) bool {
	r.mu.Lock()
	if token != "" && token == r.hostToken {
		r.mu.Unlock()
		return true
	}
	if token == "" || r.members[token] == "" || r.tokenConns[r.hostToken] > 0 ||
		time.Since(r.hostLastSeen) < grace {
		r.mu.Unlock()
		return false
	}
	r.hostToken = token
	r.hostLastSeen = time.Now()
	r.topicGeneration++
	subscribers := r.finishMutationLocked(true)
	r.mu.Unlock()
	wakeSubscribers(subscribers)
	return true
}

// HostPlayerID returns the player seat bound to the host token, if any.
func (r *Room) HostPlayerID() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.members[r.hostToken]
}

// TokenForPlayer returns the browser token bound to a player ID.
func (r *Room) TokenForPlayer(playerID string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for token, id := range r.members {
		if id == playerID {
			return token, true
		}
	}
	return "", false
}

// BindMember associates a browser token with a player ID.
func (r *Room) BindMember(token, playerID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.members[token] = playerID
}

func (r *Room) UnbindMember(token string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.members, token)
}

// BindMemberLocked is BindMember for use inside a Do or View callback,
// where the room lock is already held.
func (r *Room) BindMemberLocked(token, playerID string) {
	r.members[token] = playerID
}

// UnbindMemberLocked removes a token's seat inside a Do or View callback.
func (r *Room) UnbindMemberLocked(token string) {
	if playerID, ok := r.members[token]; ok {
		delete(r.online, playerID)
	}
	delete(r.members, token)
}

// UnbindPlayerLocked removes every token bound to a player ID inside a Do or
// View callback (used when the host removes a remote player).
func (r *Room) UnbindPlayerLocked(playerID string) {
	for token, id := range r.members {
		if id == playerID {
			delete(r.members, token)
		}
	}
	delete(r.online, playerID)
}

// MemberPlayerID returns the player ID bound to a browser token.
func (r *Room) MemberPlayerID(token string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	id, ok := r.members[token]
	return id, ok
}

func (r *Room) MemberCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.members)
}

// BeginTopicGeneration registers the newest host generation request. The
// returned sequence must be supplied to ApplyTopicGeneration.
func (r *Room) BeginTopicGeneration(token string) (uint64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if token == "" || token != r.hostToken || r.Session.Started {
		return 0, false
	}
	r.topicGeneration++
	return r.topicGeneration, true
}

// ApplyTopicGeneration applies only the newest request and only while the
// original caller still owns the room.
func (r *Room) ApplyTopicGeneration(token string, generation uint64, fn func()) bool {
	r.mu.Lock()
	if token == "" || token != r.hostToken || r.Session.Started || generation == 0 || generation != r.topicGeneration {
		r.mu.Unlock()
		return false
	}
	fn()
	subscribers := r.finishMutationLocked(true)
	r.mu.Unlock()
	wakeSubscribers(subscribers)
	return true
}

// InvalidateTopicGenerationLocked cancels any provider response that was
// started before a newer manual/preset topic choice. Call it while locked.
func (r *Room) InvalidateTopicGenerationLocked() {
	r.topicGeneration++
}

// Subscribe registers a live-update listener for the given token and returns
// the wake-up channel plus an unsubscribe function.
func (r *Room) Subscribe(token string) (<-chan struct{}, func(), error) {
	ch := make(chan struct{}, 1)
	r.mu.Lock()
	if r.expired || token == "" || (token != r.hostToken && r.members[token] == "") {
		r.mu.Unlock()
		return nil, func() {}, ErrNotRoomMember
	}
	if len(r.subscribers) >= MaxSubscribers {
		r.mu.Unlock()
		return nil, func() {}, ErrTooManySubscribers
	}
	if r.tokenConns[token] >= MaxSubscribersPerToken {
		r.mu.Unlock()
		return nil, func() {}, ErrTooManyTokenStreams
	}
	r.subscribers[ch] = token
	r.tokenConns[token]++
	if token == r.hostToken {
		r.hostLastSeen = time.Now()
	}
	if playerID, ok := r.members[token]; ok {
		r.online[playerID]++
	}
	r.mu.Unlock()

	r.notifyPresence()
	return ch, func() {
		r.mu.Lock()
		delete(r.subscribers, ch)
		if r.tokenConns[token] > 1 {
			r.tokenConns[token]--
		} else {
			delete(r.tokenConns, token)
		}
		if token == r.hostToken {
			r.hostLastSeen = time.Now()
		}
		if playerID, ok := r.members[token]; ok {
			if r.online[playerID] > 1 {
				r.online[playerID]--
			} else {
				delete(r.online, playerID)
			}
		}
		r.mu.Unlock()
		r.notifyPresence()
	}, nil
}

// notifyPresence bumps the version so rosters can re-render online markers.
func (r *Room) notifyPresence() {
	r.mu.Lock()
	subscribers := r.finishMutationLocked(false)
	r.mu.Unlock()
	wakeSubscribers(subscribers)
}

// Done closes when the manager expires or removes this room. Live streams can
// use it to stop promptly instead of pinning an otherwise idle room.
func (r *Room) Done() <-chan struct{} {
	return r.done
}

// BoundPlayers returns the player IDs claimed by a remote browser. Players
// not in this set are pass-and-play seats driven from the host's screen.
func (r *Room) BoundPlayers() map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	bound := make(map[string]bool, len(r.members))
	for _, playerID := range r.members {
		bound[playerID] = true
	}
	return bound
}

// OnlinePlayers returns a copy of the currently connected player IDs.
func (r *Room) OnlinePlayers() map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	online := make(map[string]bool, len(r.online))
	for id, count := range r.online {
		if count > 0 {
			online[id] = true
		}
	}
	return online
}

// BeginTurn starts the server-side turn clock if it is not already running.
func (r *Room) BeginTurn() {
	r.Do(func() {
		if r.turnStarted.IsZero() {
			r.turnStarted = time.Now()
		}
	})
}

// StartTurnLocked starts (or returns) the active turn and clears the clock
// only when a new turn was created. It must be called from a Do/DoAuthorized
// callback while the room lock is held.
func (r *Room) StartTurnLocked() (*game.Turn, error) {
	created := r.Session.ActiveTurn == nil
	turn, err := r.Session.StartTurn()
	if err == nil && created {
		r.turnStarted = time.Time{}
	}
	return turn, err
}

// RedrawActiveTurnLocked replaces the topic generation and atomically clears
// its clock. It must be called while the room lock is held.
func (r *Room) RedrawActiveTurnLocked() (*game.Turn, error) {
	if !r.turnStarted.IsZero() {
		return nil, errors.New("a topic can only be redrawn before speaking begins")
	}
	turn, err := r.Session.RedrawActiveTurn()
	if err == nil {
		r.turnStarted = time.Time{}
	}
	return turn, err
}

// ClearTurnClockLocked resets the clock while the caller holds the room lock.
func (r *Room) ClearTurnClockLocked() {
	r.turnStarted = time.Time{}
}

// BeginTurnLocked starts the clock while the room lock is held.
func (r *Room) BeginTurnLocked() {
	if r.turnStarted.IsZero() {
		r.turnStarted = time.Now()
	}
}

// EndTurnClockLocked returns and clears the current clock while locked.
func (r *Room) EndTurnClockLocked() int {
	if r.turnStarted.IsZero() {
		return -1
	}
	elapsed := int(time.Since(r.turnStarted).Seconds())
	r.turnStarted = time.Time{}
	return elapsed
}

// BeginTurnFor starts the clock only when turnID is still the active turn.
// This prevents a delayed browser request from starting a later turn's clock.
func (r *Room) BeginTurnFor(turnID string) bool {
	matched := false
	r.Do(func() {
		if turnID == "" || r.Session.ActiveTurn == nil || r.Session.ActiveTurn.ID != turnID {
			return
		}
		matched = true
		if r.turnStarted.IsZero() {
			r.turnStarted = time.Now()
		}
	})
	return matched
}

// TurnRunning reports whether the server-side turn clock is running.
func (r *Room) TurnRunning() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return !r.turnStarted.IsZero()
}

// TurnElapsedSeconds returns the whole seconds since the turn clock started,
// or -1 if the clock never started.
func (r *Room) TurnElapsedSeconds() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.turnStarted.IsZero() {
		return -1
	}
	return int(time.Since(r.turnStarted).Seconds())
}

// EndTurnClock stops and clears the turn clock, returning the elapsed whole
// seconds (-1 if it never started).
func (r *Room) EndTurnClock() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.turnStarted.IsZero() {
		return -1
	}
	elapsed := int(time.Since(r.turnStarted).Seconds())
	r.turnStarted = time.Time{}
	return elapsed
}

// EndTurnClockFor clears and returns the clock only when turnID still names
// the active turn. The bool distinguishes a stopped clock from a stale action.
func (r *Room) EndTurnClockFor(turnID string) (int, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if turnID == "" || r.Session.ActiveTurn == nil || r.Session.ActiveTurn.ID != turnID {
		return -1, false
	}
	if r.turnStarted.IsZero() {
		return -1, true
	}
	elapsed := int(time.Since(r.turnStarted).Seconds())
	r.turnStarted = time.Time{}
	return elapsed, true
}

// ClearTurnClock resets the clock without reading it (topic redraw, reset).
func (r *Room) ClearTurnClock() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.turnStarted = time.Time{}
}

// ClearTurnClockFor resets the clock only while turnID is still active.
func (r *Room) ClearTurnClockFor(turnID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if turnID == "" || r.Session.ActiveTurn == nil || r.Session.ActiveTurn.ID != turnID {
		return false
	}
	r.turnStarted = time.Time{}
	return true
}

type Manager struct {
	mu    sync.Mutex
	rooms map[string]*Room
}

func NewManager() *Manager {
	return &Manager{rooms: map[string]*Room{}}
}

// Create makes a new room owned by hostToken.
func (m *Manager) Create(hostToken string) (*Room, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cleanupLocked()
	if len(m.rooms) >= MaxRooms {
		return nil, ErrTooManyRooms
	}
	code, err := m.newCodeLocked()
	if err != nil {
		return nil, err
	}
	room := &Room{
		Code:         code,
		Session:      game.NewSession(code),
		hostToken:    hostToken,
		hostLastSeen: time.Now(),
		members:      map[string]string{},
		subscribers:  map[chan struct{}]string{},
		online:       map[string]int{},
		tokenConns:   map[string]int{},
		lastActive:   time.Now(),
		done:         make(chan struct{}),
	}
	m.rooms[code] = room
	return room, nil
}

// Get returns the room for a code.
func (m *Manager) Get(code string) (*Room, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	room, ok := m.rooms[code]
	if !ok {
		return nil, ErrRoomNotFound
	}
	room.mu.Lock()
	expired := room.lastActive.Before(time.Now().Add(-idleTTL))
	if expired {
		room.expireLocked()
	}
	room.mu.Unlock()
	if expired {
		delete(m.rooms, code)
		return nil, ErrRoomNotFound
	}
	return room, nil
}

// Remove deletes a room.
func (m *Manager) Remove(code string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if room := m.rooms[code]; room != nil {
		room.mu.Lock()
		room.expireLocked()
		room.mu.Unlock()
	}
	delete(m.rooms, code)
}

// ExpireIfIdle removes code once it has had no state mutation for the room
// TTL. Live streams do not extend that lifetime.
func (m *Manager) ExpireIfIdle(code string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	room := m.rooms[code]
	if room == nil {
		return true
	}
	room.mu.Lock()
	expired := room.lastActive.Before(time.Now().Add(-idleTTL))
	if expired {
		room.expireLocked()
	}
	room.mu.Unlock()
	if expired {
		delete(m.rooms, code)
	}
	return expired
}

func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.rooms)
}

func (m *Manager) cleanupLocked() {
	cutoff := time.Now().Add(-idleTTL)
	for code, room := range m.rooms {
		room.mu.Lock()
		idle := room.lastActive.Before(cutoff)
		if idle {
			room.expireLocked()
		}
		room.mu.Unlock()
		if idle {
			delete(m.rooms, code)
		}
	}
}

func (r *Room) expireLocked() {
	if r.expired {
		return
	}
	r.expired = true
	if r.done == nil {
		r.done = make(chan struct{})
	}
	close(r.done)
}

func (m *Manager) newCodeLocked() (string, error) {
	for attempt := 0; attempt < 50; attempt++ {
		code, err := NewCode()
		if err != nil {
			return "", err
		}
		if _, exists := m.rooms[code]; !exists {
			return code, nil
		}
	}
	return "", errors.New("could not allocate a room code")
}

// NewCode returns a random room code.
func NewCode() (string, error) {
	buf := make([]byte, CodeLength)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	for i, b := range buf {
		buf[i] = codeAlphabet[int(b)%len(codeAlphabet)]
	}
	return string(buf), nil
}

// NewToken returns a random identity token for a browser.
func NewToken() (string, error) {
	const hexDigits = "0123456789abcdef"
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, len(buf)*2)
	for i, b := range buf {
		out[i*2] = hexDigits[b>>4]
		out[i*2+1] = hexDigits[b&0x0f]
	}
	return string(out), nil
}
