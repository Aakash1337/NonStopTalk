package judge

import (
	"context"
	"strings"
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

func TestHeuristicGeneratesThemedTopics(t *testing.T) {
	topics, err := Heuristic{}.GenerateTopics(context.Background(), "space travel")
	if err != nil {
		t.Fatal(err)
	}
	if len(topics) != GeneratedTopicCount {
		t.Fatalf("expected %d topics, got %d", GeneratedTopicCount, len(topics))
	}
	seen := map[string]bool{}
	for _, topic := range topics {
		if !strings.Contains(topic, "space travel") {
			t.Fatalf("expected theme in topic %q", topic)
		}
		if seen[topic] {
			t.Fatalf("duplicate topic %q", topic)
		}
		seen[topic] = true
	}

	if _, err := (Heuristic{}).GenerateTopics(context.Background(), "   "); err == nil {
		t.Fatal("expected error for empty theme")
	}
}

func TestParseTopicList(t *testing.T) {
	topics, err := parseTopicList(`Here you go: ["One", " Two ", ""] done`)
	if err != nil {
		t.Fatal(err)
	}
	if len(topics) != 2 || topics[0] != "One" || topics[1] != "Two" {
		t.Fatalf("unexpected topics: %#v", topics)
	}
	if _, err := parseTopicList("no list"); err == nil {
		t.Fatal("expected error for missing list")
	}
	if _, err := parseTopicList("[]"); err == nil {
		t.Fatal("expected error for empty list")
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
