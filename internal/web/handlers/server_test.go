package handlers

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

func TestHomeRenders(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	res := httptest.NewRecorder()

	server.Routes().ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "Don't Stop Talking") {
		t.Fatalf("expected app title in response")
	}
}

func TestStartGameRendersTurn(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/game/start", nil)
	res := httptest.NewRecorder()

	server.Routes().ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), "Start Talking") {
		t.Fatalf("expected turn controls in response")
	}
	if !strings.Contains(res.Body.String(), "Manual Timer") {
		t.Fatalf("expected manual timer control in response")
	}
	if !strings.Contains(res.Body.String(), "Auto-detect") {
		t.Fatalf("expected automatic microphone option in response")
	}
}

func TestSettingsUpdateRendersFreshSetupSummary(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/settings", formBody(url.Values{
		"duration":  {"10"},
		"silence":   {"1"},
		"rounds":    {"2"},
		"topicPack": {"absurd"},
	}))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res := httptest.NewRecorder()

	server.Routes().ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	for _, expected := range []string{"Absurd Arguments", "10s to survive, 1s silence limit", `value="2"`} {
		if !strings.Contains(body, expected) {
			t.Fatalf("expected %q in settings response", expected)
		}
	}
}

func TestCustomTopicsUpdateSetupSummary(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/topics/custom", formBody(url.Values{
		"topics": {"First custom topic\nSecond custom topic\nFirst custom topic"},
	}))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res := httptest.NewRecorder()

	server.Routes().ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	for _, expected := range []string{"Custom", "2 topics loaded"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("expected %q in custom topic response", expected)
		}
	}
}

func TestHomeResumesActiveTurn(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}

	start := httptest.NewRequest(http.MethodPost, "/game/start", nil)
	server.Routes().ServeHTTP(httptest.NewRecorder(), start)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	res := httptest.NewRecorder()
	server.Routes().ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", res.Code, res.Body.String())
	}
	body := res.Body.String()
	for _, expected := range []string{"<!doctype html>", "Start Talking", "/static/css/app.css"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("expected %q in resumed active turn", expected)
		}
	}
}

func TestHomeResumesScoreAndWinnerScreens(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}

	router := server.Routes()
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/game/start", nil))
	submitTurn(router, 60, true)

	scoreRes := httptest.NewRecorder()
	router.ServeHTTP(scoreRes, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(scoreRes.Body.String(), "Turn scored") {
		t.Fatalf("expected score screen on refresh, got %s", scoreRes.Body.String())
	}

	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/turn/start", nil))
	submitTurn(router, 1, false)

	winnerRes := httptest.NewRecorder()
	router.ServeHTTP(winnerRes, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(winnerRes.Body.String(), "Winner") {
		t.Fatalf("expected winner screen on refresh, got %s", winnerRes.Body.String())
	}
}

func TestSubmitTurnRendersScoreBreakdown(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}

	start := httptest.NewRequest(http.MethodPost, "/game/start", nil)
	startRes := httptest.NewRecorder()
	server.Routes().ServeHTTP(startRes, start)

	submit := httptest.NewRequest(http.MethodPost, "/turn/submit", formBody(url.Values{
		"spokenSeconds": {"60"},
		"completed":     {"true"},
		"eliminated":    {"false"},
	}))
	submit.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	submitRes := httptest.NewRecorder()
	server.Routes().ServeHTTP(submitRes, submit)

	if submitRes.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", submitRes.Code, submitRes.Body.String())
	}
	body := submitRes.Body.String()
	for _, expected := range []string{"Speaking time", "Completion bonus", "Total", "85"} {
		if !strings.Contains(body, expected) {
			t.Fatalf("expected %q in score response", expected)
		}
	}
}

func TestRenameAndMovePlayers(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}

	rename := httptest.NewRequest(http.MethodPost, "/players/rename", formBody(url.Values{
		"id":   {"p1"},
		"name": {"Avery"},
	}))
	rename.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	renameRes := httptest.NewRecorder()
	server.Routes().ServeHTTP(renameRes, rename)

	if renameRes.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", renameRes.Code, renameRes.Body.String())
	}
	if !strings.Contains(renameRes.Body.String(), `value="Avery"`) {
		t.Fatalf("expected renamed player in response")
	}

	move := httptest.NewRequest(http.MethodPost, "/players/move", formBody(url.Values{
		"id":     {"p2"},
		"offset": {"-1"},
	}))
	move.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	moveRes := httptest.NewRecorder()
	server.Routes().ServeHTTP(moveRes, move)

	if moveRes.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", moveRes.Code, moveRes.Body.String())
	}
	body := moveRes.Body.String()
	if strings.Index(body, `value="Player 2"`) > strings.Index(body, `value="Avery"`) {
		t.Fatalf("expected Player 2 before Avery after move")
	}
}

func TestRedrawTurnRendersNewTopic(t *testing.T) {
	server, err := NewServer("../templates/*.html")
	if err != nil {
		t.Fatal(err)
	}

	start := httptest.NewRequest(http.MethodPost, "/game/start", nil)
	startRes := httptest.NewRecorder()
	server.Routes().ServeHTTP(startRes, start)
	if !strings.Contains(startRes.Body.String(), "The best breakfast food") {
		t.Fatalf("expected first topic in start response")
	}

	redraw := httptest.NewRequest(http.MethodPost, "/turn/redraw", nil)
	redrawRes := httptest.NewRecorder()
	server.Routes().ServeHTTP(redrawRes, redraw)

	if redrawRes.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", redrawRes.Code, redrawRes.Body.String())
	}
	if !strings.Contains(redrawRes.Body.String(), "A tiny convenience") {
		t.Fatalf("expected redrawn topic in response")
	}
}

func formBody(values url.Values) *strings.Reader {
	return strings.NewReader(values.Encode())
}

func submitTurn(router http.Handler, spokenSeconds int, completed bool) {
	values := url.Values{
		"spokenSeconds": {strconv.Itoa(spokenSeconds)},
		"completed":     {strconv.FormatBool(completed)},
		"eliminated":    {strconv.FormatBool(!completed)},
	}
	req := httptest.NewRequest(http.MethodPost, "/turn/submit", formBody(values))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	router.ServeHTTP(httptest.NewRecorder(), req)
}
