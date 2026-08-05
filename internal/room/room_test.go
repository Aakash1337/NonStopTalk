package room

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Aakash1337/NonStopTalk/internal/game"
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

func TestLiveSubscriberDoesNotPreventIdleRoomExpiry(t *testing.T) {
	manager := NewManager()
	stale, err := manager.Create("host")
	if err != nil {
		t.Fatal(err)
	}
	_, unsubscribe, err := stale.Subscribe("host")
	if err != nil {
		t.Fatal(err)
	}
	stale.mu.Lock()
	stale.lastActive = time.Now().Add(-idleTTL - time.Minute)
	stale.mu.Unlock()

	if _, err := manager.Create("another-host"); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Get(stale.Code); err != ErrRoomNotFound {
		t.Fatalf("expected connected but idle room to expire, got %v", err)
	}
	select {
	case <-stale.Done():
	default:
		t.Fatal("expected room expiration to stop live streams")
	}
	unsubscribe()
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

	ch, unsubscribe, err := r.Subscribe("token-a")
	if err != nil {
		t.Fatal(err)
	}
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

func TestSubscriberLimit(t *testing.T) {
	manager := NewManager()
	r, err := manager.Create("host")
	if err != nil {
		t.Fatal(err)
	}
	unsubscribes := make([]func(), 0, MaxSubscribers)
	for i := 0; i < MaxSubscribers; i++ {
		token := fmt.Sprintf("viewer-%d", i)
		r.BindMember(token, fmt.Sprintf("p%d", i))
		_, unsubscribe, err := r.Subscribe(token)
		if err != nil {
			t.Fatalf("subscriber %d unexpectedly rejected: %v", i, err)
		}
		unsubscribes = append(unsubscribes, unsubscribe)
	}
	r.BindMember("overflow", "p-overflow")
	if _, _, err := r.Subscribe("overflow"); err != ErrTooManySubscribers {
		t.Fatalf("expected ErrTooManySubscribers, got %v", err)
	}
	for _, unsubscribe := range unsubscribes {
		unsubscribe()
	}
}

func TestSubscriberRequiresMembershipAndCapsTabs(t *testing.T) {
	manager := NewManager()
	r, err := manager.Create("host")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.Subscribe("spectator"); err != ErrNotRoomMember {
		t.Fatalf("expected ErrNotRoomMember, got %v", err)
	}
	r.BindMember("member", "p1")
	unsubscribes := make([]func(), 0, MaxSubscribersPerToken)
	for i := 0; i < MaxSubscribersPerToken; i++ {
		_, unsubscribe, err := r.Subscribe("member")
		if err != nil {
			t.Fatalf("member stream %d rejected: %v", i, err)
		}
		unsubscribes = append(unsubscribes, unsubscribe)
	}
	if _, _, err := r.Subscribe("member"); err != ErrTooManyTokenStreams {
		t.Fatalf("expected ErrTooManyTokenStreams, got %v", err)
	}
	for _, unsubscribe := range unsubscribes {
		unsubscribe()
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

func TestTurnClockActionsAreScopedToTurnID(t *testing.T) {
	manager := NewManager()
	r, err := manager.Create("host")
	if err != nil {
		t.Fatal(err)
	}
	turnID := ""
	var setupErr error
	r.Do(func() {
		r.Session.AddPlayer("Avery")
		r.Session.AddPlayer("Blair")
		r.Session.SetTopics([]string{"A topic"})
		setupErr = r.Session.Start()
		if setupErr != nil {
			return
		}
		turn, err := r.Session.StartTurn()
		if err != nil {
			setupErr = err
			return
		}
		turnID = turn.ID
	})
	if setupErr != nil {
		t.Fatal(setupErr)
	}
	if !r.BeginTurnFor(turnID) || !r.TurnRunning() {
		t.Fatal("expected matching turn to start its clock")
	}
	if r.BeginTurnFor("stale-turn") {
		t.Fatal("expected stale begin to be rejected")
	}
	if _, matched := r.EndTurnClockFor("stale-turn"); matched || !r.TurnRunning() {
		t.Fatal("expected stale end to leave the current clock running")
	}
	if _, matched := r.EndTurnClockFor(turnID); !matched || r.TurnRunning() {
		t.Fatal("expected matching end to stop the clock")
	}
	if !r.BeginTurnFor(turnID) {
		t.Fatal("expected matching turn to restart its clock")
	}
	if r.ClearTurnClockFor("stale-turn") || !r.TurnRunning() {
		t.Fatal("expected stale clear to leave the clock running")
	}
	if !r.ClearTurnClockFor(turnID) || r.TurnRunning() {
		t.Fatal("expected matching clear to stop the clock")
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

func TestPersistenceReconcilesPendingAIReview(t *testing.T) {
	manager := NewManager()
	created, err := manager.Create("host-token")
	if err != nil {
		t.Fatal(err)
	}
	var setupErr error
	created.Do(func() {
		created.Session.AddPlayer("Avery")
		created.Session.AddPlayer("Blair")
		created.Session.SetTopics([]string{"A topic"})
		setupErr = created.Session.Start()
		if setupErr != nil {
			return
		}
		if _, err := created.Session.StartTurn(); err != nil {
			setupErr = err
			return
		}
		if _, err := created.Session.SubmitTurn(5, false, false); err != nil {
			setupErr = err
			return
		}
		index := created.Session.MarkTurnAIPending()
		created.Session.CompletedTurns[index].Score += 10
		created.Session.Players[0].Score += 10
	})
	if setupErr != nil {
		t.Fatal(setupErr)
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
	turn := r.Session.CompletedTurns[0]
	if turn.AIStatus != game.AIStatusFailed || turn.Score != 5 || turn.AIRelevance != nil {
		t.Fatalf("expected pending review reconciled to classic scoring, got %+v", turn)
	}
	if r.Session.Players[0].Score != 5 {
		t.Fatalf("expected player score repaired to 5, got %d", r.Session.Players[0].Score)
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
	_, unsubscribe, err := r.Subscribe("guest-token")
	if err != nil {
		t.Fatal(err)
	}
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

func TestHostMutationsAndClaimsAreAtomic(t *testing.T) {
	manager := NewManager()
	r, err := manager.Create("original-host")
	if err != nil {
		t.Fatal(err)
	}
	r.BindMember("claimant-a", "p1")
	r.BindMember("claimant-b", "p2")

	r.mu.Lock()
	r.hostLastSeen = time.Now().Add(-2 * time.Hour)
	r.mu.Unlock()
	start := make(chan struct{})
	results := make(chan bool, 2)
	var wg sync.WaitGroup
	for _, token := range []string{"claimant-a", "claimant-b"} {
		wg.Add(1)
		go func(token string) {
			defer wg.Done()
			<-start
			results <- r.ClaimHost(token, time.Hour)
		}(token)
	}
	close(start)
	wg.Wait()
	close(results)
	winners := 0
	for result := range results {
		if result {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("expected exactly one concurrent claimant, got %d", winners)
	}
	if r.DoAsHost("original-host", func() { t.Error("former host mutation ran") }) {
		t.Fatal("expected former host authorization to fail")
	}
}

func TestNewestTopicGenerationWins(t *testing.T) {
	manager := NewManager()
	r, err := manager.Create("host")
	if err != nil {
		t.Fatal(err)
	}
	first, ok := r.BeginTopicGeneration("host")
	if !ok {
		t.Fatal("expected host generation to start")
	}
	second, ok := r.BeginTopicGeneration("host")
	if !ok || second <= first {
		t.Fatalf("expected increasing generation, first=%d second=%d", first, second)
	}
	if r.ApplyTopicGeneration("host", first, func() { t.Error("stale generation applied") }) {
		t.Fatal("expected older topic response to be rejected")
	}
	applied := false
	if !r.ApplyTopicGeneration("host", second, func() { applied = true }) || !applied {
		t.Fatal("expected newest topic response to apply")
	}
	third, ok := r.BeginTopicGeneration("host")
	if !ok {
		t.Fatal("expected another host generation to start")
	}
	r.DoAsHost("host", func() { r.InvalidateTopicGenerationLocked() })
	if r.ApplyTopicGeneration("host", third, func() { t.Error("manually superseded generation applied") }) {
		t.Fatal("expected a manual topic choice to invalidate the pending response")
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
