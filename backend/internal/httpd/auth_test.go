package httpd

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

func newAuthUnderTest(pw string, now func() time.Time) (http.Handler, *lockout) {
	st := &authState{}
	h := mobilebridge.HashPassword(pw)
	st.setHash(h)
	lock := newLockout(5, time.Minute, now)
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	return authMiddleware(st, lock, nil)(ok), lock
}

func req(auth string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/v1/sessions", nil)
	r.RemoteAddr = "192.168.1.50:5555"
	if auth != "" {
		r.Header.Set("Authorization", auth)
	}
	return r
}

func reqFrom(remoteAddr, auth string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/v1/sessions", nil)
	r.RemoteAddr = remoteAddr
	if auth != "" {
		r.Header.Set("Authorization", auth)
	}
	return r
}

func TestAuthLockoutResetsAfterCooldown(t *testing.T) {
	nowP := time.Now()
	h, _ := newAuthUnderTest("secret12", func() time.Time { return nowP })
	// Lock the source with 5 failures.
	for i := 0; i < 5; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req("Bearer wrong"))
	}
	// Still within cooldown → 429 even with the right password.
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req("Bearer secret12"))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("during cooldown: got %d want 429", w.Code)
	}
	// Advance past the 1-minute cooldown.
	nowP = nowP.Add(time.Minute + time.Second)
	// A single WRONG attempt must NOT immediately re-lock — it starts a fresh
	// window and returns 401, not 429.
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req("Bearer wrong"))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("first attempt after cooldown: got %d want 401 (fresh window, not re-locked)", w.Code)
	}
	// And the correct password now succeeds.
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req("Bearer secret12"))
	if w.Code != http.StatusOK {
		t.Fatalf("correct password after cooldown: got %d want 200", w.Code)
	}
}

func TestAuthRejectsMissingAndWrong(t *testing.T) {
	h, _ := newAuthUnderTest("secret12", time.Now)
	for _, tc := range []struct {
		name, auth string
		want       int
	}{
		{"missing", "", http.StatusUnauthorized},
		{"wrong", "Bearer nope", http.StatusUnauthorized},
		{"right", "Bearer secret12", http.StatusOK},
	} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req(tc.auth))
		if w.Code != tc.want {
			t.Errorf("%s: got %d want %d", tc.name, w.Code, tc.want)
		}
	}
}

func TestAuthLockoutAfterFive(t *testing.T) {
	now := time.Now()
	h, _ := newAuthUnderTest("secret12", func() time.Time { return now })
	for i := 0; i < 5; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req("Bearer wrong"))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: got %d want 401", i, w.Code)
		}
	}
	// 6th attempt — even with the RIGHT password — is locked out.
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req("Bearer secret12"))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("locked attempt: got %d want 429", w.Code)
	}
}

// reqPathCookie builds a request to an arbitrary path, optionally carrying the
// Bearer header and/or the preview auth cookie, for the preview-cookie tests.
func reqPathCookie(method, path, auth, cookie string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	r.RemoteAddr = "192.168.1.50:5555"
	if auth != "" {
		r.Header.Set("Authorization", auth)
	}
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: authCookieName, Value: cookie})
	}
	return r
}

// A preview subresource (image/CSS/JS) is fetched by the WebView WITHOUT our
// Authorization header, carrying only the cookie the top-level load set. It must
// authenticate on the preview-files path.
func TestPreviewCookieAuthenticatesSubresource(t *testing.T) {
	h, _ := newAuthUnderTest("secret12", time.Now)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, reqPathCookie(http.MethodGet, "/api/v1/sessions/abc/preview/files/logo.png", "", "secret12"))
	if w.Code != http.StatusOK {
		t.Fatalf("preview subresource with cookie: got %d want 200", w.Code)
	}
}

// The top-level preview file load (Bearer header) must set the auth cookie,
// scoped tightly to that session's preview-files directory and HttpOnly.
func TestPreviewFileSetsScopedCookie(t *testing.T) {
	h, _ := newAuthUnderTest("secret12", time.Now)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, reqPathCookie(http.MethodGet, "/api/v1/sessions/abc/preview/files/index.html", "Bearer secret12", ""))
	if w.Code != http.StatusOK {
		t.Fatalf("preview index with bearer: got %d want 200", w.Code)
	}
	var c *http.Cookie
	for _, ck := range w.Result().Cookies() {
		if ck.Name == authCookieName {
			c = ck
		}
	}
	if c == nil {
		t.Fatal("expected auth cookie on preview file response")
		return
	}
	if c.Path != "/api/v1/sessions/abc/preview/files/" { //nolint:staticcheck // SA5011 false positive: t.Fatal above halts the test
		t.Errorf("cookie Path = %q, want /api/v1/sessions/abc/preview/files/", c.Path)
	}
	if !c.HttpOnly {
		t.Error("cookie must be HttpOnly")
	}
}

// After a password regenerate the WebView still holds the cookie minted under the
// OLD password. The top-level load re-authenticates via the Bearer header (the
// mobile app has the new password), so the server must overwrite the stale cookie
// — otherwise the page's subresources keep sending the old token and 401.
func TestPreviewCookieRefreshedAfterPasswordChange(t *testing.T) {
	h, _ := newAuthUnderTest("newpass12", time.Now)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, reqPathCookie(http.MethodGet,
		"/api/v1/sessions/abc/preview/files/index.html", "Bearer newpass12", "oldpass12"))
	if w.Code != http.StatusOK {
		t.Fatalf("preview index with new bearer + stale cookie: got %d want 200", w.Code)
	}
	var c *http.Cookie
	for _, ck := range w.Result().Cookies() {
		if ck.Name == authCookieName {
			c = ck
		}
	}
	if c == nil {
		t.Fatal("expected stale auth cookie to be refreshed")
		return
	}
	if c.Value != "newpass12" { //nolint:staticcheck // SA5011 false positive: t.Fatal above halts the test
		t.Errorf("cookie Value = %q, want the current token newpass12", c.Value)
	}
}

// The cookie must NOT authenticate any non-preview endpoint: a preview page that
// tries POST /kill with only the cookie is rejected. This is the server-side
// half of the guarantee (the cookie's Path already stops the browser sending it
// here at all).
func TestPreviewCookieRejectedOnOtherEndpoints(t *testing.T) {
	h, _ := newAuthUnderTest("secret12", time.Now)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, reqPathCookie(http.MethodPost, "/api/v1/sessions/abc/kill", "", "secret12"))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("cookie on /kill: got %d want 401", w.Code)
	}
}

// A normal (non-preview) authenticated request must not get an auth cookie set,
// so the cookie only ever exists for the preview flow.
func TestNoCookieSetOnNonPreviewRoutes(t *testing.T) {
	h, _ := newAuthUnderTest("secret12", time.Now)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req("Bearer secret12")) // path /api/v1/sessions
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200", w.Code)
	}
	for _, ck := range w.Result().Cookies() {
		if ck.Name == authCookieName {
			t.Fatal("auth cookie must not be set on a non-preview route")
		}
	}
}

// The web client's asset cookie is scoped the same way the preview cookie is:
// honored on exactly one route family and inert everywhere else. A browser
// attaches a cookie to a same-origin request whether or not the page chose to
// send it, so a cookie that authenticated anything that acts would be a
// cross-site request forgery waiting for an origin check to slip.
func TestWebClientCookieScope(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		path       string
		wantStatus int
	}{
		{
			name:       "authenticates the entry point",
			method:     http.MethodGet,
			path:       "/app/index.html",
			wantStatus: http.StatusOK,
		},
		{
			name:       "authenticates a HEAD of an asset",
			method:     http.MethodHead,
			path:       "/app/assets/app-a1b2.js",
			wantStatus: http.StatusOK,
		},
		{
			name:       "does not authenticate the API",
			method:     http.MethodGet,
			path:       "/api/v1/sessions",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "does not authenticate the terminal stream",
			method:     http.MethodGet,
			path:       "/mux",
			wantStatus: http.StatusUnauthorized,
		},
		{
			// The prefix is not enough on its own: a write under it is refused
			// even though a read of the same path is allowed.
			name:       "does not authenticate a write under the asset prefix",
			method:     http.MethodPost,
			path:       "/app/index.html",
			wantStatus: http.StatusUnauthorized,
		},
		{
			// A path that merely starts with the same characters is a
			// different route, and the prefix check must not admit it.
			name:       "does not authenticate a lookalike prefix",
			method:     http.MethodGet,
			path:       "/appliance/state",
			wantStatus: http.StatusUnauthorized,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h, _ := newAuthUnderTest("secret12", time.Now)
			r := httptest.NewRequest(tt.method, tt.path, nil)
			r.RemoteAddr = "192.168.1.50:5555"
			r.AddCookie(&http.Cookie{Name: remoteWebCookieName, Value: "secret12"})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tt.wantStatus {
				t.Fatalf("%s %s with only the asset cookie: got %d want %d",
					tt.method, tt.path, w.Code, tt.wantStatus)
			}
		})
	}
}

// wsReq builds a WebSocket handshake for /mux offering the given subprotocols.
func wsReq(subprotocols ...string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/mux", nil)
	r.RemoteAddr = "192.168.1.50:5555"
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Connection", "keep-alive, Upgrade")
	for _, p := range subprotocols {
		r.Header.Add("Sec-WebSocket-Protocol", p)
	}
	return r
}

func encodeMuxAuth(password string) string {
	return muxAuthSubprotocolPrefix + base64.RawURLEncoding.EncodeToString([]byte(password))
}

// The subprotocol credential is the browser's only way in, since a browser can
// set no headers on a WebSocket handshake.
func TestSubprotocolCredentialAuthenticatesUpgrade(t *testing.T) {
	h, _ := newAuthUnderTest("secret12", time.Now)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, wsReq(encodeMuxAuth("secret12")))
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200", w.Code)
	}
}

// A subprotocol offered alongside others must still be found: browsers send the
// full offer list in one header, comma-separated.
func TestSubprotocolCredentialFoundAmongOthers(t *testing.T) {
	h, _ := newAuthUnderTest("secret12", time.Now)
	w := httptest.NewRecorder()
	r := wsReq()
	r.Header.Set("Sec-WebSocket-Protocol", "ao.mux.v1, "+encodeMuxAuth("secret12"))
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d want 200", w.Code)
	}
}

// The subprotocol is read only on a real handshake. A plain request that merely
// carries the header must not authenticate — otherwise the whole API would
// accept a credential in a header no CORS preflight ever screens.
func TestSubprotocolCredentialIgnoredOnPlainRequest(t *testing.T) {
	h, _ := newAuthUnderTest("secret12", time.Now)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/sessions", nil)
	r.RemoteAddr = "192.168.1.50:5555"
	r.Header.Set("Sec-WebSocket-Protocol", encodeMuxAuth("secret12"))
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401 — the subprotocol credential must only count on a WebSocket upgrade", w.Code)
	}
}

func TestSubprotocolCredentialRejectsBadValues(t *testing.T) {
	cases := []struct {
		name string
		req  *http.Request
	}{
		{"wrong password", wsReq(encodeMuxAuth("wrongpass"))},
		{"not base64url", wsReq(muxAuthSubprotocolPrefix + "not!base64")},
		{"empty payload", wsReq(muxAuthSubprotocolPrefix)},
		{"unrelated subprotocol", wsReq("ao.mux.v1")},
		{"raw password, unencoded", wsReq(muxAuthSubprotocolPrefix + "secret12!")},
		{"no subprotocol at all", wsReq()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := newAuthUnderTest("secret12", time.Now)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, tc.req)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("got %d want 401", w.Code)
			}
		})
	}
}

// The token is never read from the URL: a query string is not a credential.
func TestCredentialNeverReadFromQueryString(t *testing.T) {
	h, _ := newAuthUnderTest("secret12", time.Now)
	for _, target := range []string{
		"/mux?token=secret12",
		"/mux?password=secret12",
		"/api/v1/sessions?token=secret12",
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, target, nil)
		r.RemoteAddr = "192.168.1.50:5555"
		h.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s: got %d want 401", target, w.Code)
		}
	}
}

// A failed upgrade counts toward the same per-source lockout as a failed HTTP
// request, so the handshake is not a rate-limit-free guessing oracle.
func TestSubprotocolFailuresShareTheLockout(t *testing.T) {
	h, _ := newAuthUnderTest("secret12", time.Now)
	for i := 0; i < 5; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, wsReq(encodeMuxAuth("guess")))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: got %d want 401", i, w.Code)
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req("Bearer secret12")) // same source, correct password, plain HTTP
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("got %d want 429 — upgrade failures must feed the shared lockout", w.Code)
	}
}

func TestAuthLockoutIsPerSource(t *testing.T) {
	now := time.Now()
	h, _ := newAuthUnderTest("secret12", func() time.Time { return now })

	// Source A: lock with 5 failed attempts from 192.168.1.50
	sourceA := "192.168.1.50:5555"
	for i := 0; i < 5; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, reqFrom(sourceA, "Bearer wrong"))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("source A attempt %d: got %d want 401", i, w.Code)
		}
	}
	// Verify source A is now locked
	w := httptest.NewRecorder()
	h.ServeHTTP(w, reqFrom(sourceA, "Bearer secret12"))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("source A locked check: got %d want 429", w.Code)
	}

	// Source B: should NOT be locked despite source A being locked
	sourceB := "192.168.1.99:6666"
	// B with correct password should be 200, not 429
	w = httptest.NewRecorder()
	h.ServeHTTP(w, reqFrom(sourceB, "Bearer secret12"))
	if w.Code != http.StatusOK {
		t.Fatalf("source B with correct password: got %d want 200", w.Code)
	}

	// B with wrong password should be 401, not 429
	w = httptest.NewRecorder()
	h.ServeHTTP(w, reqFrom(sourceB, "Bearer wrong"))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("source B with wrong password: got %d want 401", w.Code)
	}
}
