package room

import (
	"strings"
	"testing"
	"time"
)

func TestCreateAndGetRoom(t *testing.T) {
	manager := NewManager()
	created, err := manager.Create("host-token")
	if err != nil {
		t.Fatal(err)
	}
	if len(created.Code) != CodeLength {
		t.Fatalf("expected %d-char code, got %q", CodeLength, created.Code)
	}
	for _, r := range created.Code {
		if !strings.ContainsRune(codeAlphabet, r) {
			t.Fatalf("code %q contains invalid character %q", created.Code, r)
		}
	}
	if created.Session == nil {
		t.Fatal("expected room to own a session")
	}

	got, err := manager.Get(created.Code)
	if err != nil || got != created {
		t.Fatalf("expected to fetch created room, got %v %v", got, err)
	}
	if _, err := manager.Get("NOPE99"); err != ErrRoomNotFound {
		t.Fatalf("expected ErrRoomNotFound, got %v", err)
	}
}

func TestRoomCapacityLimit(t *testing.T) {
	manager := NewManager()
	for i := 0; i < MaxRooms; i++ {
		if _, err := manager.Create("host"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := manager.Create("host"); err != ErrTooManyRooms {
		t.Fatalf("expected ErrTooManyRooms, got %v", err)
	}
}

func TestIdleRoomsAreCleanedUp(t *testing.T) {
	manager := NewManager()
	stale, err := manager.Create("host")
	if err != nil {
		t.Fatal(err)
	}
	stale.mu.Lock()
	stale.lastActive = time.Now().Add(-idleTTL - time.Minute)
	stale.mu.Unlock()

	// Creating another room triggers cleanup.
	if _, err := manager.Create("host"); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Get(stale.Code); err != ErrRoomNotFound {
		t.Fatalf("expected stale room to be removed, got %v", err)
	}
}

func TestMembersAndPresence(t *testing.T) {
	manager := NewManager()
	r, err := manager.Create("host")
	if err != nil {
		t.Fatal(err)
	}
	r.BindMember("token-a", "p1")
	if id, ok := r.MemberPlayerID("token-a"); !ok || id != "p1" {
		t.Fatalf("expected member binding, got %q %v", id, ok)
	}

	ch, unsubscribe := r.Subscribe("token-a")
	if !r.OnlinePlayers()["p1"] {
		t.Fatal("expected p1 to be online after subscribe")
	}

	before := r.Version()
	r.Do(func() {})
	if r.Version() <= before {
		t.Fatal("expected version to advance on Do")
	}
	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatal("expected subscriber wake-up after Do")
	}

	unsubscribe()
	if r.OnlinePlayers()["p1"] {
		t.Fatal("expected p1 offline after unsubscribe")
	}
}

func TestTurnClock(t *testing.T) {
	manager := NewManager()
	r, err := manager.Create("host")
	if err != nil {
		t.Fatal(err)
	}
	if r.TurnRunning() {
		t.Fatal("expected clock stopped initially")
	}
	if elapsed := r.EndTurnClock(); elapsed != -1 {
		t.Fatalf("expected -1 for never-started clock, got %d", elapsed)
	}

	r.BeginTurn()
	first := r.TurnElapsedSeconds()
	if !r.TurnRunning() || first < 0 {
		t.Fatal("expected clock running after BeginTurn")
	}
	// A duplicate begin must not restart the clock.
	r.mu.Lock()
	r.turnStarted = r.turnStarted.Add(-5 * time.Second)
	r.mu.Unlock()
	r.BeginTurn()
	if got := r.TurnElapsedSeconds(); got < 5 {
		t.Fatalf("expected duplicate BeginTurn to keep the clock, got %ds", got)
	}

	if elapsed := r.EndTurnClock(); elapsed < 5 {
		t.Fatalf("expected elapsed >= 5, got %d", elapsed)
	}
	if r.TurnRunning() {
		t.Fatal("expected clock cleared after EndTurnClock")
	}
}

func TestNewTokenAndCodeAreRandom(t *testing.T) {
	tokenA, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	tokenB, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if tokenA == tokenB || len(tokenA) != 64 {
		t.Fatalf("expected distinct 64-char tokens, got %q %q", tokenA, tokenB)
	}
}
