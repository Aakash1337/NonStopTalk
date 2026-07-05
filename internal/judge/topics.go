package judge

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
)

// GeneratedTopicCount is how many topics one generation request produces.
const GeneratedTopicCount = 10

// TopicGenerator turns a host-supplied theme into a playable topic list.
type TopicGenerator interface {
	// GenerateTopics returns speaking prompts for the theme.
	GenerateTopics(ctx context.Context, theme string) ([]string, error)
}

const topicSystemPrompt = `You write speaking prompts for "Don't Stop Talking", a party game where a player
must talk about a topic non-stop for about a minute.

Given a theme, write engaging prompts a player can improvise on out loud: opinions
to defend, stories to tell, absurd positions to commit to. Keep each prompt a single
sentence, concrete, and family-safe unless the theme clearly asks otherwise. Vary the
angle across prompts so a full game stays fresh.

Respond with only a JSON array of prompt strings, no other text.`

// GenerateTopics implements TopicGenerator with Claude. Only the theme text
// is sent to the provider.
func (a *Anthropic) GenerateTopics(ctx context.Context, theme string) ([]string, error) {
	message, err := a.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     anthropicModel,
		MaxTokens: 1200,
		System: []anthropic.TextBlockParam{
			{Text: topicSystemPrompt},
		},
		Messages: []anthropic.MessageParam{
			anthropic.NewUserMessage(anthropic.NewTextBlock(
				"Theme: " + theme + "\n\nWrite exactly " + strconv.Itoa(GeneratedTopicCount) + " prompts.",
			)),
		},
	})
	if err != nil {
		return nil, err
	}
	text := ""
	for _, block := range message.Content {
		if block.Type == "text" {
			text += block.Text
		}
	}
	return parseTopicList(text)
}

func parseTopicList(text string) ([]string, error) {
	start := strings.Index(text, "[")
	end := strings.LastIndex(text, "]")
	if start == -1 || end <= start {
		return nil, errors.New("no JSON topic list in reply")
	}
	var raw []string
	if err := json.Unmarshal([]byte(text[start:end+1]), &raw); err != nil {
		return nil, err
	}
	topics := make([]string, 0, len(raw))
	for _, topic := range raw {
		topic = strings.TrimSpace(topic)
		if topic != "" {
			topics = append(topics, topic)
		}
	}
	if len(topics) == 0 {
		return nil, errors.New("topic list was empty")
	}
	return topics, nil
}

// GenerateTopics implements TopicGenerator offline with theme templates, so
// hosts without an AI provider still get a playable (if predictable) pack.
func (Heuristic) GenerateTopics(_ context.Context, theme string) ([]string, error) {
	theme = strings.TrimSpace(theme)
	if theme == "" {
		return nil, errors.New("describe a theme first")
	}
	templates := []string{
		"The best thing about %s and why it matters",
		"Why %s is completely overrated",
		"A story from your life involving %s",
		"How you would explain %s to someone from the year 1900",
		"The official rules you would add to %s",
		"Why %s will look completely different in twenty years",
		"The most common mistake people make with %s",
		"Defend this: everyone should try %s at least once",
		"The strangest fact you know (or can invent) about %s",
		"Your plan to become world famous through %s",
	}
	topics := make([]string, 0, len(templates))
	for _, template := range templates {
		topics = append(topics, strings.Replace(template, "%s", theme, 1))
	}
	return topics, nil
}
