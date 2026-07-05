package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"dontstoptalking/internal/judge"
	"dontstoptalking/internal/room"
)

// client is a fake browser: it keeps its identity cookie across requests.
type client struct {
	t      *testing.T
	router http.Handler
	cookie string
}

func newTestRouter(t *testing.T) http.Handler {
	t.Helper()
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}
	return server.Routes()
}

func newClient(t *testing.T, router http.Handler) *client {
	return &client{t: t, router: router}
}

func (c *client) do(method, path string, form url.Values) *httptest.ResponseRecorder {
	c.t.Helper()
	var req *http.Request
	if form != nil {
		req = httptest.NewRequest(method, path, strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else {
		req = httptest.NewRequest(method, path, nil)
	}
	if c.cookie != "" {
		req.Header.Set("Cookie", c.cookie)
	}
	res := httptest.NewRecorder()
	c.router.ServeHTTP(res, req)
	for _, sc := range res.Result().Cookies() {
		if sc.Name == "dst_token" {
			c.cookie = "dst_token=" + sc.Value
		}
	}
	return res
}

var roomPathPattern = regexp.MustCompile(`^/room/([A-Z2-9]+)$`)

// createRoom creates a room as this client (becoming host) and returns its code.
func (c *client) createRoom(name string) string {
	c.t.Helper()
	res := c.do(http.MethodPost, "/rooms", url.Values{"name": {name}})
	if res.Code != http.StatusSeeOther {
		c.t.Fatalf("expected redirect after create, got %d: %s", res.Code, res.Body.String())
	}
	match := roomPathPattern.FindStringSubmatch(res.Header().Get("Location"))
	if match == nil {
		c.t.Fatalf("expected room redirect, got %q", res.Header().Get("Location"))
	}
	return match[1]
}

func (c *client) join(code, name string) *httptest.ResponseRecorder {
	c.t.Helper()
	return c.do(http.MethodPost, "/rooms/join", url.Values{"code": {code}, "name": {name}})
}

func TestLandingRenders(t *testing.T) {
	router := newTestRouter(t)
	res := newClient(t, router).do(http.MethodGet, "/", nil)
	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.Code)
	}
	body := res.Body.String()
	for _, expected := range []string{"Host a Game", "Join a Game", "Room code"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("expected %q on landing page", expected)
		}
	}
}

func TestCreateRoomAndRenderSetup(t *testing.T) {
	router := newTestRouter(t)
	host := newClient(t, router)
	code := host.createRoom("Avery")

	res := host.do(http.MethodGet, "/room/"+code, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	for _, expected := range []string{"Room " + code, "Avery", "Start Game", "Add local player"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("expected %q on setup page, got %s", expected, body)
		}
	}
}

func TestJoinRoomAddsPlayerAndReconnects(t *testing.T) {
	router := newTestRouter(t)
	host := newClient(t, router)
	code := host.createRoom("Avery")

	guest := newClient(t, router)
	res := guest.join(code, "Blair")
	if res.Code != http.StatusSeeOther || res.Header().Get("Location") != "/room/"+code {
		t.Fatalf("expected join redirect to room, got %d %q", res.Code, res.Header().Get("Location"))
	}

	// Guest sees themselves, but no host-only controls.
	page := guest.do(http.MethodGet, "/room/"+code, nil).Body.String()
	for _, expected := range []string{"Blair", "you", "Leave Room", "Waiting for the host"} {
		if !strings.Contains(page, expected) {
			t.Fatalf("expected %q on guest setup page", expected)
		}
	}
	if strings.Contains(page, "Start Game") || strings.Contains(page, "Add local player") {
		t.Fatal("guest page must not include host controls")
	}

	// Joining again with the same browser reconnects instead of adding a seat.
	guest.join(code, "Blair again")
	hostPage := host.do(http.MethodGet, "/room/"+code, nil).Body.String()
	if strings.Count(hostPage, `value="Blair"`) != 1 || strings.Contains(hostPage, "Blair again") {
		t.Fatalf("expected a single Blair seat after rejoin, got %s", hostPage)
	}

	if res := guest.join("ZZZZZZ", "Nobody"); res.Header().Get("Location") != "/?err=notfound" {
		t.Fatalf("expected notfound redirect, got %q", res.Header().Get("Location"))
	}
}

func TestGuestCannotUseHostControls(t *testing.T) {
	router := newTestRouter(t)
	host := newClient(t, router)
	code := host.createRoom("Avery")
	base := "/room/" + code

	guest := newClient(t, router)
	guest.join(code, "Blair")

	res := guest.do(http.MethodPost, base+"/game/start", nil)
	if !strings.Contains(res.Body.String(), "Only the host can start the game.") {
		t.Fatalf("expected host-only message, got %s", res.Body.String())
	}

	guest.do(http.MethodPost, base+"/settings", url.Values{"duration": {"10"}})
	page := host.do(http.MethodGet, base, nil).Body.String()
	if !strings.Contains(page, `value="60"`) {
		t.Fatal("expected settings unchanged after guest attempt")
	}

	res = guest.do(http.MethodPost, base+"/score/override", url.Values{"playerID": {"p1"}, "delta": {"50"}})
	if !strings.Contains(res.Body.String(), "Only the host can adjust scores.") {
		t.Fatalf("expected host-only message, got %s", res.Body.String())
	}
}

func TestHostRunsFullGame(t *testing.T) {
	router := newTestRouter(t)
	host := newClient(t, router)
	code := host.createRoom("Avery")
	base := "/room/" + code

	host.do(http.MethodPost, base+"/players", url.Values{"name": {"Blair"}})
	host.do(http.MethodPost, base+"/settings", url.Values{
		"duration": {"10"}, "silence": {"1"}, "rounds": {"1"}, "topicPack": {"everyday"},
	})

	res := host.do(http.MethodPost, base+"/game/start", nil)
	if !strings.Contains(res.Body.String(), "Start Talking") {
		t.Fatalf("expected play screen, got %s", res.Body.String())
	}

	// Host submissions are trusted (host override authority).
	res = host.do(http.MethodPost, base+"/turn/submit", url.Values{
		"spokenSeconds": {"10"}, "completed": {"true"}, "eliminated": {"false"},
	})
	body := res.Body.String()
	for _, expected := range []string{"Turn scored", "35 points", "Completion bonus"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("expected %q after host submit, got %s", expected, body)
		}
	}

	host.do(http.MethodPost, base+"/turn/start", nil)
	res = host.do(http.MethodPost, base+"/turn/submit", url.Values{
		"spokenSeconds": {"4"}, "completed": {"false"}, "eliminated": {"true"},
	})
	if !strings.Contains(res.Body.String(), "Winner") {
		t.Fatalf("expected winner screen, got %s", res.Body.String())
	}

	// Reset keeps the roster for the next game.
	res = host.do(http.MethodPost, base+"/game/reset", nil)
	body = res.Body.String()
	if !strings.Contains(body, "Avery") || !strings.Contains(body, "Blair") {
		t.Fatalf("expected roster preserved after reset, got %s", body)
	}
}

func TestRemoteSpeakerScoresAreServerAuthoritative(t *testing.T) {
	router := newTestRouter(t)
	host := newClient(t, router)
	code := host.createRoom("Avery")
	base := "/room/" + code

	guest := newClient(t, router)
	guest.join(code, "Blair")

	host.do(http.MethodPost, base+"/settings", url.Values{
		"duration": {"60"}, "silence": {"2"}, "rounds": {"1"}, "topicPack": {"everyday"},
	})
	host.do(http.MethodPost, base+"/game/start", nil)
	// Avery (host seat) goes first; host ends their turn honestly.
	host.do(http.MethodPost, base+"/turn/submit", url.Values{
		"spokenSeconds": {"30"}, "completed": {"false"}, "eliminated": {"false"},
	})

	// Blair is next and can start their own turn.
	res := guest.do(http.MethodPost, base+"/turn/start", nil)
	if !strings.Contains(res.Body.String(), "Start Talking") {
		t.Fatalf("expected guest to start own turn, got %s", res.Body.String())
	}

	// Blair begins speaking, then immediately claims a full completed turn.
	guest.do(http.MethodPost, base+"/turn/begin", nil)
	res = guest.do(http.MethodPost, base+"/turn/submit", url.Values{
		"spokenSeconds": {"60"}, "completed": {"true"}, "eliminated": {"false"},
	})
	body := res.Body.String()
	if !strings.Contains(body, "Winner") {
		t.Fatalf("expected winner screen after last turn, got %s", body)
	}
	if strings.Contains(body, "Completion bonus") {
		t.Fatal("expected no completion bonus for an instant claimed turn")
	}
	// The server clock observed ~0-1 seconds, so 60 claimed seconds cannot stand.
	if strings.Contains(body, "60 of 60") {
		t.Fatal("expected claimed speaking time to be capped by the server clock")
	}
}

func TestGuestCannotDriveSomeoneElsesTurn(t *testing.T) {
	router := newTestRouter(t)
	host := newClient(t, router)
	code := host.createRoom("Avery")
	base := "/room/" + code

	guest := newClient(t, router)
	guest.join(code, "Blair")
	host.do(http.MethodPost, base+"/game/start", nil)

	// Avery's turn is active; Blair cannot end or redraw it.
	res := guest.do(http.MethodPost, base+"/turn/submit", url.Values{"spokenSeconds": {"60"}, "completed": {"true"}})
	if !strings.Contains(res.Body.String(), "Only the host or the current speaker") {
		t.Fatalf("expected permission message, got %s", res.Body.String())
	}
	res = guest.do(http.MethodPost, base+"/turn/redraw", nil)
	if !strings.Contains(res.Body.String(), "Only the host or the current speaker") {
		t.Fatalf("expected permission message, got %s", res.Body.String())
	}
}

func TestLeaveRemovesSeat(t *testing.T) {
	router := newTestRouter(t)
	host := newClient(t, router)
	code := host.createRoom("Avery")
	base := "/room/" + code

	guest := newClient(t, router)
	guest.join(code, "Blair")
	res := guest.do(http.MethodPost, base+"/leave", nil)
	if res.Code != http.StatusSeeOther {
		t.Fatalf("expected redirect after leave, got %d", res.Code)
	}
	page := host.do(http.MethodGet, base, nil).Body.String()
	if strings.Contains(page, "Blair") {
		t.Fatal("expected Blair removed after leaving")
	}
}

func TestRoomFullRejectsJoin(t *testing.T) {
	router := newTestRouter(t)
	host := newClient(t, router)
	code := host.createRoom("Avery")
	base := "/room/" + code
	for i := 1; i < room.MaxPlayersPerRoom; i++ {
		host.do(http.MethodPost, base+"/players", url.Values{"name": {"Local"}})
	}

	guest := newClient(t, router)
	if res := guest.join(code, "Overflow"); res.Header().Get("Location") != "/?err=full" {
		t.Fatalf("expected full redirect, got %q", res.Header().Get("Location"))
	}
}

func TestCrossOriginPostRejected(t *testing.T) {
	router := newTestRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/rooms", strings.NewReader("name=Evil"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", "https://evil.example")
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for cross-origin post, got %d", res.Code)
	}
}

func TestJoinRateLimit(t *testing.T) {
	router := newTestRouter(t)
	guest := newClient(t, router)
	limited := false
	for i := 0; i < 25; i++ {
		res := guest.join("XXXXXX", "Spammer")
		if res.Header().Get("Location") == "/?err=rate" {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("expected join attempts to be rate limited")
	}
}

type stubJudge struct{}

func (stubJudge) Name() string { return "stub judge" }

func (stubJudge) Grade(context.Context, string, string) (judge.Verdict, error) {
	return judge.Verdict{Relevance: 0.5, Feedback: "Stub: solid effort on the topic."}, nil
}

func TestAIJudgeGradesTurnAsynchronously(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}
	server.SetJudge(stubJudge{})
	router := server.Routes()

	host := newClient(t, router)
	code := host.createRoom("Avery")
	base := "/room/" + code
	host.do(http.MethodPost, base+"/players", url.Values{"name": {"Blair"}})
	host.do(http.MethodPost, base+"/settings", url.Values{
		"duration": {"10"}, "silence": {"1"}, "rounds": {"1"},
		"topicPack": {"everyday"}, "aiJudge": {"on"},
	})
	host.do(http.MethodPost, base+"/game/start", nil)

	res := host.do(http.MethodPost, base+"/turn/submit", url.Values{
		"spokenSeconds": {"10"}, "completed": {"true"}, "eliminated": {"false"},
		"transcript":    {"I truly believe pancakes are the best breakfast food ever made"},
	})
	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", res.Code, res.Body.String())
	}

	// The verdict is applied off the request path; poll until it lands.
	deadline := time.Now().Add(3 * time.Second)
	for {
		body := host.do(http.MethodGet, base+"/partial", nil).Body.String()
		if strings.Contains(body, "Stub: solid effort on the topic.") {
			for _, expected := range []string{"AI relevance", "45 points"} {
				if !strings.Contains(body, expected) {
					t.Fatalf("expected %q with AI verdict, got %s", expected, body)
				}
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("AI verdict never applied, last body: %s", body)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestAIJudgeSkippedWithoutTranscript(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}
	server.SetJudge(stubJudge{})
	router := server.Routes()

	host := newClient(t, router)
	code := host.createRoom("Avery")
	base := "/room/" + code
	host.do(http.MethodPost, base+"/players", url.Values{"name": {"Blair"}})
	host.do(http.MethodPost, base+"/settings", url.Values{
		"duration": {"10"}, "silence": {"1"}, "rounds": {"1"},
		"topicPack": {"everyday"}, "aiJudge": {"on"},
	})
	host.do(http.MethodPost, base+"/game/start", nil)

	res := host.do(http.MethodPost, base+"/turn/submit", url.Values{
		"spokenSeconds": {"10"}, "completed": {"true"}, "eliminated": {"false"},
	})
	body := res.Body.String()
	if !strings.Contains(body, "No transcript was captured") {
		t.Fatalf("expected skipped-verdict note, got %s", body)
	}
	if strings.Contains(body, "AI relevance") {
		t.Fatal("expected no AI bonus without a transcript")
	}
}

func TestNoAIVerdictWhenDisabled(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}
	server.SetJudge(stubJudge{})
	router := server.Routes()

	host := newClient(t, router)
	code := host.createRoom("Avery")
	base := "/room/" + code
	host.do(http.MethodPost, base+"/players", url.Values{"name": {"Blair"}})
	host.do(http.MethodPost, base+"/settings", url.Values{
		"duration": {"10"}, "silence": {"1"}, "rounds": {"1"}, "topicPack": {"everyday"},
	})
	host.do(http.MethodPost, base+"/game/start", nil)

	res := host.do(http.MethodPost, base+"/turn/submit", url.Values{
		"spokenSeconds": {"10"}, "completed": {"true"}, "eliminated": {"false"},
		"transcript":    {"words that should be ignored"},
	})
	body := res.Body.String()
	if strings.Contains(body, "AI") && strings.Contains(body, "reviewing") {
		t.Fatalf("expected no AI activity when disabled, got %s", body)
	}
	time.Sleep(50 * time.Millisecond)
	after := host.do(http.MethodGet, base+"/partial", nil).Body.String()
	if strings.Contains(after, "Stub:") {
		t.Fatal("expected judge to stay uninvoked when disabled")
	}
}

type stubGenerator struct{}

func (stubGenerator) GenerateTopics(_ context.Context, theme string) ([]string, error) {
	return []string{"Stub topic one about " + theme, "Stub topic two about " + theme}, nil
}

func TestGenerateTopicsFillsCustomList(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}
	server.SetTopicGenerator(stubGenerator{})
	router := server.Routes()

	host := newClient(t, router)
	code := host.createRoom("Avery")
	base := "/room/" + code

	res := host.do(http.MethodPost, base+"/topics/generate", url.Values{"theme": {"pirates"}})
	body := res.Body.String()
	for _, expected := range []string{"2 topics loaded", "Stub topic one about pirates", "Stub topic two about pirates"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("expected %q after generation, got %s", expected, body)
		}
	}

	// The generated list is editable custom topics: it should be in the
	// textarea and selected as the Custom pack.
	if !strings.Contains(body, "Custom") {
		t.Fatal("expected custom pack selected after generation")
	}

	// Empty theme is rejected with a message.
	res = host.do(http.MethodPost, base+"/topics/generate", url.Values{"theme": {"  "}})
	if !strings.Contains(res.Body.String(), "Describe a theme") {
		t.Fatalf("expected theme-required message, got %s", res.Body.String())
	}
}

func TestGenerateTopicsIsHostOnly(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}
	server.SetTopicGenerator(stubGenerator{})
	router := server.Routes()

	host := newClient(t, router)
	code := host.createRoom("Avery")
	guest := newClient(t, router)
	guest.join(code, "Blair")

	res := guest.do(http.MethodPost, "/room/"+code+"/topics/generate", url.Values{"theme": {"pirates"}})
	if !strings.Contains(res.Body.String(), "Only the host can generate topics.") {
		t.Fatalf("expected host-only message, got %s", res.Body.String())
	}
	page := host.do(http.MethodGet, "/room/"+code, nil).Body.String()
	if strings.Contains(page, "Stub topic") {
		t.Fatal("expected guest generation attempt to change nothing")
	}
}

func TestMissingRoomRedirects(t *testing.T) {
	router := newTestRouter(t)
	c := newClient(t, router)

	res := c.do(http.MethodGet, "/room/XXXXXX", nil)
	if res.Code != http.StatusSeeOther {
		t.Fatalf("expected redirect for missing room, got %d", res.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/room/XXXXXX/partial", nil)
	req.Header.Set("HX-Request", "true")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Header().Get("HX-Redirect") != "/?err=gone" {
		t.Fatalf("expected HX-Redirect for htmx request, got %q", rec.Header().Get("HX-Redirect"))
	}
}
