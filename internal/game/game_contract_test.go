package game

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"
	"unicode/utf8"
)

type gameContractFixture struct {
	SchemaVersion int `json:"schemaVersion"`
	Constants     struct {
		MaxPlayerNameCodePoints          int    `json:"maxPlayerNameCodePoints"`
		MaxTopicCodePoints               int    `json:"maxTopicCodePoints"`
		CompletionBonus                  int    `json:"completionBonus"`
		MaxScoreCorrectionDeltaMagnitude int    `json:"maxScoreCorrectionDeltaMagnitude"`
		MinimumScore                     int    `json:"minimumScore"`
		TurnIDPrefix                     string `json:"turnIdPrefix"`
		MaxTurnIDNumber                  int64  `json:"maxTurnIdNumber"`
		TurnIDExhaustedSentinel          int64  `json:"turnIdExhaustedSentinel"`
	} `json:"constants"`
	Cases struct {
		UnicodeTruncation []struct {
			ID    string `json:"id"`
			Field string `json:"field"`
			Input struct {
				Repeat      string   `json:"repeat"`
				Count       int      `json:"count"`
				Suffix      string   `json:"suffix"`
				SuffixUTF16 []uint16 `json:"suffixUtf16"`
			} `json:"input"`
			Expected struct {
				Repeat      string   `json:"repeat"`
				Count       int      `json:"count"`
				Suffix      string   `json:"suffix"`
				SuffixUTF16 []uint16 `json:"suffixUtf16"`
			} `json:"expected"`
			ExpectedCodePoints int `json:"expectedCodePoints"`
		} `json:"unicodeTruncation"`
		TurnSubmissions []struct {
			ID                    string `json:"id"`
			DurationSeconds       int    `json:"durationSeconds"`
			SpokenSeconds         int    `json:"spokenSeconds"`
			RequestedCompleted    bool   `json:"requestedCompleted"`
			Eliminated            bool   `json:"eliminated"`
			ExpectedSpokenSeconds int    `json:"expectedSpokenSeconds"`
			ExpectedCompleted     bool   `json:"expectedCompleted"`
			ExpectedScore         int    `json:"expectedScore"`
		} `json:"turnSubmissions"`
		ScoreCorrections []struct {
			ID                   string `json:"id"`
			PlayerID             string `json:"playerId"`
			InitialScore         int    `json:"initialScore"`
			RequestedDelta       int    `json:"requestedDelta"`
			ExpectedAppliedDelta int    `json:"expectedAppliedDelta"`
			ExpectedScore        int    `json:"expectedScore"`
			ExpectedAccepted     bool   `json:"expectedAccepted"`
			ErrorCode            string `json:"errorCode"`
		} `json:"scoreCorrections"`
		CustomTopics []struct {
			ID          string   `json:"id"`
			InputTopics []string `json:"inputTopics"`
			Initial     struct {
				Topics     []string `json:"topics"`
				TopicPack  string   `json:"topicPack"`
				Deck       []int    `json:"deck"`
				DeckCursor int      `json:"deckCursor"`
			} `json:"initial"`
			Expected struct {
				Topics     []string `json:"topics"`
				TopicPack  string   `json:"topicPack"`
				Deck       []int    `json:"deck"`
				DeckCursor int      `json:"deckCursor"`
				Accepted   bool     `json:"accepted"`
				ErrorCode  string   `json:"errorCode"`
			} `json:"expected"`
		} `json:"customTopics"`
		TurnCounters []struct {
			ID                       string   `json:"id"`
			Allocation               string   `json:"allocation"`
			InitialNextTurn          int64    `json:"initialNextTurn"`
			ActiveTurnID             *string  `json:"activeTurnId"`
			CompletedTurnIDs         []string `json:"completedTurnIds"`
			ExpectedAllocatedTurnID  *string  `json:"expectedAllocatedTurnId"`
			ExpectedNextTurn         int64    `json:"expectedNextTurn"`
			ExpectedAccepted         bool     `json:"expectedAccepted"`
			ErrorCode                string   `json:"errorCode"`
			ExpectedHistoryPreserved bool     `json:"expectedHistoryPreserved"`
		} `json:"turnCounters"`
	} `json:"cases"`
}

func loadGameContract(t *testing.T) gameContractFixture {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "game-contract.v1.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read game contract: %v", err)
	}
	var fixture gameContractFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode game contract: %v", err)
	}
	if fixture.SchemaVersion != 1 {
		t.Fatalf("unsupported game contract schema %d", fixture.SchemaVersion)
	}
	return fixture
}

func expandContractText(repeat string, count int, suffix string, suffixUTF16 []uint16) string {
	if len(suffixUTF16) > 0 {
		suffix = string(utf16.Decode(suffixUTF16))
	}
	return strings.Repeat(repeat, count) + suffix
}

func TestGameContractUnicodeTruncation(t *testing.T) {
	contract := loadGameContract(t)
	if contract.Constants.MaxPlayerNameCodePoints != MaxPlayerNameLength ||
		contract.Constants.MaxTopicCodePoints != MaxTopicLength {
		t.Fatal("runtime text limits differ from the shared contract")
	}

	for _, test := range contract.Cases.UnicodeTruncation {
		t.Run(test.ID, func(t *testing.T) {
			input := expandContractText(test.Input.Repeat, test.Input.Count, test.Input.Suffix, test.Input.SuffixUTF16)
			expected := expandContractText(test.Expected.Repeat, test.Expected.Count, test.Expected.Suffix, test.Expected.SuffixUTF16)
			var actual string
			session := NewSession("contract")
			switch test.Field {
			case "player_name":
				actual = session.AddPlayer(input).Name
			case "topic":
				if err := session.SetTopics([]string{input}); err != nil {
					t.Fatal(err)
				}
				actual = session.Topics[0]
			default:
				t.Fatalf("unsupported field %q", test.Field)
			}
			if actual != expected || utf8.RuneCountInString(actual) != test.ExpectedCodePoints {
				t.Fatalf("got %q (%d code points), want %q (%d)", actual,
					utf8.RuneCountInString(actual), expected, test.ExpectedCodePoints)
			}
		})
	}
}

func TestGameContractGoInputNormalizesMalformedUTF8(t *testing.T) {
	// JSON cannot carry malformed UTF-8, so this Go-only adapter check proves
	// the same scalar-value guarantee that toWellFormed enforces in JavaScript.
	session := NewSession("contract")
	player := session.AddPlayer(string([]byte{0xff}))
	if player.Name != "\uFFFD" || !utf8.ValidString(player.Name) {
		t.Fatalf("malformed name normalized to %q", player.Name)
	}
	if err := session.SetTopics([]string{string([]byte{0xff})}); err != nil {
		t.Fatal(err)
	}
	if len(session.Topics) != 1 || session.Topics[0] != "\uFFFD" || !utf8.ValidString(session.Topics[0]) {
		t.Fatalf("malformed topic normalized to %q", session.Topics)
	}
}

func TestGameContractTurnSubmissions(t *testing.T) {
	contract := loadGameContract(t)
	if contract.Constants.CompletionBonus != CompletionBonus {
		t.Fatal("runtime completion bonus differs from the shared contract")
	}
	for _, test := range contract.Cases.TurnSubmissions {
		t.Run(test.ID, func(t *testing.T) {
			session := NewSession("contract")
			session.AddPlayer("Avery")
			session.AddPlayer("Blair")
			session.Settings.SpeakingDurationSeconds = test.DurationSeconds
			if err := session.SetTopics([]string{"Contract topic"}); err != nil {
				t.Fatal(err)
			}
			if _, err := session.StartTurn(); err != nil {
				t.Fatal(err)
			}
			turn, err := session.SubmitTurn(test.SpokenSeconds, test.RequestedCompleted, test.Eliminated)
			if err != nil {
				t.Fatal(err)
			}
			if turn.SpokenSeconds != test.ExpectedSpokenSeconds ||
				turn.Completed != test.ExpectedCompleted || turn.Score != test.ExpectedScore {
				t.Fatalf("got spoken=%d completed=%v score=%d, want %d %v %d", turn.SpokenSeconds,
					turn.Completed, turn.Score, test.ExpectedSpokenSeconds, test.ExpectedCompleted, test.ExpectedScore)
			}
		})
	}
}

func TestGameContractScoreCorrections(t *testing.T) {
	contract := loadGameContract(t)
	if contract.Constants.MaxScoreCorrectionDeltaMagnitude != MaxScoreCorrectionDelta ||
		contract.Constants.MinimumScore != 0 {
		t.Fatal("runtime score limits differ from the shared contract")
	}
	for _, test := range contract.Cases.ScoreCorrections {
		t.Run(test.ID, func(t *testing.T) {
			session := NewSession("contract")
			player := session.AddPlayer("Avery")
			session.Players[0].Score = test.InitialScore
			if player.ID != "p1" {
				t.Fatalf("fixture requires p1, got %q", player.ID)
			}
			applied, accepted := session.OverrideScore(test.PlayerID, test.RequestedDelta)
			if applied != test.ExpectedAppliedDelta || accepted != test.ExpectedAccepted ||
				session.Players[0].Score != test.ExpectedScore {
				t.Fatalf("got applied=%d accepted=%v score=%d, want %d %v %d", applied, accepted,
					session.Players[0].Score, test.ExpectedAppliedDelta, test.ExpectedAccepted, test.ExpectedScore)
			}
			if !accepted && test.ErrorCode != "player_not_found" {
				t.Fatalf("unsupported rejection code %q", test.ErrorCode)
			}
		})
	}
}

func TestGameContractEmptyTopicsAreAtomic(t *testing.T) {
	contract := loadGameContract(t)
	for _, test := range contract.Cases.CustomTopics {
		t.Run(test.ID, func(t *testing.T) {
			session := NewSession("contract")
			session.Topics = append([]string(nil), test.Initial.Topics...)
			session.Settings.TopicPackID = test.Initial.TopicPack
			session.TopicDeck = append([]int(nil), test.Initial.Deck...)
			session.TopicDeckCursor = test.Initial.DeckCursor

			err := session.SetTopics(test.InputTopics)
			accepted := err == nil
			if accepted != test.Expected.Accepted {
				t.Fatalf("accepted=%v, want %v", accepted, test.Expected.Accepted)
			}
			if test.Expected.ErrorCode != "topics_required" || !errors.Is(err, ErrTopicsRequired) {
				t.Fatalf("got error %v for code %q", err, test.Expected.ErrorCode)
			}
			if !reflect.DeepEqual(session.Topics, test.Expected.Topics) ||
				session.Settings.TopicPackID != test.Expected.TopicPack ||
				!reflect.DeepEqual(session.TopicDeck, test.Expected.Deck) ||
				session.TopicDeckCursor != test.Expected.DeckCursor {
				t.Fatalf("rejected replacement mutated session: %+v", session)
			}
		})
	}
}

func TestGameContractTurnCounterRepair(t *testing.T) {
	contract := loadGameContract(t)
	if contract.Constants.TurnIDPrefix != "t" {
		t.Fatalf("unsupported turn prefix %q", contract.Constants.TurnIDPrefix)
	}
	if contract.Constants.MaxTurnIDNumber != MaxTurnIDNumber ||
		contract.Constants.TurnIDExhaustedSentinel != turnIDExhaustedSentinel {
		t.Fatal("runtime turn-ID range differs from the shared contract")
	}
	for _, test := range contract.Cases.TurnCounters {
		t.Run(test.ID, func(t *testing.T) {
			session := NewSession("contract")
			session.AddPlayer("Avery")
			session.AddPlayer("Blair")
			if err := session.SetTopics([]string{"First", "Second"}); err != nil {
				t.Fatal(err)
			}
			session.NextTurnNumber = test.InitialNextTurn
			for _, id := range test.CompletedTurnIDs {
				session.CompletedTurns = append(session.CompletedTurns, Turn{ID: id})
			}

			var allocated *Turn
			var err error
			switch test.Allocation {
			case "start_turn":
				allocated, err = session.StartTurn()
			case "redraw_turn":
				if test.ActiveTurnID == nil {
					t.Fatal("redraw fixture requires an active turn")
				}
				session.Started = true
				session.ActiveTurn = &Turn{ID: *test.ActiveTurnID, PlayerID: "p1", PlayerName: "Avery", Topic: "First", TopicIndex: 0}
				allocated, err = session.RedrawActiveTurn()
			default:
				t.Fatalf("unsupported allocation %q", test.Allocation)
			}
			accepted := err == nil
			if accepted != test.ExpectedAccepted {
				t.Fatalf("accepted=%v with error %v, want %v", accepted, err, test.ExpectedAccepted)
			}
			if test.ErrorCode == "turn_ids_exhausted" {
				if !errors.Is(err, ErrTurnIDsExhausted) {
					t.Fatalf("got error %v, want ErrTurnIDsExhausted", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			var allocatedID *string
			if allocated != nil {
				id := allocated.ID
				allocatedID = &id
			}
			if !reflect.DeepEqual(allocatedID, test.ExpectedAllocatedTurnID) ||
				session.NextTurnNumber != test.ExpectedNextTurn {
				t.Fatalf("got ID=%v next=%d, want %v %d", allocatedID, session.NextTurnNumber,
					test.ExpectedAllocatedTurnID, test.ExpectedNextTurn)
			}
			if test.ExpectedHistoryPreserved {
				gotIDs := make([]string, 0, len(session.CompletedTurns))
				for _, turn := range session.CompletedTurns {
					gotIDs = append(gotIDs, turn.ID)
				}
				if !slices.Equal(gotIDs, test.CompletedTurnIDs) {
					t.Fatalf("completed IDs changed to %v, want %v", gotIDs, test.CompletedTurnIDs)
				}
			}
		})
	}
}
