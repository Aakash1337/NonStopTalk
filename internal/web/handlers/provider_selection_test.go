package handlers

import (
	"testing"

	"github.com/Aakash1337/NonStopTalk/internal/judge"
)

func TestSelectAIProvider(t *testing.T) {
	tests := []struct {
		name         string
		selected     string
		anthropicKey string
		zaiKey       string
		providerType string
		external     bool
		wantWarning  bool
	}{
		{name: "unset is offline without legacy key", providerType: "offline"},
		{name: "unset preserves Anthropic legacy", anthropicKey: "anthropic-key", providerType: "anthropic", external: true},
		{name: "unset ignores unrelated ZAI key", zaiKey: "zai-key", providerType: "offline"},
		{name: "offline overrides both credentials", selected: " offline ", anthropicKey: "anthropic-key", zaiKey: "zai-key", providerType: "offline"},
		{name: "explicit Anthropic", selected: "ANTHROPIC", anthropicKey: "anthropic-key", providerType: "anthropic", external: true},
		{name: "explicit GLM", selected: "glm", zaiKey: "zai-key", providerType: "glm", external: true},
		{name: "Anthropic key required", selected: "anthropic", providerType: "offline", wantWarning: true},
		{name: "GLM key required", selected: "glm", providerType: "offline", wantWarning: true},
		{name: "unknown fails closed", selected: "gemma31", providerType: "offline", wantWarning: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			provider, generator, external, err := selectAIProvider(tt.selected, tt.anthropicKey, tt.zaiKey)
			if (err != nil) != tt.wantWarning {
				t.Fatalf("warning=%v, want warning=%v", err, tt.wantWarning)
			}
			if external != tt.external {
				t.Fatalf("external=%v, want %v", external, tt.external)
			}
			switch tt.providerType {
			case "offline":
				if _, ok := provider.(judge.Heuristic); !ok {
					t.Fatalf("expected heuristic judge, got %T", provider)
				}
				if _, ok := generator.(judge.Heuristic); !ok {
					t.Fatalf("expected heuristic generator, got %T", generator)
				}
			case "anthropic":
				selectedProvider, ok := provider.(*judge.Anthropic)
				if !ok {
					t.Fatalf("expected Anthropic judge, got %T", provider)
				}
				selectedGenerator, ok := generator.(*judge.Anthropic)
				if !ok || selectedGenerator != selectedProvider {
					t.Fatalf("expected the same Anthropic instance, got %T", generator)
				}
			case "glm":
				selectedProvider, ok := provider.(*judge.GLM)
				if !ok {
					t.Fatalf("expected GLM judge, got %T", provider)
				}
				selectedGenerator, ok := generator.(*judge.GLM)
				if !ok || selectedGenerator != selectedProvider {
					t.Fatalf("expected the same GLM instance, got %T", generator)
				}
			}
		})
	}
}
