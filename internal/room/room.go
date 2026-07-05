// Package room manages online game rooms: short join codes, per-room game
// sessions, member identity, live update notifications, and the server-side
// turn clock used for authoritative scoring.
package room

import (
	"crypto/rand"
	"errors"
	"sync"
	"time"

	"dontstoptalking/internal/game"
)

const (
	// codeAlphabet avoids ambiguous characters (0/O, 1/I/L).
	codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	CodeLength   = 6

	MaxRooms          = 200
	MaxPlayersPerRoom = 12

	// idleTTL is how long a room survives without any activity.
	idleTTL = 3 * time.Hour
)

var (
	ErrRoomNotFound = errors.New("room not found")
	ErrTooManyRooms = errors.New("too many active rooms, try again later")
	ErrRoomFull     = errors.New("room is full")
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
}

func (r *Room) touch() {
	r.lastActive = time.Now()
}

// Do runs fn while holding the room lock, then wakes every subscriber so
// their view refreshes. Use for any state mutation.
func (r *Room) Do(fn func()) {
	r.mu.Lock()
	fn()
	r.version++
	r.touch()
	subscribers := make([]chan struct{}, 0, len(r.subscribers))
	for ch := range r.subscribers {
		subscribers = append(subscribers, ch)
	}
	r.mu.Unlock()
	for _, ch := range subscribers {
		select {
		case ch <- struct{}{}:
		default: // subscriber already has a pending wake-up
		}
	}
}

// View runs fn while holding the room lock without notifying subscribers.
func (r *Room) View(fn func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.touch()
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
func (r *Room) TransferHostTo(token string) {
	r.Do(func() {
		r.hostToken = token
		r.hostLastSeen = time.Now()
	})
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

// Subscribe registers a live-update listener for the given token and returns
// the wake-up channel plus an unsubscribe function.
func (r *Room) Subscribe(token string) (<-chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	r.mu.Lock()
	r.subscribers[ch] = token
	r.tokenConns[token]++
	if token == r.hostToken {
		r.hostLastSeen = time.Now()
	}
	if playerID, ok := r.members[token]; ok {
		r.online[playerID]++
	}
	r.touch()
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
	}
}

// notifyPresence bumps the version so rosters can re-render online markers.
func (r *Room) notifyPresence() {
	r.Do(func() {})
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

// ClearTurnClock resets the clock without reading it (topic redraw, reset).
func (r *Room) ClearTurnClock() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.turnStarted = time.Time{}
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
	return room, nil
}

// Remove deletes a room.
func (m *Manager) Remove(code string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.rooms, code)
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
		room.mu.Unlock()
		if idle {
			delete(m.rooms, code)
		}
	}
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
