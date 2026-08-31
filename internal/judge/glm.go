package judge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	glmEndpoint         = "https://api.z.ai/api/paas/v4/chat/completions"
	glmModel            = "glm-4.7-flash"
	glmMaxResponseBytes = 64 << 10
	glmMaxTranscript    = 8 << 10
	glmMaxThemeRunes    = 200
	glmMaxThemeBytes    = 800
	glmMaxTopicRunes    = 200
	glmMaxFeedbackRunes = 500
)

var (
	errGLMInvalidConfiguration = errors.New("GLM is not configured")
	errGLMRequestFailed        = errors.New("GLM request failed")
	errGLMResponseTooLarge     = errors.New("GLM response exceeded the size limit")
	errGLMInvalidResponse      = errors.New("GLM returned an invalid response")
)

const glmTopicSystemPrompt = `You write speaking prompts for "NonStopTalk", a party game where a player
must talk about a topic non-stop for about a minute.

Given the user's theme, write exactly 10 engaging prompts a player can improvise
on out loud. Vary the angles, keep every prompt family-safe and under 200
characters, and use one line per prompt.

Respond with only this JSON object and no additional keys or text:
{"topics":["prompt 1","prompt 2","prompt 3","prompt 4","prompt 5","prompt 6","prompt 7","prompt 8","prompt 9","prompt 10"]}`

var (
	_ Provider       = (*GLM)(nil)
	_ TopicGenerator = (*GLM)(nil)
)

// GLM grades turns and generates topics through Z.AI's general Chat
// Completions API. Callers control retries; GLM makes exactly one HTTP request
// for each Grade or GenerateTopics call.
type GLM struct {
	apiKey   string
	endpoint string
	client   *http.Client
}

// NewGLM creates a GLM-4.7-Flash provider using the production Z.AI endpoint.
func NewGLM(apiKey string) (*GLM, error) {
	return newGLM(apiKey, glmEndpoint, &http.Client{Timeout: 30 * time.Second})
}

func newGLM(apiKey, endpoint string, client *http.Client) (*GLM, error) {
	apiKey = strings.TrimSpace(apiKey)
	endpoint = strings.TrimSpace(endpoint)
	if apiKey == "" || endpoint == "" || client == nil {
		return nil, errGLMInvalidConfiguration
	}
	redirectSafeClient := *client
	redirectSafeClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &GLM{apiKey: apiKey, endpoint: endpoint, client: &redirectSafeClient}, nil
}

func (g *GLM) Name() string { return "AI judge" }

// Grade sends only the assigned topic and the consented, size-capped turn
// transcript as user data. Audio and room metadata are never part of the
// provider request.
func (g *GLM) Grade(ctx context.Context, topic, transcript string) (Verdict, error) {
	topic = strings.TrimSpace(topic)
	transcript = strings.TrimSpace(transcript)
	if topic == "" || transcript == "" || utf8.RuneCountInString(topic) > glmMaxTopicRunes || len(transcript) > glmMaxTranscript {
		return Verdict{}, errors.New("invalid GLM judge input")
	}
	userContent, err := json.Marshal(struct {
		Topic      string `json:"topic"`
		Transcript string `json:"transcript"`
	}{Topic: topic, Transcript: transcript})
	if err != nil {
		return Verdict{}, errors.New("could not encode GLM judge input")
	}
	content, err := g.complete(ctx, systemPrompt, string(userContent), 300)
	if err != nil {
		return Verdict{}, err
	}
	return parseGLMVerdict(content)
}

// GenerateTopics sends the normalized theme as the sole user-content value.
func (g *GLM) GenerateTopics(ctx context.Context, theme string) ([]string, error) {
	theme = strings.TrimSpace(theme)
	if theme == "" || utf8.RuneCountInString(theme) > glmMaxThemeRunes || len(theme) > glmMaxThemeBytes || strings.ContainsAny(theme, "\r\n") {
		return nil, errors.New("invalid GLM topic theme")
	}
	content, err := g.complete(ctx, glmTopicSystemPrompt, theme, 1200)
	if err != nil {
		return nil, err
	}
	return parseGLMTopics(content)
}

func (g *GLM) complete(ctx context.Context, system, user string, maxTokens int) (string, error) {
	if ctx == nil {
		return "", errGLMRequestFailed
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	payload, err := json.Marshal(glmChatRequest{
		Model: glmModel,
		Messages: []glmMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Stream:         false,
		Thinking:       glmThinking{Type: "disabled", ClearThinking: true},
		Temperature:    1,
		TopP:           0.95,
		MaxTokens:      maxTokens,
		ResponseFormat: glmResponseFormat{Type: "json_object"},
	})
	if err != nil {
		return "", errGLMRequestFailed
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", errGLMRequestFailed
	}
	req.Header.Set("Authorization", "Bearer "+g.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Language", "en-US,en")

	response, err := g.client.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", ctxErr
		}
		return "", errGLMRequestFailed
	}
	if response == nil || response.Body == nil {
		return "", errGLMInvalidResponse
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return "", fmt.Errorf("%w (status %d)", errGLMRequestFailed, response.StatusCode)
	}
	if response.ContentLength > glmMaxResponseBytes {
		return "", errGLMResponseTooLarge
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, glmMaxResponseBytes+1))
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", ctxErr
		}
		return "", errGLMInvalidResponse
	}
	if len(body) > glmMaxResponseBytes {
		return "", errGLMResponseTooLarge
	}

	var decoded glmChatResponse
	if err := json.Unmarshal(body, &decoded); err != nil || len(decoded.Choices) == 0 {
		return "", errGLMInvalidResponse
	}
	choice := decoded.Choices[0]
	if choice.FinishReason != "stop" || strings.TrimSpace(choice.Message.Content) == "" {
		return "", errGLMInvalidResponse
	}
	return choice.Message.Content, nil
}

func parseGLMVerdict(content string) (Verdict, error) {
	var raw struct {
		Relevance  *float64 `json:"relevance"`
		Confidence *float64 `json:"confidence"`
		Feedback   *string  `json:"feedback"`
	}
	if err := decodeExactJSONObject(content, &raw); err != nil || raw.Relevance == nil || raw.Confidence == nil || raw.Feedback == nil {
		return Verdict{}, errGLMInvalidResponse
	}
	feedback := strings.TrimSpace(*raw.Feedback)
	if feedback == "" || utf8.RuneCountInString(feedback) > glmMaxFeedbackRunes {
		return Verdict{}, errGLMInvalidResponse
	}
	if *raw.Relevance < 0 || *raw.Relevance > 1 || *raw.Confidence < 0 || *raw.Confidence > 1 {
		return Verdict{}, errGLMInvalidResponse
	}
	return Verdict{Relevance: *raw.Relevance, Confidence: *raw.Confidence, Feedback: feedback}, nil
}

func parseGLMTopics(content string) ([]string, error) {
	var raw struct {
		Topics []string `json:"topics"`
	}
	if err := decodeExactJSONObject(content, &raw); err != nil || len(raw.Topics) != GeneratedTopicCount {
		return nil, errGLMInvalidResponse
	}
	topics := make([]string, 0, GeneratedTopicCount)
	seen := make(map[string]struct{}, GeneratedTopicCount)
	for _, value := range raw.Topics {
		topic := strings.TrimSpace(value)
		if topic == "" || utf8.RuneCountInString(topic) > glmMaxTopicRunes || strings.ContainsAny(topic, "\r\n") {
			return nil, errGLMInvalidResponse
		}
		key := strings.ToLower(topic)
		if _, duplicate := seen[key]; duplicate {
			return nil, errGLMInvalidResponse
		}
		seen[key] = struct{}{}
		topics = append(topics, topic)
	}
	return topics, nil
}

func decodeExactJSONObject(content string, destination any) error {
	decoder := json.NewDecoder(strings.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errGLMInvalidResponse
	}
	return nil
}

type glmChatRequest struct {
	Model          string            `json:"model"`
	Messages       []glmMessage      `json:"messages"`
	Stream         bool              `json:"stream"`
	Thinking       glmThinking       `json:"thinking"`
	Temperature    float64           `json:"temperature"`
	TopP           float64           `json:"top_p"`
	MaxTokens      int               `json:"max_tokens"`
	ResponseFormat glmResponseFormat `json:"response_format"`
}

type glmMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type glmThinking struct {
	Type          string `json:"type"`
	ClearThinking bool   `json:"clear_thinking"`
}

type glmResponseFormat struct {
	Type string `json:"type"`
}

type glmChatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
}
