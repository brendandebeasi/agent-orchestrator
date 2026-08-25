package httpd

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/ptyexec"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal"
)

// stubSource attaches a throwaway shell command instead of a real mux pane, so
// the /mux path exercises the genuine upgrade + wsjson + Serve + creack/pty flow
// without needing a runtime. The pane reports alive until the first attach
// happens (the mux refuses to attach to a dead pane), then dead, so the
// command's exit is treated as the pane being gone (no re-attach).
type stubSource struct {
	argv     []string
	attached atomic.Bool
}

func (s *stubSource) Attach(ctx context.Context, _ ports.RuntimeHandle, rows, cols uint16) (ports.Stream, error) {
	s.attached.Store(true)
	return ptyexec.Spawn(ctx, s.argv, nil, rows, cols)
}

func (s *stubSource) IsAlive(context.Context, ports.RuntimeHandle) (bool, error) {
	return !s.attached.Load(), nil
}

type terminalMuxFrame struct {
	Ch   string `json:"ch"`
	ID   string `json:"id"`
	Type string `json:"type"`
	Data string `json:"data"`
}

func dialMux(t *testing.T, mgr *terminal.Manager) (*websocket.Conn, func()) {
	t.Helper()
	router := newTestRouter(config.Config{}, discardLogger(), mgr)
	ts := httptest.NewServer(router)
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/mux"

	c, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		ts.Close()
		t.Fatalf("dial /mux: %v", err)
	}
	return c, func() {
		_ = c.Close(websocket.StatusNormalClosure, "test done")
		ts.Close()
	}
}

func readFrame(t *testing.T, c *websocket.Conn, ch, typ string, d time.Duration) terminalMuxFrame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	for {
		var f terminalMuxFrame
		if err := wsjson.Read(ctx, c, &f); err != nil {
			t.Fatalf("waiting for %s/%s: %v", ch, typ, err)
		}
		if f.Ch == ch && f.Type == typ {
			return f
		}
	}
}

func TestMuxUpgradeStreamsTerminal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY spawning not supported on Windows")
	}
	mgr := terminal.NewManager(
		&stubSource{argv: []string{"/bin/sh", "-c", "printf MUXOK; exit 0"}},
		nil, discardLogger(),
	)
	defer mgr.Close()

	c, done := dialMux(t, mgr)
	defer done()

	ctx := context.Background()
	if err := wsjson.Write(ctx, c, terminalMuxFrame{Ch: "terminal", ID: "t1", Type: "open"}); err != nil {
		t.Fatalf("write open: %v", err)
	}

	readFrame(t, c, "terminal", "opened", 3*time.Second)

	data := readFrame(t, c, "terminal", "data", 5*time.Second)
	got, _ := base64.StdEncoding.DecodeString(data.Data)
	if !strings.Contains(string(got), "MUXOK") {
		t.Fatalf("streamed data = %q, want it to contain MUXOK", got)
	}

	// The shell exits; the pane is reported gone (IsAlive=false) so we get exited.
	readFrame(t, c, "terminal", "exited", 5*time.Second)
}

// muxAuthProtocol encodes password the way a browser client must offer it.
func muxAuthProtocol(password string) string {
	return muxAuthSubprotocolPrefix + base64.RawURLEncoding.EncodeToString([]byte(password))
}

// startAuthedMux serves the mux router behind the network listener's full chain
// (control block, then auth) on a real socket, so subprotocol auth is exercised
// end to end rather than against the middleware in isolation.
func startAuthedMux(t *testing.T, mgr *terminal.Manager, password string) (wsURL string, stop func()) {
	t.Helper()
	state := &authState{}
	state.setHash(mobilebridge.HashPassword(password))
	m := NewLANManager(newTestRouter(config.Config{}, discardLogger(), mgr), state, 0, discardLogger(), nil)
	port, err := m.Start(0)
	if err != nil {
		t.Fatalf("start LAN listener: %v", err)
	}
	return fmt.Sprintf("ws://127.0.0.1:%d/mux", port), func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = m.Stop(ctx)
	}
}

// TestMuxAuthenticatesBySubprotocol covers the browser's only option: a
// WebSocket handshake carrying the connection password as a negotiated
// subprotocol, since a browser can attach no headers there.
func TestMuxAuthenticatesBySubprotocol(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY spawning not supported on Windows")
	}
	mgr := terminal.NewManager(&stubSource{argv: []string{"/bin/sh"}}, nil, discardLogger())
	defer mgr.Close()

	url, stop := startAuthedMux(t, mgr, "secret12")
	defer stop()

	protocol := muxAuthProtocol("secret12")
	c, resp, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{
		Subprotocols: []string{protocol},
	})
	if err != nil {
		t.Fatalf("dial with subprotocol credential: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "test done")

	if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != protocol {
		t.Fatalf("negotiated subprotocol = %q, want %q — a browser drops the connection when the server names none", got, protocol)
	}
	if got := c.Subprotocol(); got != protocol {
		t.Fatalf("conn subprotocol = %q, want %q", got, protocol)
	}

	// The stream carries the same data a header-authenticated client sees.
	if err := wsjson.Write(context.Background(), c, map[string]string{"ch": "system", "type": "ping"}); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	readFrame(t, c, "system", "pong", 3*time.Second)
}

// TestMuxAuthenticatesByHeader pins the native-client path: the mobile app
// sets Authorization on its handshake and negotiates no subprotocol at all.
func TestMuxAuthenticatesByHeader(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY spawning not supported on Windows")
	}
	mgr := terminal.NewManager(&stubSource{argv: []string{"/bin/sh"}}, nil, discardLogger())
	defer mgr.Close()

	url, stop := startAuthedMux(t, mgr, "secret12")
	defer stop()

	header := http.Header{}
	header.Set("Authorization", "Bearer secret12")
	c, resp, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatalf("dial with header credential: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "test done")

	if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != "" {
		t.Fatalf("negotiated subprotocol = %q, want none for a header-authenticated client", got)
	}
}

// TestMuxRefusesBadCredentials proves the handshake is refused before the
// connection is ever upgraded — for a wrong subprotocol credential, for none at
// all, and for a credential offered only in the query string.
func TestMuxRefusesBadCredentials(t *testing.T) {
	mgr := terminal.NewManager(&stubSource{argv: []string{"/bin/sh"}}, nil, discardLogger())
	defer mgr.Close()

	url, stop := startAuthedMux(t, mgr, "secret12")
	defer stop()

	cases := []struct {
		name string
		url  string
		opts *websocket.DialOptions
	}{
		{
			name: "wrong subprotocol credential",
			url:  url,
			opts: &websocket.DialOptions{Subprotocols: []string{muxAuthProtocol("wrongpass")}},
		},
		{
			name: "no credential",
			url:  url,
			opts: nil,
		},
		{
			name: "credential in query string only",
			url:  url + "?token=secret12&password=secret12",
			opts: nil,
		},
		{
			name: "subprotocol that is not base64url",
			url:  url,
			opts: &websocket.DialOptions{Subprotocols: []string{muxAuthSubprotocolPrefix + "not!base64"}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, resp, err := websocket.Dial(context.Background(), tc.url, tc.opts)
			if err == nil {
				c.Close(websocket.StatusNormalClosure, "unexpected success")
				t.Fatalf("handshake succeeded; it must be refused before the upgrade")
			}
			if resp == nil {
				t.Fatalf("no HTTP response: %v", err)
			}
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", resp.StatusCode)
			}
		})
	}
}

// TestMuxSubprotocolFailuresFeedLockout proves a guesser cannot use the
// WebSocket handshake as a rate-limit-free oracle: failed upgrades count toward
// the same per-source lockout as failed HTTP requests.
func TestMuxSubprotocolFailuresFeedLockout(t *testing.T) {
	mgr := terminal.NewManager(&stubSource{argv: []string{"/bin/sh"}}, nil, discardLogger())
	defer mgr.Close()

	url, stop := startAuthedMux(t, mgr, "secret12")
	defer stop()

	for i := 0; i < 6; i++ {
		c, _, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{
			Subprotocols: []string{muxAuthProtocol(fmt.Sprintf("guess%03d", i))},
		})
		if err == nil {
			c.Close(websocket.StatusNormalClosure, "unexpected success")
			t.Fatalf("guess %d succeeded", i)
		}
	}

	c, resp, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{
		Subprotocols: []string{muxAuthProtocol("secret12")},
	})
	if err == nil {
		c.Close(websocket.StatusNormalClosure, "unexpected success")
		t.Fatal("correct credential succeeded while locked out")
	}
	if resp == nil {
		t.Fatalf("no HTTP response: %v", err)
	}
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 after repeated failures", resp.StatusCode)
	}
}

// TestMuxOriginCheckAppliesToNetworkListenerOnly pins the split in D4: loopback
// keeps accepting any origin on the upgrade, while the network listener accepts
// only its own origin, an explicitly allowlisted one, or none at all.
func TestMuxOriginCheckAppliesToNetworkListenerOnly(t *testing.T) {
	mgr := terminal.NewManager(&stubSource{argv: []string{"/bin/sh"}}, nil, discardLogger())
	defer mgr.Close()

	// Loopback: a loopback-served page's origin still reaches the upgrade, as
	// before. corsMiddleware admits it, and the upgrade adds no check there.
	ts := httptest.NewServer(newTestRouter(config.Config{}, discardLogger(), mgr))
	defer ts.Close()
	header := http.Header{}
	header.Set("Origin", "http://localhost:5173")
	c, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(ts.URL, "http")+"/mux",
		&websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatalf("loopback dial with a loopback origin: %v — desktop behavior must not change", err)
	}
	c.Close(websocket.StatusNormalClosure, "test done")

	// Network listener: a loopback origin is NOT trusted here, because it may
	// belong to a dev server on someone else's machine. corsMiddleware would
	// admit it; the upgrade check is what refuses it.
	url, stop := startAuthedMux(t, mgr, "secret12")
	defer stop()
	foreign := http.Header{}
	foreign.Set("Origin", "http://localhost:5173")
	foreign.Set("Authorization", "Bearer secret12")
	bad, resp, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{HTTPHeader: foreign})
	if err == nil {
		bad.Close(websocket.StatusNormalClosure, "unexpected success")
		t.Fatal("upgrade from a foreign loopback origin succeeded on the network listener")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("status = %d, want 403 for a foreign-origin upgrade (err: %v)", status, err)
	}

	// Same-origin — the web client the daemon itself served — is accepted.
	sameOrigin := http.Header{}
	sameOrigin.Set("Origin", "http"+strings.TrimPrefix(strings.TrimSuffix(url, "/mux"), "ws"))
	sameOrigin.Set("Authorization", "Bearer secret12")
	ok, _, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{HTTPHeader: sameOrigin})
	if err != nil {
		t.Fatalf("same-origin dial on the network listener: %v", err)
	}
	ok.Close(websocket.StatusNormalClosure, "test done")
}

// TestNetworkUpgradeOriginAllowed covers the policy directly, including the
// remote desktop client: app://renderer is a scheme only the packaged Electron
// app registers, so it stays trusted even off-machine.
func TestNetworkUpgradeOriginAllowed(t *testing.T) {
	allowed := config.DefaultAllowedOrigins
	cases := []struct {
		origin string
		want   bool
	}{
		{"", true},                           // native client
		{"http://192.168.1.9:3011", true},    // the listener's own origin
		{"https://192.168.1.9:3011", true},   // same, behind a TLS front
		{"app://renderer", true},             // remote desktop client
		{"http://localhost:5173", false},     // someone else's dev server
		{"http://127.0.0.1:5173", false},     // same, by address
		{"https://evil.example", false},      // arbitrary web content
		{"null", false},                      // file:// and sandboxed iframes
		{"http://192.168.1.9:3011.x", false}, // suffix trickery
		{"http://x.192.168.1.9:3011", false}, // prefix trickery
	}
	for _, tc := range cases {
		r := httptest.NewRequest(http.MethodGet, "/mux", nil)
		r.Host = "192.168.1.9:3011"
		if tc.origin != "" {
			r.Header.Set("Origin", tc.origin)
		}
		if got := networkUpgradeOriginAllowed(r, allowed); got != tc.want {
			t.Errorf("networkUpgradeOriginAllowed(origin=%q) = %v, want %v", tc.origin, got, tc.want)
		}
	}
}

func TestMuxSystemPingPong(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY spawning not supported on Windows")
	}
	mgr := terminal.NewManager(&stubSource{argv: []string{"/bin/sh"}}, nil, discardLogger())
	defer mgr.Close()

	c, done := dialMux(t, mgr)
	defer done()

	ctx := context.Background()
	if err := wsjson.Write(ctx, c, map[string]string{"ch": "system", "type": "ping"}); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	readFrame(t, c, "system", "pong", 3*time.Second)
}
