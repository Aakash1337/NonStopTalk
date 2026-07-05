package judge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
)

const anthropicModel = anthropic.ModelClaudeOpus4_8

const systemPrompt = `You are the judge in "Don't Stop Talking", a party game where a player must speak
about an assigned topic without stopping. You receive the topic and an automatic
speech transcript of the turn.

Grade how relevant and substantive the speech was for the topic. Transcripts come
from imperfect speech recognition: ignore transcription artifacts, filler words,
and grammar. Reward staying on topic and developing ideas; penalize ignoring the
topic or pure filler. Be generous — this is a party game.

Respond with only a JSON object, no other text:
{"relevance": <number between 0 and 1>, "feedback": "<one or two short sentences addressed directly to the player, explaining the grade in plain language>"}`

// Anthropic grades turns with Claude. The zero-config client resolves
// credentials from the environment (ANTHROPIC_API_KEY and friends).
type Anthropic struct {
	client anthropic.Client
}

func NewAnthropic() *Anthropic {
	return &Anthropic{client: anthropic.NewClient()}
}

func (a *Anthropic) Name() string { return "AI judge" }

func (a *Anthropic) Grade(ctx context.Context, topic, transcript string) (Verdict, error) {
	message, err := a.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     anthropicModel,
		MaxTokens: 300,
		System: []anthropic.TextBlockParam{
			{Text: systemPrompt},
		},
		Messages: []anthropic.MessageParam{
			anthropic.NewUserMessage(anthropic.NewTextBlock(
				"Topic: " + topic + "\n\nTranscript:\n" + transcript,
			)),
		},
	})
	if err != nil {
		return Verdict{}, err
	}

	text := ""
	for _, block := range message.Content {
		if block.Type == "text" {
			text += block.Text
		}
	}
	return parseVerdict(text)
}

// parseVerdict extracts the JSON verdict from the model's reply, tolerating
// stray prose around it.
func parseVerdict(text string) (Verdict, error) {
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start == -1 || end <= start {
		return Verdict{}, errors.New("no JSON verdict in judge reply")
	}
	var raw struct {
		Relevance float64 `json:"relevance"`
		Feedback  string  `json:"feedback"`
	}
	if err := json.Unmarshal([]byte(text[start:end+1]), &raw); err != nil {
		return Verdict{}, err
	}
	feedback := strings.TrimSpace(raw.Feedback)
	if feedback == "" {
		return Verdict{}, errors.New("judge reply missing feedback")
	}
	return Verdict{Relevance: clampRelevance(raw.Relevance), Feedback: feedback}, nil
}
