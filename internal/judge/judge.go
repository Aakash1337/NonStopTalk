// Package judge grades how relevant a turn's transcript was to its topic.
// Grading is a bonus modifier on top of classic scoring, never a gate: any
// failure simply means no bonus. Transcripts come from the speaker's own
// browser (Web Speech API); audio never reaches the server or a provider.
package judge

import (
	"context"
	"strings"
)

// Verdict is the judge's assessment of one turn.
type Verdict struct {
	// Relevance is 0..1; the game converts it to bonus points.
	Relevance float64
	// Feedback is one or two short sentences addressed to the player.
	Feedback string
}

// Provider grades a transcript against a topic.
type Provider interface {
	// Grade returns a verdict, or an error if grading failed entirely.
	Grade(ctx context.Context, topic, transcript string) (Verdict, error)
	// Name identifies the judge to players ("AI judge", "offline judge").
	Name() string
}

func clampRelevance(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// Heuristic is an offline fallback judge that scores by keyword overlap
// between topic and transcript. It keeps AI mode playable and testable with
// no provider configured, and is transparent about being a rough measure.
type Heuristic struct{}

func (Heuristic) Name() string { return "offline judge" }

func (Heuristic) Grade(_ context.Context, topic, transcript string) (Verdict, error) {
	keywords := keywords(topic)
	spoken := wordSet(transcript)
	matched := 0
	for keyword := range keywords {
		if spoken[keyword] {
			matched++
		}
	}

	overlap := 0.0
	if len(keywords) > 0 {
		overlap = float64(matched) / float64(len(keywords))
	}
	length := float64(len(strings.Fields(transcript))) / 30.0
	if length > 1 {
		length = 1
	}
	relevance := clampRelevance(0.7*overlap + 0.3*length)

	feedback := "Offline judge: you touched on the topic's key words."
	switch {
	case matched == 0:
		feedback = "Offline judge: none of the topic's key words came up, so only a small bonus."
	case overlap < 0.5:
		feedback = "Offline judge: you hit some of the topic's key words, but wandered."
	}
	return Verdict{Relevance: relevance, Feedback: feedback}, nil
}

var stopwords = map[string]bool{
	"the": true, "and": true, "for": true, "that": true, "with": true,
	"you": true, "your": true, "would": true, "should": true, "than": true,
	"about": true, "why": true, "how": true, "are": true, "everyone": true,
	"more": true, "most": true, "best": true, "into": true, "from": true,
}

func keywords(topic string) map[string]bool {
	words := map[string]bool{}
	for _, word := range strings.Fields(strings.ToLower(topic)) {
		word = strings.Trim(word, ".,!?\"'():;")
		if len(word) > 3 && !stopwords[word] {
			words[word] = true
		}
	}
	return words
}

func wordSet(text string) map[string]bool {
	words := map[string]bool{}
	for _, word := range strings.Fields(strings.ToLower(text)) {
		words[strings.Trim(word, ".,!?\"'():;")] = true
	}
	return words
}
