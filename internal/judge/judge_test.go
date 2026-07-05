package judge

import (
	"context"
	"testing"
)

func TestHeuristicRewardsOnTopicSpeech(t *testing.T) {
	h := Heuristic{}
	topic := "The best breakfast food and why everyone else is wrong"

	onTopic, err := h.Grade(context.Background(),
		topic,
		"I think breakfast is the greatest meal and the best food is pancakes with syrup, "+
			"people who say otherwise about breakfast food are simply wrong and I will explain why "+
			"eggs bacon and toast complete any breakfast plate in the morning")
	if err != nil {
		t.Fatal(err)
	}
	offTopic, err := h.Grade(context.Background(), topic, "cars go fast on roads")
	if err != nil {
		t.Fatal(err)
	}

	if onTopic.Relevance <= offTopic.Relevance {
		t.Fatalf("expected on-topic speech to outscore off-topic: %v vs %v", onTopic.Relevance, offTopic.Relevance)
	}
	if onTopic.Relevance < 0 || onTopic.Relevance > 1 {
		t.Fatalf("relevance out of range: %v", onTopic.Relevance)
	}
	if onTopic.Feedback == "" || offTopic.Feedback == "" {
		t.Fatal("expected feedback on every verdict")
	}
}

func TestHeuristicHandlesEmptyTranscript(t *testing.T) {
	verdict, err := Heuristic{}.Grade(context.Background(), "Any topic here", "")
	if err != nil {
		t.Fatal(err)
	}
	if verdict.Relevance != 0 {
		t.Fatalf("expected zero relevance for empty transcript, got %v", verdict.Relevance)
	}
}

func TestParseVerdict(t *testing.T) {
	verdict, err := parseVerdict(`Sure! {"relevance": 0.8, "feedback": "Great focus on the topic."} `)
	if err != nil {
		t.Fatal(err)
	}
	if verdict.Relevance != 0.8 || verdict.Feedback != "Great focus on the topic." {
		t.Fatalf("unexpected verdict: %+v", verdict)
	}

	clamped, err := parseVerdict(`{"relevance": 3.5, "feedback": "x"}`)
	if err != nil {
		t.Fatal(err)
	}
	if clamped.Relevance != 1 {
		t.Fatalf("expected clamped relevance, got %v", clamped.Relevance)
	}

	if _, err := parseVerdict("no json at all"); err == nil {
		t.Fatal("expected error for missing JSON")
	}
	if _, err := parseVerdict(`{"relevance": 0.5, "feedback": ""}`); err == nil {
		t.Fatal("expected error for empty feedback")
	}
}
