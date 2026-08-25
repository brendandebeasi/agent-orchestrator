package httpd

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

func TestLANManagerAuthGatesSharedHandler(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok")
	})
	st := &authState{}
	st.setHash(mobilebridge.HashPassword("secret12"))
	m := NewLANManager(inner, st, 0, slog.Default(), nil, remoteWebOptions{}) // port 0 → ephemeral
	port, err := m.Start(0)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer m.Stop(context.Background())
	if !m.Running() || m.BoundPort() != port {
		t.Fatalf("running=%v boundPort=%d port=%d", m.Running(), m.BoundPort(), port)
	}

	base := fmt.Sprintf("http://127.0.0.1:%d/anything", port)
	// no auth → 401
	resp, _ := http.Get(base)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no-auth: got %d want 401", resp.StatusCode)
	}
	// with auth → 200
	req, _ := http.NewRequest(http.MethodGet, base, nil)
	req.Header.Set("Authorization", "Bearer secret12")
	resp2, _ := http.DefaultClient.Do(req)
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("auth: got %d want 200", resp2.StatusCode)
	}
}

// TestLANManagerBlocksLoopbackOnlyControlRoutes proves the LAN listener never
// serves /shutdown, /internal/*, /api/v1/mobile*, /api/v1/dev*, or
// /api/v1/browser* — even when the request carries a spoofed Host: 127.0.0.1
// and valid LAN auth, since gating on Host alone (localControlRequest) is what
// let a LAN client reach these routes.
func TestLANManagerBlocksLoopbackOnlyControlRoutes(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok")
	})
	st := &authState{}
	st.setHash(mobilebridge.HashPassword("secret12"))
	m := NewLANManager(inner, st, 0, slog.Default(), nil, remoteWebOptions{})
	port, err := m.Start(0)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer m.Stop(context.Background())

	blocked := []string{
		"/shutdown",
		"/internal/telemetry/cli-invoked",
		"/api/v1/mobile/status",
		"/api/v1/mobile/devices",
		"/api/v1/mobile/devices/i1",
		"/api/v1/dev/import-projects",
		"/api/v1/browser/status",
		"/api/v1/system/install/tmux",
		"/api/v1/sessions/ao-1/preview/server",
	}
	for _, path := range blocked {
		req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), nil)
		req.Host = "127.0.0.1" // spoofed loopback Host
		req.Header.Set("Authorization", "Bearer secret12")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s: request failed: %v", path, err)
		}
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s: got %d want 404 (Host-spoof + valid auth must not reach control routes)", path, resp.StatusCode)
		}
	}

	// A normal app route must still be reachable through the LAN listener
	// (not swallowed by the control-route filter). Auth-gating, not the
	// control filter, decides its fate.
	req, _ := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/api/v1/sessions", port), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("sessions: request failed: %v", err)
	}
	if resp.StatusCode == http.StatusNotFound {
		t.Fatalf("/api/v1/sessions: got 404, should not be blocked by the control-route filter")
	}

}

// TestLANControlAllowsRemoteClientRoutes proves the carve-outs in
// lanControlAllowedRoutes actually reach the shared handler through a live
// listener, with auth applied. The workspace summary is the one route under
// /api/v1/desktop that a full remote client calls.
func TestLANControlAllowsRemoteClientRoutes(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok")
	})
	st := &authState{}
	st.setHash(mobilebridge.HashPassword("secret12"))
	m := NewLANManager(inner, st, 0, slog.Default(), nil, remoteWebOptions{})
	port, err := m.Start(0)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer m.Stop(context.Background())

	url := fmt.Sprintf("http://127.0.0.1:%d/api/v1/desktop/sessions/ao-1/workspace", port)
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", "Bearer secret12")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("got %d want 200 — the allowed route must reach the shared handler", resp.StatusCode)
	}

	// The carve-out is not a hole in auth: without a credential it is still 401.
	unauth, err := http.Get(url)
	if err != nil {
		t.Fatalf("unauthenticated request failed: %v", err)
	}
	if unauth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated: got %d want 401", unauth.StatusCode)
	}
}

// TestLANControlBlockDefaultsToBlockedUnderCarvedPrefix pins the property that
// makes the allow-list safe: /api/v1/desktop stays in lanControlBlockedPrefixes,
// so a route added under it later is blocked until someone names it. The
// invented paths below are deliberately not real routes — they must be refused
// on their prefix alone.
func TestLANControlBlockDefaultsToBlockedUnderCarvedPrefix(t *testing.T) {
	blocked := []struct{ method, path string }{
		{http.MethodGet, "/api/v1/desktop"},
		{http.MethodGet, "/api/v1/desktop/settings"},
		{http.MethodGet, "/api/v1/desktop/sessions"},
		{http.MethodGet, "/api/v1/desktop/sessions/ao-1"},
		{http.MethodGet, "/api/v1/desktop/sessions/ao-1/workspace/files"},
		{http.MethodGet, "/api/v1/desktop/sessions/ao-1/workspace/"},
		{http.MethodGet, "/api/v1/desktop/some/route/added/next/year"},
		// Same shape, wrong method: the carve-out is read-only.
		{http.MethodPost, "/api/v1/desktop/sessions/ao-1/workspace"},
		{http.MethodPut, "/api/v1/desktop/sessions/ao-1/workspace"},
		{http.MethodPatch, "/api/v1/desktop/sessions/ao-1/workspace"},
		{http.MethodDelete, "/api/v1/desktop/sessions/ao-1/workspace"},
	}
	for _, tc := range blocked {
		if !isLANControlBlockedPath(tc.method, tc.path) {
			t.Errorf("%s %s must stay blocked on the LAN listener", tc.method, tc.path)
		}
	}

	allowed := []struct{ method, path string }{
		{http.MethodGet, "/api/v1/desktop/sessions/ao-1/workspace"},
		{http.MethodHead, "/api/v1/desktop/sessions/ao-1/workspace"},
		{http.MethodGet, "/api/v1/desktop/sessions/ao-99-with-dashes/workspace"},
	}
	for _, tc := range allowed {
		if isLANControlBlockedPath(tc.method, tc.path) {
			t.Errorf("%s %s must be allowed on the LAN listener", tc.method, tc.path)
		}
	}
}

// TestLANControlBlockedPrefixesStillBlocked walks every blocked prefix and
// asserts the prefix itself, a nested path, and a path with a query-like
// segment are all refused for every method, while a sibling that merely shares
// a string prefix is not caught.
func TestLANControlBlockedPrefixesStillBlocked(t *testing.T) {
	methods := []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete}
	for _, prefix := range lanControlBlockedPrefixes {
		trimmed := strings.TrimSuffix(prefix, "/")
		for _, path := range []string{trimmed, trimmed + "/nested", trimmed + "/nested/deeper"} {
			// The one carve-out is exempt by design; everything else stays blocked.
			for _, method := range methods {
				if isLANControlAllowedRoute(method, path) {
					continue
				}
				if !isLANControlBlockedPath(method, path) {
					t.Errorf("%s %s must stay blocked on the LAN listener", method, path)
				}
			}
		}
		// A sibling route that shares a string prefix but not a segment
		// boundary must not be swept up.
		sibling := trimmed + "app"
		if isLANControlBlockedPath(http.MethodGet, sibling) {
			t.Errorf("GET %s must not be blocked — it is a sibling, not a nested route", sibling)
		}
	}
}

func TestMatchLANRoutePattern(t *testing.T) {
	cases := []struct {
		pattern string
		path    string
		want    bool
	}{
		{"/a/{}/b", "/a/x/b", true},
		{"/a/{}/b", "/a/x/b/c", false},
		{"/a/{}/b", "/a/b", false},
		{"/a/{}/b", "/a//b", false},
		{"/a/{}/b", "/a/x/b/", false},
		{"/a/{}/b", "/a/x/c", false},
		{"/a/{}/b", "/A/x/b", false},
	}
	for _, tc := range cases {
		if got := matchLANRoutePattern(tc.pattern, tc.path); got != tc.want {
			t.Errorf("matchLANRoutePattern(%q, %q) = %v, want %v", tc.pattern, tc.path, got, tc.want)
		}
	}
}

func TestLANManagerStartStopIdempotent(t *testing.T) {
	m := NewLANManager(http.NotFoundHandler(), &authState{}, 0, slog.Default(), nil, remoteWebOptions{})
	p1, _ := m.Start(0)
	p2, _ := m.Start(0) // idempotent — same port, no error
	if p1 != p2 {
		t.Fatalf("second start changed port: %d != %d", p1, p2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := m.Stop(ctx); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if m.Running() {
		t.Fatal("still running after stop")
	}
	_ = m.Stop(ctx) // second stop is a no-op
}
