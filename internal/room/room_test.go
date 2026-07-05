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

func TestPersistenceRoundTrip(t *testing.T) {
	manager := NewManager()
	created, err := manager.Create("host-token")
	if err != nil {
		t.Fatal(err)
	}
	created.Do(func() {
		created.Session.AddPlayer("Avery")
		created.Session.AddPlayer("Blair")
		created.Session.SetTopics([]string{"Topic one"})
		created.BindMemberLocked("guest-token", "p2")
	})
	if _, err := created.Session.StartTurn(); err != nil {
		t.Fatal(err)
	}

	path := t.TempDir() + "/rooms.json"
	if err := manager.SaveTo(path); err != nil {
		t.Fatal(err)
	}

	restored := NewManager()
	if err := restored.LoadFrom(path); err != nil {
		t.Fatal(err)
	}
	r, err := restored.Get(created.Code)
	if err != nil {
		t.Fatal(err)
	}
	if !r.IsHost("host-token") {
		t.Fatal("expected host token restored")
	}
	if id, ok := r.MemberPlayerID("guest-token"); !ok || id != "p2" {
		t.Fatalf("expected member binding restored, got %q %v", id, ok)
	}
	if len(r.Session.Players) != 2 || r.Session.ActiveTurn == nil {
		t.Fatalf("expected session state restored, got %+v", r.Session)
	}
	// New players after a restore must not reuse old IDs.
	player := r.Session.AddPlayer("Casey")
	if player.ID == "p1" || player.ID == "p2" {
		t.Fatalf("expected fresh player ID, got %s", player.ID)
	}

	// Loading a missing file is not an error.
	if err := NewManager().LoadFrom(path + ".missing"); err != nil {
		t.Fatal(err)
	}
}

func TestLoadSkipsExpiredRooms(t *testing.T) {
	manager := NewManager()
	stale, err := manager.Create("host")
	if err != nil {
		t.Fatal(err)
	}
	stale.mu.Lock()
	stale.lastActive = time.Now().Add(-idleTTL - time.Hour)
	stale.mu.Unlock()

	path := t.TempDir() + "/rooms.json"
	if err := manager.SaveTo(path); err != nil {
		t.Fatal(err)
	}
	restored := NewManager()
	if err := restored.LoadFrom(path); err != nil {
		t.Fatal(err)
	}
	if restored.Count() != 0 {
		t.Fatalf("expected expired room skipped, got %d rooms", restored.Count())
	}
}

func TestHostTransferAndPresence(t *testing.T) {
	manager := NewManager()
	r, err := manager.Create("host-token")
	if err != nil {
		t.Fatal(err)
	}
	if r.HostOfflineFor() != 0 && r.HostOfflineFor() > time.Second {
		t.Fatalf("expected freshly created host to look present, offline for %v", r.HostOfflineFor())
	}

	r.BindMember("guest-token", "p2")
	if token, ok := r.TokenForPlayer("p2"); !ok || token != "guest-token" {
		t.Fatalf("expected token lookup, got %q %v", token, ok)
	}

	r.TransferHostTo("guest-token")
	if !r.IsHost("guest-token") || r.IsHost("host-token") {
		t.Fatal("expected host transfer")
	}
	if r.HostPlayerID() != "p2" {
		t.Fatalf("expected host seat p2, got %q", r.HostPlayerID())
	}

	// A live connection keeps the host "present" regardless of timestamps.
	_, unsubscribe := r.Subscribe("guest-token")
	r.mu.Lock()
	r.hostLastSeen = time.Now().Add(-time.Hour)
	r.mu.Unlock()
	if r.HostOfflineFor() != 0 {
		t.Fatalf("expected connected host to be present, offline for %v", r.HostOfflineFor())
	}
	unsubscribe()
	r.mu.Lock()
	r.hostLastSeen = time.Now().Add(-time.Hour)
	r.mu.Unlock()
	if r.HostOfflineFor() < time.Hour {
		t.Fatalf("expected host offline for an hour, got %v", r.HostOfflineFor())
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
