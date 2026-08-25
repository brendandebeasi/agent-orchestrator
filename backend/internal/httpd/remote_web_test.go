package httpd

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

const remoteWebPassword = "secret12"

// remoteWebTestAssets stands in for the bundle `npm run build:web` writes into
// webclient/. Only the shapes the handler distinguishes matter: an entry point,
// a hashed asset beside it, and nothing else.
func remoteWebTestAssets() fs.FS {
	return fstest.MapFS{
		"index.html":          {Data: []byte("<!doctype html><title>client</title>")},
		"assets/app-a1b2.js":  {Data: []byte("export default 1;")},
		"assets/app-a1b2.css": {Data: []byte(":root{}")},
	}
}

// remoteWebStack builds the network listener's full handler chain over an inner
// handler that reports whether a request reached the shared router. Reaching it
// is how a test distinguishes "the web-client layer answered" from "the request
// fell through to the API like any other".
func remoteWebStack(t *testing.T, opts remoteWebOptions) (http.Handler, func() bool) {
	t.Helper()
	state := &authState{}
	state.setHash(mobilebridge.HashPassword(remoteWebPassword))
	reached := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		w.WriteHeader(http.StatusTeapot)
	})
	m := NewLANManager(inner, state, 0, discardLogger(), nil, opts)
	return m.handler, func() bool { return reached }
}

// remoteWebRequest builds a request as it would arrive on the network listener:
// from an off-host address, so the lockout has a source key to count against.
func remoteWebRequest(method, path string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	r.RemoteAddr = "192.168.1.50:5555"
	r.Host = "192.168.1.10:3011"
	return r
}

// responseCookie returns the named cookie set on a response, or nil.
func responseCookie(w *httptest.ResponseRecorder, name string) *http.Cookie {
	for _, c := range w.Result().Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// A correct password buys the token the client attaches to its own requests
// plus the cookie the browser attaches to the asset requests it makes on its
// own. The cookie's scope is the whole point of the design, so every attribute
// that narrows it is pinned here.
func TestRemoteWebSessionIssuesScopedCookie(t *testing.T) {
	h, _ := remoteWebStack(t, remoteWebOptions{
		ServeWebClient: true,
		AppVersion:     "1.2.3",
		Assets:         remoteWebTestAssets(),
	})

	r := remoteWebRequest(http.MethodPost, remoteWebSessionPath)
	r.Header.Set("Authorization", "Bearer "+remoteWebPassword)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("POST %s: got %d want 200", remoteWebSessionPath, w.Code)
	}
	var body remoteWebSessionResponse
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode session response: %v", err)
	}
	if body.Token != remoteWebPassword {
		t.Errorf("token = %q, want the connection token", body.Token)
	}
	if body.AppVersion != "1.2.3" {
		t.Errorf("appVersion = %q, want 1.2.3", body.AppVersion)
	}

	c := responseCookie(w, remoteWebCookieName)
	if c == nil {
		t.Fatal("expected the asset cookie to be set")
		return
	}
	if c.Value != remoteWebPassword { //nolint:staticcheck // SA5011 false positive: t.Fatal above halts the test
		t.Errorf("cookie value = %q, want the connection token", c.Value)
	}
	if c.Path != remoteWebAssetPrefix {
		t.Errorf("cookie Path = %q, want %q", c.Path, remoteWebAssetPrefix)
	}
	if !c.HttpOnly {
		t.Error("cookie must be HttpOnly: no client script has any reason to read it")
	}
	if c.SameSite != http.SameSiteStrictMode {
		t.Errorf("cookie SameSite = %v, want Strict", c.SameSite)
	}
	if c.Secure {
		t.Error("cookie must not be Secure over a plain-HTTP connection, or the browser would never send it back")
	}
}

// Behind `tailscale serve` the daemon sees plain HTTP with the proxy's header,
// and the cookie must be marked Secure so it is never sent in the clear.
func TestRemoteWebSessionMarksCookieSecureBehindTLS(t *testing.T) {
	h, _ := remoteWebStack(t, remoteWebOptions{
		ServeWebClient: true,
		Assets:         remoteWebTestAssets(),
	})

	r := remoteWebRequest(http.MethodPost, remoteWebSessionPath)
	r.Header.Set("Authorization", "Bearer "+remoteWebPassword)
	r.Header.Set("X-Forwarded-Proto", "https")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	c := responseCookie(w, remoteWebCookieName)
	if c == nil {
		t.Fatal("expected the asset cookie to be set")
		return
	}
	if !c.Secure { //nolint:staticcheck // SA5011 false positive: t.Fatal above halts the test
		t.Error("cookie must be Secure when the connection to the client is encrypted")
	}
}

// A wrong password gets no token and no cookie.
func TestRemoteWebSessionRejectsWrongPassword(t *testing.T) {
	h, reached := remoteWebStack(t, remoteWebOptions{
		ServeWebClient: true,
		Assets:         remoteWebTestAssets(),
	})

	r := remoteWebRequest(http.MethodPost, remoteWebSessionPath)
	r.Header.Set("Authorization", "Bearer wrongpassword")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("bad password: got %d want 401", w.Code)
	}
	if c := responseCookie(w, remoteWebCookieName); c != nil {
		t.Error("no cookie may be issued to a failed exchange")
	}
	if reached() {
		t.Error("a failed exchange must not reach the shared router")
	}
}

// The exchange runs outside authMiddleware, so it has to do the middleware's
// lockout bookkeeping itself. Without that, the one route built to take a
// password guess would be the one route where guessing is free.
func TestRemoteWebSessionCountsTowardLockout(t *testing.T) {
	h, _ := remoteWebStack(t, remoteWebOptions{
		ServeWebClient: true,
		Assets:         remoteWebTestAssets(),
	})

	for i := 0; i < 5; i++ {
		r := remoteWebRequest(http.MethodPost, remoteWebSessionPath)
		r.Header.Set("Authorization", "Bearer wrongpassword")
		h.ServeHTTP(httptest.NewRecorder(), r)
	}

	r := remoteWebRequest(http.MethodPost, remoteWebSessionPath)
	r.Header.Set("Authorization", "Bearer "+remoteWebPassword)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("correct password after 5 failures: got %d want 429", w.Code)
	}
}

// The login page is the one thing served to a caller with no credential, so it
// must not reach anywhere else: a subresource would either need its own
// unauthenticated route or would announce the daemon to whatever host served it.
func TestRemoteWebLoginPageIsSelfContained(t *testing.T) {
	h, _ := remoteWebStack(t, remoteWebOptions{
		ServeWebClient: true,
		Assets:         remoteWebTestAssets(),
	})

	w := httptest.NewRecorder()
	h.ServeHTTP(w, remoteWebRequest(http.MethodGet, "/"))

	if w.Code != http.StatusOK {
		t.Fatalf("GET / unauthenticated: got %d want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
	body := w.Body.String()
	for _, forbidden := range []string{"http://", "https://", "src=", "<link", "<img"} {
		if strings.Contains(body, forbidden) {
			t.Errorf("login page contains %q: it must pull no subresource from anywhere", forbidden)
		}
	}
	if !strings.Contains(body, remoteWebSessionPath) {
		t.Errorf("login page must post to %s", remoteWebSessionPath)
	}
}

// Someone who already holds the token should not be asked for it again.
func TestRemoteWebLoginRedirectsWhenAuthenticated(t *testing.T) {
	h, _ := remoteWebStack(t, remoteWebOptions{
		ServeWebClient: true,
		Assets:         remoteWebTestAssets(),
	})

	r := remoteWebRequest(http.MethodGet, "/")
	r.Header.Set("Authorization", "Bearer "+remoteWebPassword)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusFound {
		t.Fatalf("GET / authenticated: got %d want 302", w.Code)
	}
	if loc := w.Header().Get("Location"); loc != remoteWebAssetPrefix {
		t.Errorf("Location = %q, want %q", loc, remoteWebAssetPrefix)
	}
}

// Assets sit inside authMiddleware like every other network route: the bundle
// is not public just because it is static.
func TestRemoteWebAssetsRequireCredential(t *testing.T) {
	h, _ := remoteWebStack(t, remoteWebOptions{
		ServeWebClient: true,
		Assets:         remoteWebTestAssets(),
	})

	w := httptest.NewRecorder()
	h.ServeHTTP(w, remoteWebRequest(http.MethodGet, "/app/index.html"))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated asset read: got %d want 401", w.Code)
	}
}

func TestRemoteWebAssetsServeBundle(t *testing.T) {
	h, reached := remoteWebStack(t, remoteWebOptions{
		ServeWebClient: true,
		Assets:         remoteWebTestAssets(),
	})

	tests := []struct {
		name       string
		method     string
		path       string
		wantStatus int
		wantBody   string
	}{
		{
			name:       "entry point",
			method:     http.MethodGet,
			path:       "/app/index.html",
			wantStatus: http.StatusOK,
			wantBody:   "<title>client</title>",
		},
		{
			name:       "prefix root serves the entry point",
			method:     http.MethodGet,
			path:       "/app/",
			wantStatus: http.StatusOK,
			wantBody:   "<title>client</title>",
		},
		{
			name:       "hashed asset",
			method:     http.MethodGet,
			path:       "/app/assets/app-a1b2.js",
			wantStatus: http.StatusOK,
			wantBody:   "export default 1;",
		},
		{
			// A client-side route the bundle has no file for. The client is
			// what knows how to interpret it, so it has to be what answers.
			name:       "unknown extensionless path falls back to the entry point",
			method:     http.MethodGet,
			path:       "/app/sessions/abc/terminal",
			wantStatus: http.StatusOK,
			wantBody:   "<title>client</title>",
		},
		{
			// Not a fallback: HTML in place of a script turns a broken build
			// into a console parse error instead of a missing file.
			name:       "missing asset with an extension is a 404",
			method:     http.MethodGet,
			path:       "/app/assets/gone-c3d4.js",
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "traversal cannot escape the bundle",
			method:     http.MethodGet,
			path:       "/app/../../etc/passwd",
			wantStatus: http.StatusOK,
			wantBody:   "<title>client</title>",
		},
		{
			name:       "the client is read-only",
			method:     http.MethodPost,
			path:       "/app/index.html",
			wantStatus: http.StatusMethodNotAllowed,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := remoteWebRequest(tt.method, tt.path)
			r.Header.Set("Authorization", "Bearer "+remoteWebPassword)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)

			if w.Code != tt.wantStatus {
				t.Fatalf("%s %s: got %d want %d", tt.method, tt.path, w.Code, tt.wantStatus)
			}
			if tt.wantBody != "" && !strings.Contains(w.Body.String(), tt.wantBody) {
				t.Errorf("%s %s body = %q, want it to contain %q", tt.method, tt.path, w.Body.String(), tt.wantBody)
			}
			if reached() {
				t.Errorf("%s %s reached the shared router; the asset layer must answer it", tt.method, tt.path)
			}
		})
	}
}

// The entry point names this build's hashed filenames, so a cached copy would
// ask for assets a later build no longer has.
func TestRemoteWebEntryPointIsNotCached(t *testing.T) {
	h, _ := remoteWebStack(t, remoteWebOptions{
		ServeWebClient: true,
		Assets:         remoteWebTestAssets(),
	})

	r := remoteWebRequest(http.MethodGet, "/app/index.html")
	r.Header.Set("Authorization", "Bearer "+remoteWebPassword)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
}

// The asset cookie is what the browser sends for the requests it makes before
// any of our JavaScript exists to set a header.
func TestRemoteWebCookieAuthenticatesAssets(t *testing.T) {
	h, _ := remoteWebStack(t, remoteWebOptions{
		ServeWebClient: true,
		Assets:         remoteWebTestAssets(),
	})

	r := remoteWebRequest(http.MethodGet, "/app/assets/app-a1b2.css")
	r.AddCookie(&http.Cookie{Name: remoteWebCookieName, Value: remoteWebPassword})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("asset read with only the cookie: got %d want 200", w.Code)
	}
}

// Both opt-ins are required, and neither is sufficient alone: an operator who
// enables it on a build with no bundle gets the plain API, and a build that
// carries a bundle serves nothing until the operator asks for it.
func TestRemoteWebDisabledServesNothing(t *testing.T) {
	cases := []struct {
		name string
		opts remoteWebOptions
	}{
		{name: "operator has not opted in", opts: remoteWebOptions{Assets: remoteWebTestAssets()}},
		{name: "build carries no bundle", opts: remoteWebOptions{ServeWebClient: true}},
		{name: "neither", opts: remoteWebOptions{}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, reached := remoteWebStack(t, tc.opts)

			// The password exchange does not exist, so the route is just
			// another authenticated path through to the shared router.
			r := remoteWebRequest(http.MethodPost, remoteWebSessionPath)
			r.Header.Set("Authorization", "Bearer "+remoteWebPassword)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if !reached() {
				t.Errorf("POST %s: got %d; with the web client off it must fall through to the router",
					remoteWebSessionPath, w.Code)
			}

			// No login page: an unauthenticated request is refused the same way
			// every other network request is.
			w = httptest.NewRecorder()
			h.ServeHTTP(w, remoteWebRequest(http.MethodGet, "/"))
			if w.Code != http.StatusUnauthorized {
				t.Errorf("GET / unauthenticated: got %d want 401", w.Code)
			}

			// No assets, even with the password.
			r = remoteWebRequest(http.MethodGet, "/app/index.html")
			r.Header.Set("Authorization", "Bearer "+remoteWebPassword)
			w = httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if strings.Contains(w.Body.String(), "<title>client</title>") {
				t.Error("GET /app/index.html served the bundle with the web client off")
			}
		})
	}
}
