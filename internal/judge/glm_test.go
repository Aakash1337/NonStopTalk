package judge

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testZAIKey = "zai-test-secret"

func TestGLMGradeUsesGeneralChatCompletionsContract(t *testing.T) {
	topic := "Why public parks matter"
	transcript := "Public parks give neighbors a place to meet and children a place to play."
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/api/paas/v4/chat/completions" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+testZAIKey {
			t.Errorf("unexpected authorization header %q", got)
		}
		requestBody, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request: %v", err)
			return
		}
		var request glmChatRequest
		if err := json.Unmarshal(requestBody, &request); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		if request.Model != "glm-4.7-flash" || request.Stream || request.ResponseFormat.Type != "json_object" {
			t.Errorf("unexpected GLM request options: %+v", request)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(requestBody, &fields); err != nil {
			t.Errorf("decode request fields: %v", err)
		}
		if _, present := fields["reasoning_effort"]; present {
			t.Error("GLM-4.7 request must not include reasoning_effort")
		}
		if request.Thinking.Type != "disabled" || !request.Thinking.ClearThinking {
			t.Errorf("unexpected thinking configuration: %+v", request)
		}
		if len(request.Messages) != 2 || request.Messages[0].Role != "system" || request.Messages[1].Role != "user" {
			t.Errorf("unexpected messages: %#v", request.Messages)
			return
		}
		if request.Messages[0].Content != systemPrompt {
			t.Error("grade request did not use the judge system prompt")
		}
		var user map[string]string
		if err := json.Unmarshal([]byte(request.Messages[1].Content), &user); err != nil {
			t.Errorf("decode user content: %v", err)
		}
		if len(user) != 2 || user["topic"] != topic || user["transcript"] != transcript {
			t.Errorf("unexpected user content: %#v", user)
		}
		writeGLMTestResponse(t, w, `{"relevance":0.82,"confidence":0.74,"feedback":"You stayed focused and developed the main idea."}`)
	}))
	defer server.Close()

	provider := testGLM(t, server)
	verdict, err := provider.Grade(context.Background(), topic, transcript)
	if err != nil {
		t.Fatal(err)
	}
	if verdict.Relevance != 0.82 || verdict.Confidence != 0.74 || verdict.Feedback == "" {
		t.Fatalf("unexpected verdict: %+v", verdict)
	}
	if calls.Load() != 1 {
		t.Fatalf("expected one provider call, got %d", calls.Load())
	}
}

func TestGLMGenerateTopicsSendsThemeAsOnlyUserContent(t *testing.T) {
	theme := "urban gardening"
	topics := testGLMTopics()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request glmChatRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		if request.Model != glmModel || request.MaxTokens != 1200 || request.ResponseFormat.Type != "json_object" {
			t.Errorf("unexpected request: %+v", request)
		}
		if len(request.Messages) != 2 || request.Messages[1] != (glmMessage{Role: "user", Content: theme}) {
			t.Errorf("theme was not the sole user content: %#v", request.Messages)
		}
		content, err := json.Marshal(struct {
			Topics []string `json:"topics"`
		}{Topics: topics})
		if err != nil {
			t.Errorf("encode topics: %v", err)
			return
		}
		writeGLMTestResponse(t, w, string(content))
	}))
	defer server.Close()

	provider := testGLM(t, server)
	generated, err := provider.GenerateTopics(context.Background(), theme)
	if err != nil {
		t.Fatal(err)
	}
	if len(generated) != GeneratedTopicCount {
		t.Fatalf("expected %d topics, got %d", GeneratedTopicCount, len(generated))
	}
	for index := range topics {
		if generated[index] != topics[index] {
			t.Fatalf("unexpected topics: %#v", generated)
		}
	}
}

func TestGLMHTTPFailureIsSanitizedAndSingleAttempt(t *testing.T) {
	theme := "private-theme-canary"
	bodyCanary := "private-response-canary"
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, bodyCanary+" "+theme+" "+testZAIKey, http.StatusTooManyRequests)
	}))
	defer server.Close()

	provider := testGLM(t, server)
	_, err := provider.GenerateTopics(context.Background(), theme)
	if err == nil {
		t.Fatal("expected provider error")
	}
	for _, secret := range []string{theme, bodyCanary, testZAIKey} {
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("error leaked private value %q: %v", secret, err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("expected one provider attempt, got %d", calls.Load())
	}
}

func TestGLMDoesNotFollowRedirects(t *testing.T) {
	var redirectedCalls atomic.Int32
	redirectTarget := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		redirectedCalls.Add(1)
	}))
	defer redirectTarget.Close()

	redirectSource := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, redirectTarget.URL, http.StatusTemporaryRedirect)
	}))
	defer redirectSource.Close()

	provider := testGLM(t, redirectSource)
	_, err := provider.GenerateTopics(context.Background(), "private-theme-canary")
	if !errors.Is(err, errGLMRequestFailed) {
		t.Fatalf("expected sanitized redirect failure, got %v", err)
	}
	if redirectedCalls.Load() != 0 {
		t.Fatalf("redirect target received %d request(s)", redirectedCalls.Load())
	}
}

func TestGLMRejectsOversizedAndInvalidStructuredOutput(t *testing.T) {
	t.Run("oversized envelope", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(strings.Repeat("x", glmMaxResponseBytes+1)))
		}))
		defer server.Close()
		provider := testGLM(t, server)
		_, err := provider.GenerateTopics(context.Background(), "science")
		if !errors.Is(err, errGLMResponseTooLarge) {
			t.Fatalf("expected response size error, got %v", err)
		}
	})

	t.Run("extra JSON key", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeGLMTestResponse(t, w, `{"topics":["1","2","3","4","5","6","7","8","9","10"],"extra":true}`)
		}))
		defer server.Close()
		provider := testGLM(t, server)
		_, err := provider.GenerateTopics(context.Background(), "science")
		if !errors.Is(err, errGLMInvalidResponse) {
			t.Fatalf("expected invalid response, got %v", err)
		}
	})

	t.Run("duplicate topic", func(t *testing.T) {
		duplicate := testGLMTopics()
		duplicate[len(duplicate)-1] = duplicate[0]
		content, err := json.Marshal(struct {
			Topics []string `json:"topics"`
		}{Topics: duplicate})
		if err != nil {
			t.Fatal(err)
		}
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeGLMTestResponse(t, w, string(content))
		}))
		defer server.Close()
		provider := testGLM(t, server)
		_, err = provider.GenerateTopics(context.Background(), "science")
		if !errors.Is(err, errGLMInvalidResponse) {
			t.Fatalf("expected invalid response, got %v", err)
		}
	})
}

func TestGLMPropagatesContextCancellation(t *testing.T) {
	started := make(chan struct{})
	client := &http.Client{Transport: roundTripperFunc(func(r *http.Request) (*http.Response, error) {
		close(started)
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}
	provider, err := newGLM(testZAIKey, glmEndpoint, client)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := provider.GenerateTopics(ctx, "science")
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context cancellation, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("request did not stop after cancellation")
	}
}

func TestNewGLMRejectsMissingConfiguration(t *testing.T) {
	if _, err := newGLM("", "https://example.test", http.DefaultClient); !errors.Is(err, errGLMInvalidConfiguration) {
		t.Fatalf("expected missing-key error, got %v", err)
	}
	if _, err := newGLM("key", "", http.DefaultClient); !errors.Is(err, errGLMInvalidConfiguration) {
		t.Fatalf("expected missing-endpoint error, got %v", err)
	}
}

func testGLM(t *testing.T, server *httptest.Server) *GLM {
	t.Helper()
	provider, err := newGLM(testZAIKey, server.URL+"/api/paas/v4/chat/completions", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return provider
}

func testGLMTopics() []string {
	result := make([]string, GeneratedTopicCount)
	for index := range result {
		result[index] = "Speaking prompt number " + string(rune('A'+index))
	}
	return result
}

func writeGLMTestResponse(t *testing.T, w http.ResponseWriter, content string) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]any{
		"id": "test-response",
		"choices": []any{map[string]any{
			"index":         0,
			"finish_reason": "stop",
			"message": map[string]any{
				"role":    "assistant",
				"content": content,
			},
		}},
	}); err != nil {
		t.Errorf("encode response: %v", err)
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (fn roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}
