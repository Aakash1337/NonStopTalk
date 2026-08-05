package game

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestClassicScoreAwardsCompletionBonus(t *testing.T) {
	score := Score(ScoreInput{
		DurationSeconds: 60,
		SpokenSeconds:   60,
		Completed:       true,
	})

	if score != 85 {
		t.Fatalf("expected 85, got %d", score)
	}
}

func TestScorePartsExplainClassicScore(t *testing.T) {
	parts := ScoreParts(ScoreInput{
		DurationSeconds: 60,
		SpokenSeconds:   60,
		Completed:       true,
	})

	if len(parts) != 2 {
		t.Fatalf("expected 2 score parts, got %d", len(parts))
	}
	if parts[0].Label != "Speaking time" || parts[0].Points != 60 {
		t.Fatalf("unexpected speaking part: %#v", parts[0])
	}
	if parts[1].Label != "Completion bonus" || parts[1].Points != CompletionBonus {
		t.Fatalf("unexpected completion part: %#v", parts[1])
	}
}

func TestAIRelevanceBonusRoundsToNearestPoint(t *testing.T) {
	relevance := 0.53 // 10.6 bonus points rounds to 11.
	input := ScoreInput{
		DurationSeconds:  60,
		SpokenSeconds:    5,
		AIRelevanceScore: &relevance,
	}
	if got := Score(input); got != 16 {
		t.Fatalf("expected 5 classic + 11 rounded AI points, got %d", got)
	}
	parts := ScoreParts(input)
	if len(parts) != 2 || parts[1].Label != "AI relevance" || parts[1].Points != 11 {
		t.Fatalf("expected score parts to use the same rounded bonus, got %+v", parts)
	}
}

func TestSessionCompletesAfterAllPlayersAndRounds(t *testing.T) {
	session := NewSession("test")
	session.AddPlayer("Avery")
	session.AddPlayer("Blair")
	session.SetTopics([]string{"Topic one", "Topic two"})
	session.UpdateSettings(Settings{
		SpeakingDurationSeconds: 10,
		SilenceTimeoutSeconds:   2,
		Rounds:                  1,
		TopicPackID:             "test",
	})

	if err := session.Start(); err != nil {
		t.Fatal(err)
	}
	if _, err := session.StartTurn(); err != nil {
		t.Fatal(err)
	}
	if _, err := session.SubmitTurn(10, true, false); err != nil {
		t.Fatal(err)
	}
	if session.Finished {
		t.Fatal("game finished after one player")
	}
	if _, err := session.StartTurn(); err != nil {
		t.Fatal(err)
	}
	if _, err := session.SubmitTurn(7, false, true); err != nil {
		t.Fatal(err)
	}
	if !session.Finished {
		t.Fatal("expected game to be finished")
	}
}

func TestRenameAndMovePlayer(t *testing.T) {
	session := NewSession("test")
	avery := session.AddPlayer("Avery")
	blair := session.AddPlayer("Blair")
	casey := session.AddPlayer("Casey")

	if !session.RenamePlayer(blair.ID, "Bea") {
		t.Fatal("expected rename to succeed")
	}
	if session.Players[1].Name != "Bea" {
		t.Fatalf("expected renamed player, got %q", session.Players[1].Name)
	}

	if !session.MovePlayer(casey.ID, -1) {
		t.Fatal("expected move to succeed")
	}
	if session.Players[0].ID != avery.ID || session.Players[1].ID != casey.ID || session.Players[2].ID != blair.ID {
		t.Fatalf("unexpected order: %#v", session.Players)
	}

	if session.MovePlayer(avery.ID, -1) {
		t.Fatal("expected first player to stay in place")
	}
}

func TestRemovePlayerKeepsTurnOrder(t *testing.T) {
	session := NewSession("test")
	avery := session.AddPlayer("Avery")
	blair := session.AddPlayer("Blair")
	casey := session.AddPlayer("Casey")
	session.SetTopics([]string{"Topic one"})

	if _, err := session.StartTurn(); err != nil {
		t.Fatal(err)
	}
	if _, err := session.SubmitTurn(5, false, true); err != nil {
		t.Fatal(err)
	}

	// Blair is up next. Removing Avery (earlier in the list) must not skip Blair.
	session.RemovePlayer(avery.ID)
	turn, err := session.StartTurn()
	if err != nil {
		t.Fatal(err)
	}
	if turn.PlayerID != blair.ID {
		t.Fatalf("expected %s to keep the next turn, got %s", blair.ID, turn.PlayerID)
	}
	if _, err := session.SubmitTurn(5, false, true); err != nil {
		t.Fatal(err)
	}
	turn, err = session.StartTurn()
	if err != nil {
		t.Fatal(err)
	}
	if turn.PlayerID != casey.ID {
		t.Fatalf("expected %s after Blair, got %s", casey.ID, turn.PlayerID)
	}
}

func TestRemoveActivePlayerClearsTurn(t *testing.T) {
	session := NewSession("test")
	avery := session.AddPlayer("Avery")
	blair := session.AddPlayer("Blair")
	session.SetTopics([]string{"Topic one"})

	if _, err := session.StartTurn(); err != nil {
		t.Fatal(err)
	}
	session.RemovePlayer(avery.ID)
	if session.ActiveTurn != nil {
		t.Fatal("expected active turn to be cleared when its player is removed")
	}
	turn, err := session.StartTurn()
	if err != nil {
		t.Fatal(err)
	}
	if turn.PlayerID != blair.ID {
		t.Fatalf("expected %s to take over, got %s", blair.ID, turn.PlayerID)
	}
}

func TestStartTurnReturnsExistingActiveTurn(t *testing.T) {
	session := NewSession("test")
	session.AddPlayer("Avery")
	session.AddPlayer("Blair")
	session.SetTopics([]string{"Topic one", "Topic two"})

	first, err := session.StartTurn()
	if err != nil {
		t.Fatal(err)
	}
	second, err := session.StartTurn()
	if err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatal("expected duplicate start to return the existing turn")
	}
	if first.ID == "" || second.ID != first.ID {
		t.Fatalf("expected duplicate start to preserve turn ID, got %q and %q", first.ID, second.ID)
	}
	if session.TopicCursor != 1 {
		t.Fatalf("expected topic cursor to advance once, got %d", session.TopicCursor)
	}
}

func TestResetForNewGameKeepsRoster(t *testing.T) {
	session := NewSession("test")
	avery := session.AddPlayer("Avery")
	session.AddPlayer("Blair")
	session.SetTopics([]string{"Topic one"})

	if _, err := session.StartTurn(); err != nil {
		t.Fatal(err)
	}
	if _, err := session.SubmitTurn(5, false, true); err != nil {
		t.Fatal(err)
	}

	session.ResetForNewGame()
	if session.Started || session.Finished {
		t.Fatal("expected fresh game state")
	}
	if len(session.Players) != 2 || session.Players[0].ID != avery.ID {
		t.Fatalf("expected roster preserved, got %#v", session.Players)
	}
	if session.Players[0].Score != 0 {
		t.Fatalf("expected scores cleared, got %d", session.Players[0].Score)
	}
	if len(session.CompletedTurns) != 0 || session.ActiveTurn != nil {
		t.Fatal("expected turns cleared")
	}
	if len(session.Topics) != 1 {
		t.Fatalf("expected topics preserved, got %d", len(session.Topics))
	}
}

func TestInputLimits(t *testing.T) {
	session := NewSession("test")
	long := strings.Repeat("x", MaxPlayerNameLength+20)
	player := session.AddPlayer(long)
	if len([]rune(player.Name)) > MaxPlayerNameLength {
		t.Fatalf("expected player name capped, got %d runes", len([]rune(player.Name)))
	}

	topics := make([]string, MaxTopics+50)
	for i := range topics {
		topics[i] = "Topic " + itoa(i) + " " + strings.Repeat("y", MaxTopicLength)
	}
	session.SetTopics(topics)
	if len(session.Topics) != MaxTopics {
		t.Fatalf("expected topic count capped at %d, got %d", MaxTopics, len(session.Topics))
	}
	for _, topic := range session.Topics {
		if len([]rune(topic)) > MaxTopicLength {
			t.Fatalf("expected topic capped at %d runes, got %d", MaxTopicLength, len([]rune(topic)))
		}
	}
}

func TestFinishedGamesAreArchivedToHistory(t *testing.T) {
	session := NewSession("test")
	session.AddPlayer("Avery")
	session.AddPlayer("Blair")
	session.SetTopics([]string{"Topic one"})

	playGame := func() {
		for !session.Finished {
			if _, err := session.StartTurn(); err != nil {
				t.Fatal(err)
			}
			if _, err := session.SubmitTurn(10, false, false); err != nil {
				t.Fatal(err)
			}
		}
	}

	playGame()
	session.ResetForNewGame()
	if len(session.History) != 1 {
		t.Fatalf("expected one archived game, got %d", len(session.History))
	}
	record := session.History[0]
	if record.Turns != 2 || len(record.Standings) != 2 {
		t.Fatalf("unexpected record: %+v", record)
	}
	if record.FinishedAt.IsZero() {
		t.Fatal("expected a finish time")
	}

	// Starting a new game directly from the winner screen archives too.
	playGame()
	if err := session.Start(); err != nil {
		t.Fatal(err)
	}
	if len(session.History) != 2 {
		t.Fatalf("expected two archived games, got %d", len(session.History))
	}

	// Resetting an unfinished game archives nothing.
	session.ResetForNewGame()
	if len(session.History) != 2 {
		t.Fatalf("expected reset of fresh game to archive nothing, got %d", len(session.History))
	}

	// History is capped.
	for i := 0; i < MaxHistory+5; i++ {
		playGame()
		session.ResetForNewGame()
	}
	if len(session.History) != MaxHistory {
		t.Fatalf("expected history capped at %d, got %d", MaxHistory, len(session.History))
	}
}

func TestResolveTurnAIAppliesBonus(t *testing.T) {
	session := NewSession("test")
	avery := session.AddPlayer("Avery")
	session.AddPlayer("Blair")
	session.SetTopics([]string{"Topic one"})

	if _, err := session.StartTurn(); err != nil {
		t.Fatal(err)
	}
	turn, err := session.SubmitTurn(30, false, false)
	if err != nil {
		t.Fatal(err)
	}
	index := session.MarkTurnAIPending()
	if index != 0 || session.CompletedTurns[0].AIStatus != AIStatusPending {
		t.Fatalf("expected pending AI status on turn 0, got %d %q", index, session.CompletedTurns[0].AIStatus)
	}

	relevance := 0.8
	confidence := 0.9
	if !session.ResolveTurnAI(index, turn.ID, &relevance, &confidence, "Nice focus.", AIStatusDone) {
		t.Fatal("expected verdict to apply")
	}
	graded := session.CompletedTurns[0]
	if graded.Score != 30+16 {
		t.Fatalf("expected 46 points after bonus, got %d", graded.Score)
	}
	if session.Players[0].ID != avery.ID || session.Players[0].Score != 46 {
		t.Fatalf("expected player score 46, got %d", session.Players[0].Score)
	}
	if graded.AIFeedback != "Nice focus." || graded.AIStatus != AIStatusDone {
		t.Fatalf("unexpected AI fields: %+v", graded)
	}

	parts := graded.ScoreParts()
	foundAI := false
	for _, part := range parts {
		if part.Label == "AI relevance" && part.Points == 16 {
			foundAI = true
		}
	}
	if !foundAI {
		t.Fatalf("expected AI relevance part, got %+v", parts)
	}
}

func TestResolveTurnAIRejectsStaleVerdicts(t *testing.T) {
	session := NewSession("test")
	session.AddPlayer("Avery")
	session.AddPlayer("Blair")
	session.SetTopics([]string{"Topic one"})

	if _, err := session.StartTurn(); err != nil {
		t.Fatal(err)
	}
	turn, err := session.SubmitTurn(10, false, false)
	if err != nil {
		t.Fatal(err)
	}
	index := session.MarkTurnAIPending()

	relevance := 1.0
	if session.ResolveTurnAI(index, "wrong-turn-id", &relevance, nil, "x", AIStatusDone) {
		t.Fatal("expected mismatched turn ID to be rejected")
	}
	session.ResetForNewGame()
	if _, err := session.StartTurn(); err != nil {
		t.Fatal(err)
	}
	newTurn, err := session.SubmitTurn(10, false, false)
	if err != nil {
		t.Fatal(err)
	}
	newIndex := session.MarkTurnAIPending()
	if newIndex != index || newTurn.PlayerID != turn.PlayerID || newTurn.Topic != turn.Topic {
		t.Fatalf("test requires reused index/player/topic, old=%+v new=%+v", turn, newTurn)
	}
	if newTurn.ID == turn.ID {
		t.Fatalf("expected reset turn to get a new ID, both were %q", turn.ID)
	}
	if session.ResolveTurnAI(newIndex, turn.ID, &relevance, nil, "stale", AIStatusDone) {
		t.Fatal("expected old-game verdict to be rejected for the reused slot")
	}
	if !session.ResolveTurnAI(newIndex, newTurn.ID, &relevance, nil, "current", AIStatusDone) {
		t.Fatal("expected current turn verdict to apply")
	}
}

func TestRedrawActiveTurnAdvancesTopic(t *testing.T) {
	session := NewSession("test")
	session.AddPlayer("Avery")
	session.AddPlayer("Blair")
	session.SetTopics([]string{"Topic one", "Topic two", "Topic three"})

	turn, err := session.StartTurn()
	if err != nil {
		t.Fatal(err)
	}
	firstTopic := turn.Topic
	firstID := turn.ID

	redrawn, err := session.RedrawActiveTurn()
	if err != nil {
		t.Fatal(err)
	}
	if redrawn.Topic == firstTopic {
		t.Fatalf("expected redraw to consume a different topic, got %q twice", redrawn.Topic)
	}
	if redrawn.ID == firstID {
		t.Fatalf("expected redraw to rotate the turn ID, got %q twice", redrawn.ID)
	}
	if session.TopicCursor != 2 {
		t.Fatalf("expected topic cursor to advance, got %d", session.TopicCursor)
	}
}

func TestTopicDeckUsesEveryTopicBeforeRepeating(t *testing.T) {
	session := NewSession("test")
	source := []string{"Alpha", "Bravo", "Charlie", "Delta"}
	session.SetTopics(source)
	wantSourceOrder := slices.Clone(session.Topics)

	lastIndex := -1
	for cycle := 0; cycle < 3; cycle++ {
		seen := make(map[int]bool, len(source))
		for draw := 0; draw < len(source); draw++ {
			index, err := session.drawTopic()
			if err != nil {
				t.Fatal(err)
			}
			if draw == 0 && cycle > 0 && index == lastIndex {
				t.Fatalf("cycle %d immediately repeated topic index %d", cycle, index)
			}
			if seen[index] {
				t.Fatalf("cycle %d repeated topic index %d before exhaustion", cycle, index)
			}
			seen[index] = true
			lastIndex = index
		}
		if len(seen) != len(source) {
			t.Fatalf("cycle %d used %d of %d topics", cycle, len(seen), len(source))
		}
	}

	if !slices.Equal(session.Topics, wantSourceOrder) {
		t.Fatalf("drawing shuffled topics reordered source: got %v want %v", session.Topics, wantSourceOrder)
	}
	if session.TopicCursor != 3*len(source) {
		t.Fatalf("expected %d total draws, got %d", 3*len(source), session.TopicCursor)
	}
}

func TestOneTopicDeckRepeatsOnlyAfterExhaustion(t *testing.T) {
	session := NewSession("test")
	session.SetTopics([]string{"Only topic"})
	for draw := 0; draw < 3; draw++ {
		index, err := session.drawTopic()
		if err != nil {
			t.Fatal(err)
		}
		if index != 0 {
			t.Fatalf("expected the sole topic, got index %d", index)
		}
	}
}

func TestTopicDeckProgressSurvivesSerialization(t *testing.T) {
	session := NewSession("test")
	session.SetTopics([]string{"Alpha", "Bravo", "Charlie", "Delta"})
	for draw := 0; draw < 2; draw++ {
		if _, err := session.drawTopic(); err != nil {
			t.Fatal(err)
		}
	}

	data, err := json.Marshal(session)
	if err != nil {
		t.Fatal(err)
	}
	var restored Session
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(restored.TopicDeck, session.TopicDeck) || restored.TopicDeckCursor != session.TopicDeckCursor {
		t.Fatalf("deck progress was not persisted: before=%v/%d after=%v/%d",
			session.TopicDeck, session.TopicDeckCursor, restored.TopicDeck, restored.TopicDeckCursor)
	}

	// The unconsumed part of the current deck must be identical after restore.
	remaining := len(session.TopicDeck) - session.TopicDeckCursor
	for draw := 0; draw < remaining; draw++ {
		want, err := session.drawTopic()
		if err != nil {
			t.Fatal(err)
		}
		got, err := restored.drawTopic()
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("restored deck diverged at remaining draw %d: got %d want %d", draw, got, want)
		}
	}
}

func TestTurnIDsAreUniqueAcrossSerializationAndReset(t *testing.T) {
	session := NewSession("test")
	session.AddPlayer("Avery")
	session.AddPlayer("Blair")
	session.SetTopics([]string{"Topic one"})

	first, err := session.StartTurn()
	if err != nil {
		t.Fatal(err)
	}
	firstID := first.ID
	if firstID == "" {
		t.Fatal("expected first turn to have an ID")
	}
	if _, err := session.SubmitTurn(5, false, false); err != nil {
		t.Fatal(err)
	}

	data, err := json.Marshal(session)
	if err != nil {
		t.Fatal(err)
	}
	var restored Session
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatal(err)
	}
	second, err := restored.StartTurn()
	if err != nil {
		t.Fatal(err)
	}
	if second.ID == "" || second.ID == firstID {
		t.Fatalf("expected a new persisted turn ID, first=%q second=%q", firstID, second.ID)
	}
	secondID := second.ID
	if _, err := restored.SubmitTurn(5, false, false); err != nil {
		t.Fatal(err)
	}
	restored.ResetForNewGame()
	third, err := restored.StartTurn()
	if err != nil {
		t.Fatal(err)
	}
	if third.ID == firstID || third.ID == secondID {
		t.Fatalf("reset reused a turn ID: first=%q second=%q third=%q", firstID, secondID, third.ID)
	}
}

func TestTurnIDCounterRepairsAStalePersistedCounter(t *testing.T) {
	session := NewSession("test")
	session.AddPlayer("Avery")
	session.AddPlayer("Blair")
	session.SetTopics([]string{"Topic one"})
	session.CompletedTurns = []Turn{{ID: "t41"}}
	session.NextTurnNumber = 0

	turn, err := session.StartTurn()
	if err != nil {
		t.Fatal(err)
	}
	if turn.ID != "t42" {
		t.Fatalf("expected repaired counter to allocate t42, got %q", turn.ID)
	}
}

func TestResolveTurnAIIsExactlyOnce(t *testing.T) {
	session := NewSession("test")
	player := session.AddPlayer("Avery")
	session.AddPlayer("Blair")
	session.SetTopics([]string{"Topic one"})
	if _, err := session.StartTurn(); err != nil {
		t.Fatal(err)
	}
	turn, err := session.SubmitTurn(20, false, false)
	if err != nil {
		t.Fatal(err)
	}
	index := session.MarkTurnAIPending()
	relevance := 0.53
	if !session.ResolveTurnAI(index, turn.ID, &relevance, nil, "First verdict", AIStatusDone) {
		t.Fatal("expected first verdict to apply")
	}
	if session.CompletedTurns[index].Score != 31 || session.Players[0].ID != player.ID || session.Players[0].Score != 31 {
		t.Fatalf("expected one rounded 11-point bonus, turn=%+v player=%+v", session.CompletedTurns[index], session.Players[0])
	}
	if session.ResolveTurnAI(index, turn.ID, &relevance, nil, "Duplicate verdict", AIStatusDone) {
		t.Fatal("expected duplicate verdict to be rejected")
	}
	if session.CompletedTurns[index].Score != 31 || session.Players[0].Score != 31 {
		t.Fatal("duplicate verdict changed the score")
	}
	if got := session.MarkTurnAIPending(); got != -1 {
		t.Fatalf("expected resolved turn not to reopen, got index %d", got)
	}
}

func TestResolveTurnAIRequiresAValidTerminalOutcome(t *testing.T) {
	session := NewSession("test")
	session.AddPlayer("Avery")
	session.AddPlayer("Blair")
	session.SetTopics([]string{"Topic one"})
	if _, err := session.StartTurn(); err != nil {
		t.Fatal(err)
	}
	turn, err := session.SubmitTurn(10, false, false)
	if err != nil {
		t.Fatal(err)
	}
	index := session.MarkTurnAIPending()
	if session.ResolveTurnAI(index, turn.ID, nil, nil, "missing relevance", AIStatusDone) {
		t.Fatal("expected a done verdict without relevance to be rejected")
	}
	if session.ResolveTurnAI(index, turn.ID, nil, nil, "still pending", AIStatusPending) {
		t.Fatal("expected pending not to be accepted as a resolution")
	}
	if session.CompletedTurns[index].AIStatus != AIStatusPending {
		t.Fatal("invalid outcomes should leave the turn pending for a valid resolution")
	}
	if !session.ResolveTurnAI(index, turn.ID, nil, nil, "No transcript", AIStatusSkipped) {
		t.Fatal("expected skipped to resolve a pending turn")
	}
}

func TestReconcilePendingAIAfterRestartRestoresClassicScore(t *testing.T) {
	session := NewSession("test")
	session.AddPlayer("Avery")
	session.AddPlayer("Blair")
	session.SetTopics([]string{"Topic one"})
	if _, err := session.StartTurn(); err != nil {
		t.Fatal(err)
	}
	turn, err := session.SubmitTurn(20, false, false)
	if err != nil {
		t.Fatal(err)
	}
	index := session.MarkTurnAIPending()

	// Simulate an inconsistent persisted pending record to verify reconciliation
	// actively restores classic scoring, rather than changing only the label.
	relevance := 0.53
	confidence := 0.9
	session.CompletedTurns[index].AIRelevance = &relevance
	session.CompletedTurns[index].AIConfidence = &confidence
	session.CompletedTurns[index].Score += 11
	session.Players[0].Score += 11

	data, err := json.Marshal(session)
	if err != nil {
		t.Fatal(err)
	}
	var restored Session
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatal(err)
	}
	if got := restored.ReconcilePendingAI(); got != 1 {
		t.Fatalf("expected one reconciled turn, got %d", got)
	}
	reconciled := restored.CompletedTurns[index]
	if reconciled.ID != turn.ID || reconciled.AIStatus != AIStatusFailed {
		t.Fatalf("unexpected reconciled identity/status: %+v", reconciled)
	}
	if reconciled.Score != 20 || restored.Players[0].Score != 20 {
		t.Fatalf("expected classic scores restored, turn=%d player=%d", reconciled.Score, restored.Players[0].Score)
	}
	if reconciled.AIRelevance != nil || reconciled.AIConfidence != nil {
		t.Fatalf("expected stale AI values cleared, got %+v", reconciled)
	}
	if reconciled.AIFeedback != restoredPendingAIFeedback {
		t.Fatalf("unexpected reconciliation feedback %q", reconciled.AIFeedback)
	}
	if got := restored.ReconcilePendingAI(); got != 0 {
		t.Fatalf("expected reconciliation to be idempotent, got %d more", got)
	}
}
