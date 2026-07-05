package room

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"time"

	"dontstoptalking/internal/game"
)

// roomSnapshot is the durable part of a room. Live connections, presence,
// and the in-flight turn clock are transient and rebuilt after a restart.
type roomSnapshot struct {
	Code      string            `json:"code"`
	HostToken string            `json:"hostToken"`
	Members   map[string]string `json:"members"`
	// Session is pre-marshaled under the room lock so a concurrent turn
	// cannot mutate it mid-encode.
	Session    json.RawMessage `json:"session"`
	LastActive time.Time       `json:"lastActive"`
}

type managerSnapshot struct {
	Rooms   []roomSnapshot `json:"rooms"`
	SavedAt time.Time      `json:"savedAt"`
}

// SaveTo writes every room to path atomically (temp file + rename).
func (m *Manager) SaveTo(path string) error {
	m.mu.Lock()
	snapshot := managerSnapshot{SavedAt: time.Now()}
	var encodeErr error
	for _, r := range m.rooms {
		r.mu.Lock()
		sessionJSON, err := json.Marshal(r.Session)
		if err != nil {
			encodeErr = err
			r.mu.Unlock()
			continue
		}
		members := make(map[string]string, len(r.members))
		for token, playerID := range r.members {
			members[token] = playerID
		}
		snapshot.Rooms = append(snapshot.Rooms, roomSnapshot{
			Code:       r.Code,
			HostToken:  r.hostToken,
			Members:    members,
			Session:    sessionJSON,
			LastActive: r.lastActive,
		})
		r.mu.Unlock()
	}
	m.mu.Unlock()
	if encodeErr != nil {
		return encodeErr
	}

	data, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// LoadFrom restores rooms saved by SaveTo, skipping rooms already idle past
// the TTL. A missing file is not an error.
func (m *Manager) LoadFrom(path string) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var snapshot managerSnapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return err
	}

	cutoff := time.Now().Add(-idleTTL)
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, saved := range snapshot.Rooms {
		if saved.Code == "" || len(saved.Session) == 0 || saved.LastActive.Before(cutoff) {
			continue
		}
		if _, exists := m.rooms[saved.Code]; exists || len(m.rooms) >= MaxRooms {
			continue
		}
		session := &game.Session{}
		if err := json.Unmarshal(saved.Session, session); err != nil {
			continue
		}
		members := saved.Members
		if members == nil {
			members = map[string]string{}
		}
		m.rooms[saved.Code] = &Room{
			Code:         saved.Code,
			Session:      session,
			hostToken:    saved.HostToken,
			hostLastSeen: time.Now(),
			members:      members,
			subscribers:  map[chan struct{}]string{},
			online:       map[string]int{},
			tokenConns:   map[string]int{},
			lastActive:   saved.LastActive,
		}
	}
	return nil
}

// StartAutosave persists the manager to path on an interval for the lifetime
// of the process. Failures are logged, never fatal: play continues in memory.
func (m *Manager) StartAutosave(path string, interval time.Duration) {
	go func() {
		for {
			time.Sleep(interval)
			if err := m.SaveTo(path); err != nil {
				log.Printf("room autosave failed: %v", err)
			}
		}
	}()
}
