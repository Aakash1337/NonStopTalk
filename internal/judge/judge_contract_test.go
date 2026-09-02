package judge

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/Aakash1337/NonStopTalk/internal/game"
)

type judgeContract struct {
	SchemaVersion int `json:"schemaVersion"`
	Constants     struct {
		MaxBonus          int               `json:"maxBonus"`
		OfflineConfidence float64           `json:"offlineConfidence"`
		Feedback          map[string]string `json:"feedback"`
	} `json:"constants"`
	Cases struct {
		OfflineGrades []struct {
			ID         string `json:"id"`
			Topic      string `json:"topic"`
			Transcript string `json:"transcript"`
			Expected   struct {
				Relevance    float64 `json:"relevance"`
				Confidence   float64 `json:"confidence"`
				FeedbackCode string  `json:"feedbackCode"`
				Bonus        int     `json:"bonus"`
			} `json:"expected"`
		} `json:"offlineGrades"`
		Bonuses []struct {
			Relevance float64 `json:"relevance"`
			Expected  int     `json:"expected"`
		} `json:"bonuses"`
		ConfidenceLabels []struct {
			Confidence *float64 `json:"confidence"`
			Expected   string   `json:"expected"`
		} `json:"confidenceLabels"`
	} `json:"cases"`
}

func loadJudgeContract(t *testing.T) judgeContract {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate judge contract test")
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(filename), "..", "..", "testdata", "judge-contract.v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract judgeContract
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	return contract
}

func TestHeuristicMatchesSharedJudgeContract(t *testing.T) {
	contract := loadJudgeContract(t)
	if contract.SchemaVersion != 1 {
		t.Fatalf("unsupported judge contract schema: %d", contract.SchemaVersion)
	}
	if contract.Constants.MaxBonus != 20 {
		t.Fatalf("shared judge max bonus: want 20, got %d", contract.Constants.MaxBonus)
	}
	if contract.Constants.OfflineConfidence != 0.3 {
		t.Fatalf("shared offline confidence: want 0.3, got %v", contract.Constants.OfflineConfidence)
	}

	for _, fixture := range contract.Cases.OfflineGrades {
		t.Run(fixture.ID, func(t *testing.T) {
			verdict, err := (Heuristic{}).Grade(context.Background(), fixture.Topic, fixture.Transcript)
			if err != nil {
				t.Fatal(err)
			}
			if math.Abs(verdict.Relevance-fixture.Expected.Relevance) > 1e-12 {
				t.Fatalf("relevance: want %.16g, got %.16g", fixture.Expected.Relevance, verdict.Relevance)
			}
			if verdict.Confidence != fixture.Expected.Confidence {
				t.Fatalf("confidence: want %v, got %v", fixture.Expected.Confidence, verdict.Confidence)
			}
			expectedFeedback, ok := contract.Constants.Feedback[fixture.Expected.FeedbackCode]
			if !ok {
				t.Fatalf("unknown feedback code %q", fixture.Expected.FeedbackCode)
			}
			if verdict.Feedback != expectedFeedback {
				t.Fatalf("feedback: want %q, got %q", expectedFeedback, verdict.Feedback)
			}
			bonus := game.Score(game.ScoreInput{AIRelevanceScore: &verdict.Relevance})
			if bonus != fixture.Expected.Bonus {
				t.Fatalf("bonus: want %d, got %d", fixture.Expected.Bonus, bonus)
			}
		})
	}

	for _, fixture := range contract.Cases.Bonuses {
		relevance := fixture.Relevance
		if got := game.Score(game.ScoreInput{AIRelevanceScore: &relevance}); got != fixture.Expected {
			t.Errorf("bonus for %v: want %d, got %d", relevance, fixture.Expected, got)
		}
	}

	for _, fixture := range contract.Cases.ConfidenceLabels {
		turn := game.Turn{AIConfidence: fixture.Confidence}
		if got := turn.AIConfidenceLabel(); got != fixture.Expected {
			t.Errorf("confidence label for %v: want %q, got %q", fixture.Confidence, fixture.Expected, got)
		}
	}
}
