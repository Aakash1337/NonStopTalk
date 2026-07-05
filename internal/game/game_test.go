package game

import (
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
	if !session.ResolveTurnAI(index, turn.PlayerID, turn.Topic, &relevance, "Nice focus.", AIStatusDone) {
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
	if session.ResolveTurnAI(index, "someone-else", turn.Topic, &relevance, "x", AIStatusDone) {
		t.Fatal("expected mismatched player to be rejected")
	}
	session.ResetForNewGame()
	if session.ResolveTurnAI(index, turn.PlayerID, turn.Topic, &relevance, "x", AIStatusDone) {
		t.Fatal("expected verdict after reset to be rejected")
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
	if turn.Topic != "Topic one" {
		t.Fatalf("expected first topic, got %q", turn.Topic)
	}

	redrawn, err := session.RedrawActiveTurn()
	if err != nil {
		t.Fatal(err)
	}
	if redrawn.Topic != "Topic two" {
		t.Fatalf("expected redrawn topic, got %q", redrawn.Topic)
	}
	if session.TopicCursor != 2 {
		t.Fatalf("expected topic cursor to advance, got %d", session.TopicCursor)
	}
}
