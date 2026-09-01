package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/Aakash1337/NonStopTalk/internal/game"
)

type handlerContractFixture struct {
	SchemaVersion int `json:"schemaVersion"`
	Cases         struct {
		RemoteTurnClaims []struct {
			ID                    string `json:"id"`
			DurationSeconds       int    `json:"durationSeconds"`
			ClaimedSpokenSeconds  int    `json:"claimedSpokenSeconds"`
			RequestedCompleted    bool   `json:"requestedCompleted"`
			Eliminated            bool   `json:"eliminated"`
			ServerElapsedSeconds  int    `json:"serverElapsedSeconds"`
			ExpectedSpokenSeconds int    `json:"expectedSpokenSeconds"`
			ExpectedCompleted     bool   `json:"expectedCompleted"`
		} `json:"remoteTurnClaims"`
		ScoreCorrections []struct {
			ID                     string `json:"id"`
			PlayerID               string `json:"playerId"`
			InitialScore           int    `json:"initialScore"`
			RequestedDelta         int    `json:"requestedDelta"`
			ExpectedScore          int    `json:"expectedScore"`
			ExpectedAccepted       bool   `json:"expectedAccepted"`
			ErrorCode              string `json:"errorCode"`
			ExpectedVersionChanged *bool  `json:"expectedVersionChanged"`
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
			} `json:"expected"`
		} `json:"customTopics"`
		TurnCounters []struct {
			ID                       string   `json:"id"`
			InitialNextTurn          int64    `json:"initialNextTurn"`
			CompletedTurnIDs         []string `json:"completedTurnIds"`
			ExpectedNextTurn         int64    `json:"expectedNextTurn"`
			ExpectedAccepted         bool     `json:"expectedAccepted"`
			ErrorCode                string   `json:"errorCode"`
			ExpectedHistoryPreserved bool     `json:"expectedHistoryPreserved"`
			ExpectedVersionChanged   *bool    `json:"expectedVersionChanged"`
		} `json:"turnCounters"`
	} `json:"cases"`
}

func loadHandlerContract(t *testing.T) handlerContractFixture {
	t.Helper()
	path := filepath.Join("..", "..", "..", "testdata", "game-contract.v1.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read game contract: %v", err)
	}
	var fixture handlerContractFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode game contract: %v", err)
	}
	if fixture.SchemaVersion != 1 {
		t.Fatalf("unsupported game contract schema %d", fixture.SchemaVersion)
	}
	return fixture
}

func TestGameContractRemoteTurnClaims(t *testing.T) {
	contract := loadHandlerContract(t)
	for _, test := range contract.Cases.RemoteTurnClaims {
		t.Run(test.ID, func(t *testing.T) {
			spoken, completed := normalizeRemoteTurnClaim(test.ClaimedSpokenSeconds, test.RequestedCompleted,
				test.Eliminated, test.ServerElapsedSeconds, test.DurationSeconds)
			if spoken != test.ExpectedSpokenSeconds || completed != test.ExpectedCompleted {
				t.Fatalf("got spoken=%d completed=%v, want %d %v", spoken, completed,
					test.ExpectedSpokenSeconds, test.ExpectedCompleted)
			}
		})
	}
}

func TestGameContractUnknownScoreIsRejectedWithoutRoomMutation(t *testing.T) {
	contract := loadHandlerContract(t)
	for _, test := range contract.Cases.ScoreCorrections {
		if test.ExpectedAccepted || test.ErrorCode != "player_not_found" || test.ExpectedVersionChanged == nil {
			continue
		}
		t.Run(test.ID, func(t *testing.T) {
			server, err := NewServer("../templates/*.html")
			if err != nil {
				t.Fatal(err)
			}
			router := server.Routes()
			host := newClient(t, router)
			code := host.createRoom("Avery")
			rm, err := server.rooms.Get(code)
			if err != nil {
				t.Fatal(err)
			}
			rm.Do(func() { rm.Session.Players[0].Score = test.InitialScore })
			beforeVersion := rm.Version()

			res := host.do(http.MethodPost, "/room/"+code+"/score/override", url.Values{
				"playerID": {test.PlayerID}, "delta": {strconv.Itoa(test.RequestedDelta)},
			})
			if !strings.Contains(res.Body.String(), "player is no longer") {
				t.Fatalf("expected stale-player message, got %s", res.Body.String())
			}
			if changed := rm.Version() != beforeVersion; changed != *test.ExpectedVersionChanged {
				t.Fatalf("version changed=%v, want %v", changed, *test.ExpectedVersionChanged)
			}
			rm.View(func() {
				if rm.Session.Players[0].Score != test.ExpectedScore {
					t.Fatalf("score=%d, want %d", rm.Session.Players[0].Score, test.ExpectedScore)
				}
			})
		})
	}
}

func TestGameContractEmptyCustomTopicsHandlerIsAtomic(t *testing.T) {
	contract := loadHandlerContract(t)
	for _, test := range contract.Cases.CustomTopics {
		t.Run(test.ID, func(t *testing.T) {
			server, err := NewServer("../templates/*.html")
			if err != nil {
				t.Fatal(err)
			}
			router := server.Routes()
			host := newClient(t, router)
			code := host.createRoom("Avery")
			rm, err := server.rooms.Get(code)
			if err != nil {
				t.Fatal(err)
			}
			rm.Do(func() {
				rm.Session.Topics = append([]string(nil), test.Initial.Topics...)
				rm.Session.Settings.TopicPackID = test.Initial.TopicPack
				rm.Session.TopicDeck = append([]int(nil), test.Initial.Deck...)
				rm.Session.TopicDeckCursor = test.Initial.DeckCursor
			})
			beforeVersion := rm.Version()

			res := host.do(http.MethodPost, "/room/"+code+"/topics/custom", url.Values{
				"topics": {strings.Join(test.InputTopics, "\n")},
			})
			if !strings.Contains(res.Body.String(), game.ErrTopicsRequired.Error()) {
				t.Fatalf("expected topics-required message, got %s", res.Body.String())
			}
			if rm.Version() != beforeVersion {
				t.Fatalf("rejected topics changed version from %d to %d", beforeVersion, rm.Version())
			}
			rm.View(func() {
				if !reflect.DeepEqual(rm.Session.Topics, test.Expected.Topics) ||
					rm.Session.Settings.TopicPackID != test.Expected.TopicPack ||
					!reflect.DeepEqual(rm.Session.TopicDeck, test.Expected.Deck) ||
					rm.Session.TopicDeckCursor != test.Expected.DeckCursor {
					t.Fatalf("rejected custom topics mutated state: %+v", rm.Session)
				}
			})
		})
	}
}

func TestGameContractExhaustedTurnIDsRejectStartWithoutRoomMutation(t *testing.T) {
	contract := loadHandlerContract(t)
	for _, test := range contract.Cases.TurnCounters {
		if test.ExpectedAccepted || test.ErrorCode != "turn_ids_exhausted" || test.ExpectedVersionChanged == nil {
			continue
		}
		for _, endpoint := range []string{"start", "reset"} {
			t.Run(test.ID+"/"+endpoint, func(t *testing.T) {
				server, err := NewServer("../templates/*.html")
				if err != nil {
					t.Fatal(err)
				}
				router := server.Routes()
				host := newClient(t, router)
				code := host.createRoom("Avery")
				rm, err := server.rooms.Get(code)
				if err != nil {
					t.Fatal(err)
				}
				rm.Do(func() {
					rm.Session.AddPlayer("Blair")
					rm.Session.NextTurnNumber = test.InitialNextTurn
					rm.Session.CompletedTurns = nil
					for _, id := range test.CompletedTurnIDs {
						rm.Session.CompletedTurns = append(rm.Session.CompletedTurns, game.Turn{ID: id})
					}
					if endpoint == "reset" {
						rm.Session.Started = true
						rm.Session.Finished = true
						rm.Session.CurrentRound = 2
						rm.Session.Players[0].Score = 33
					}
				})
				beforeVersion := rm.Version()
				var beforeSession []byte
				rm.View(func() { beforeSession, _ = json.Marshal(rm.Session) })

				path := "/room/" + code + "/game/" + endpoint
				res := host.do(http.MethodPost, path, nil)
				if !strings.Contains(res.Body.String(), game.ErrTurnIDsExhausted.Error()) {
					t.Fatalf("expected turn-ID exhaustion message, got %s", res.Body.String())
				}
				if changed := rm.Version() != beforeVersion; changed != *test.ExpectedVersionChanged {
					t.Fatalf("version changed=%v, want %v", changed, *test.ExpectedVersionChanged)
				}
				var afterSession []byte
				rm.View(func() { afterSession, _ = json.Marshal(rm.Session) })
				if !reflect.DeepEqual(afterSession, beforeSession) {
					t.Fatalf("rejected %s mutated session\nbefore=%s\nafter=%s", endpoint, beforeSession, afterSession)
				}
			})
		}
	}
}

type emptyContractGenerator struct{}

func (emptyContractGenerator) GenerateTopics(context.Context, string) ([]string, error) {
	return []string{" ", "\t"}, nil
}

func TestEmptyPresetAndGeneratedTopicsPreserveSetup(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}
	server.SetTopicGenerator(emptyContractGenerator{})
	router := server.Routes()
	host := newClient(t, router)
	code := host.createRoom("Avery")
	rm, err := server.rooms.Get(code)
	if err != nil {
		t.Fatal(err)
	}

	type snapshot struct {
		Settings game.Settings
		Topics   []string
		Deck     []int
		Cursor   int
	}
	takeSnapshot := func() snapshot {
		var got snapshot
		rm.View(func() {
			got.Settings = rm.Session.Settings
			got.Topics = append([]string(nil), rm.Session.Topics...)
			got.Deck = append([]int(nil), rm.Session.TopicDeck...)
			got.Cursor = rm.Session.TopicDeckCursor
		})
		return got
	}

	before := takeSnapshot()
	beforeVersion := rm.Version()
	res := host.do(http.MethodPost, "/room/"+code+"/presets/apply", url.Values{
		"duration": {"10"}, "silence": {"1"}, "rounds": {"3"},
		"topicPack": {"custom"}, "topics": {" \n\t"},
	})
	if !strings.Contains(res.Body.String(), game.ErrTopicsRequired.Error()) {
		t.Fatalf("expected preset topics-required message, got %s", res.Body.String())
	}
	if after := takeSnapshot(); !reflect.DeepEqual(after, before) || rm.Version() != beforeVersion {
		t.Fatalf("invalid preset mutated setup: before=%+v after=%+v", before, after)
	}

	res = host.do(http.MethodPost, "/room/"+code+"/topics/generate", url.Values{"theme": {"empty"}})
	if !strings.Contains(res.Body.String(), "no usable topics") {
		t.Fatalf("expected empty-generation message, got %s", res.Body.String())
	}
	if after := takeSnapshot(); !reflect.DeepEqual(after, before) || rm.Version() != beforeVersion {
		t.Fatalf("empty generated list mutated setup: before=%+v after=%+v", before, after)
	}
}
