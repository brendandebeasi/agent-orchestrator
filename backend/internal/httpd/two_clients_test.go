package httpd

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/ptyexec"
	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/presence"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal"
)

// One daemon, two clients, two sockets.
//
// The rest of this package tests each listener on its own, which is the right
// shape for the questions those tests ask and leaves one question unasked: a
// daemon does not have a loopback mode and a network mode, it has one router
// with two sockets in front of it, and the promise of remote access is that a
// client on either socket is the same client. Everything below builds exactly
// one of everything — one router, one terminal manager, one presence tracker,
// one event fan-out — and drives it from both sides at once.
//
// The failure these are here to catch is the plausible-looking one: a state
// keyed by listener, a subscriber registry that holds a single callback, a
// terminal registry that treats the second attach as a different terminal. Each
// of those passes every single-client test in this package.

// sharedPaneSource stands in for a pane that outlives its viewers. stubSource
// cannot be reused here: it reports the pane dead once anything has attached,
// which is correct for a test with one client and fatal for a test whose whole
// point is the second one.
type sharedPaneSource struct{ argv []string }

func (s *sharedPaneSource) Attach(ctx context.Context, _ ports.RuntimeHandle, rows, cols uint16) (ports.Stream, error) {
	return ptyexec.Spawn(ctx, s.argv, nil, rows, cols)
}

func (*sharedPaneSource) IsAlive(context.Context, ports.RuntimeHandle) (bool, error) {
	return true, nil
}

// fanoutSubscriber holds every subscriber rather than the last one.
// fakeEventSubscriber keeps a single callback, which is enough for a test with
// one reader and would quietly make this one pass for the wrong reason: the
// second client's subscription would evict the first, and a fan-out assertion
// against one surviving reader proves nothing.
type fanoutSubscriber struct {
	mu   sync.Mutex
	next int
	fns  map[int]func(cdc.Event)
}

func newFanoutSubscriber() *fanoutSubscriber {
	return &fanoutSubscriber{fns: map[int]func(cdc.Event){}}
}

func (s *fanoutSubscriber) Subscribe(fn func(cdc.Event)) func() {
	s.mu.Lock()
	id := s.next
	s.next++
	s.fns[id] = fn
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		delete(s.fns, id)
		s.mu.Unlock()
	}
}

func (s *fanoutSubscriber) publish(e cdc.Event) {
	s.mu.Lock()
	fns := make([]func(cdc.Event), 0, len(s.fns))
	for _, fn := range s.fns {
		fns = append(fns, fn)
	}
	s.mu.Unlock()
	for _, fn := range fns {
		fn(e)
	}
}

func (s *fanoutSubscriber) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.fns)
}

// quietEventSource replays nothing, so every id a client reads came from a live
// publish rather than from backlog.
type quietEventSource struct{}

func (quietEventSource) EventsAfter(context.Context, int64, int) ([]cdc.Event, error) {
	return nil, nil
}

func (quietEventSource) LatestSeq(context.Context) (int64, error) { return 0, nil }

// oneDaemon is a single daemon reachable two ways.
type oneDaemon struct {
	loopbackURL string
	networkURL  string
	password    string
	presence    *presence.Tracker
	events      *fanoutSubscriber
}

// startOneDaemon builds one router and puts two listeners in front of it: the
// loopback server the desktop client talks to, and the password-protected
// network listener everything else does.
func startOneDaemon(t *testing.T, mgr *terminal.Manager) *oneDaemon {
	t.Helper()
	tracker := presence.NewTracker()
	events := newFanoutSubscriber()
	router := NewRouterWithControl(config.Config{}, discardLogger(), mgr, APIDeps{
		Presence: tracker,
		CDC:      quietEventSource{},
		Events:   events,
	}, ControlDeps{})

	loopback := httptest.NewServer(router)
	t.Cleanup(loopback.Close)

	const password = "secret12"
	state := &authState{}
	state.setHash(mobilebridge.HashPassword(password))
	lan := NewLANManager(router, state, 0, discardLogger(), nil, remoteWebOptions{})
	port, err := lan.Start(0)
	if err != nil {
		t.Fatalf("start network listener: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = lan.Stop(ctx)
	})

	return &oneDaemon{
		loopbackURL: loopback.URL,
		networkURL:  fmt.Sprintf("http://127.0.0.1:%d", port),
		password:    password,
		presence:    tracker,
		events:      events,
	}
}

// dialLoopbackMux opens /mux the way the desktop client does: no credential at
// all, because the socket itself is the authorization.
func (d *oneDaemon) dialLoopbackMux(t *testing.T) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(d.loopbackURL, "http") + "/mux"
	c, _, err := websocket.Dial(context.Background(), url, nil)
	if err != nil {
		t.Fatalf("dial loopback /mux: %v", err)
	}
	t.Cleanup(func() { _ = c.Close(websocket.StatusNormalClosure, "test done") })
	return c
}

// dialNetworkMux opens /mux the way a browser must: the password offered as a
// negotiated subprotocol, since a browser can set no headers on a handshake.
func (d *oneDaemon) dialNetworkMux(t *testing.T) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(d.networkURL, "http") + "/mux"
	c, _, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{
		Subprotocols: []string{muxAuthProtocol(d.password)},
	})
	if err != nil {
		t.Fatalf("dial network /mux: %v", err)
	}
	t.Cleanup(func() { _ = c.Close(websocket.StatusNormalClosure, "test done") })
	return c
}

// muxSizeFrame is terminalMuxFrame plus the grid. The narrower struct is what
// the rest of the mux tests need and is left alone; resize is the one frame
// type whose payload is the size.
type muxSizeFrame struct {
	Ch   string `json:"ch"`
	ID   string `json:"id"`
	Type string `json:"type"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

// waitForGrid reads resize frames off a client's socket until one carries the
// grid the caller is waiting for.
//
// Skipping past other grids is deliberate rather than lax. A client that
// reports its own size is told the new authoritative grid straight back, so the
// desktop's own 80x24 is always in flight before anything the browser causes.
// The assertion that matters is that a grid the client never asked for
// eventually arrives, so the failure to catch is the deadline, not the echo.
func waitForGrid(t *testing.T, c *websocket.Conn, id string, cols, rows uint16, d time.Duration) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	var seen []string
	for {
		var f muxSizeFrame
		if err := wsjson.Read(ctx, c, &f); err != nil {
			t.Fatalf("waiting for a resize to %dx%d on terminal %s: %v (grids seen: %v)",
				cols, rows, id, err, seen)
		}
		if f.Ch != "terminal" || f.ID != id || f.Type != "resize" {
			continue
		}
		if f.Cols == cols && f.Rows == rows {
			return
		}
		seen = append(seen, fmt.Sprintf("%dx%d", f.Cols, f.Rows))
	}
}

// TestOneDaemonSharesATerminalAcrossBothListeners is the fan-out case. Two
// clients open the same terminal id from opposite sockets at different window
// sizes; the manager picks the larger grid and has to tell both, which it can
// only do if both are members of one shared terminal.
//
// Grid reconciliation is the assertion rather than output because it is the one
// piece of terminal behavior that is genuinely about the other client: output
// arrives on each viewer's own stream and would look identical if the two were
// in separate registries, but a resize a client did not ask for can only have
// come from the other one.
func TestOneDaemonSharesATerminalAcrossBothListeners(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY spawning not supported on Windows")
	}
	mgr := terminal.NewManager(&sharedPaneSource{argv: []string{"/bin/cat"}}, nil, discardLogger())
	defer mgr.Close()
	daemon := startOneDaemon(t, mgr)

	ctx := context.Background()
	desktop := daemon.dialLoopbackMux(t)
	if err := wsjson.Write(ctx, desktop, terminalMuxFrame{Ch: "terminal", ID: "t1", Type: "open"}); err != nil {
		t.Fatalf("desktop open: %v", err)
	}
	readFrame(t, desktop, "terminal", "opened", 5*time.Second)
	if err := wsjson.Write(ctx, desktop, muxSizeFrame{Ch: "terminal", ID: "t1", Type: "resize", Cols: 80, Rows: 24}); err != nil {
		t.Fatalf("desktop resize: %v", err)
	}

	browser := daemon.dialNetworkMux(t)
	if err := wsjson.Write(ctx, browser, terminalMuxFrame{Ch: "terminal", ID: "t1", Type: "open"}); err != nil {
		t.Fatalf("browser open: %v", err)
	}
	readFrame(t, browser, "terminal", "opened", 5*time.Second)
	if err := wsjson.Write(ctx, browser, muxSizeFrame{Ch: "terminal", ID: "t1", Type: "resize", Cols: 120, Rows: 40}); err != nil {
		t.Fatalf("browser resize: %v", err)
	}

	// The desktop client asked for 80x24 and nothing since. A resize to the
	// browser's grid can only be the manager reconciling one shared terminal:
	// were the two listeners backed by separate registries, the desktop would
	// sit at its own 80x24 forever and this would time out.
	waitForGrid(t, desktop, "t1", 120, 40, 5*time.Second)
}

// TestOneDaemonCountsBothClientsAsPresent covers the tracker. Presence is
// recorded by middleware inside the shared router, so a request that arrived
// over the network listener has to reach it having passed the control block and
// auth without losing its headers on the way.
func TestOneDaemonCountsBothClientsAsPresent(t *testing.T) {
	daemon := startOneDaemon(t, nil)

	get := func(base, installID string, authorize bool) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, base+"/api/v1/sessions", nil)
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		req.Header.Set(InstallIDHeader, installID)
		if authorize {
			req.Header.Set("Authorization", "Bearer "+daemon.password)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", base, err)
		}
		defer resp.Body.Close()
		// The deps are empty, so the controller answers 501. That is the honest
		// boundary of this case: it is about the request reaching the shared
		// router at all, not about what the session service would have said.
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusNotFound {
			t.Fatalf("GET %s = %d — the request never reached the shared router", base, resp.StatusCode)
		}
	}

	get(daemon.loopbackURL, "desktop-1", false)
	get(daemon.networkURL, "browser-1", true)

	live := daemon.presence.Live()
	if !live["desktop-1"] || !live["browser-1"] {
		t.Fatalf("live = %+v, want both clients — one tracker serves both listeners", live)
	}
}

// TestOneDaemonStreamsChangesToBothClients covers the change feed both clients
// live on: the session list, the board, and the workspace file watch are all
// repaints driven by it, so a client that misses events is a client showing
// yesterday's screen with no indication anything is wrong.
func TestOneDaemonStreamsChangesToBothClients(t *testing.T) {
	daemon := startOneDaemon(t, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	openStream := func(base string, authorize bool) io.Reader {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/v1/events?after=0", nil)
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		if authorize {
			req.Header.Set("Authorization", "Bearer "+daemon.password)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET %s/api/v1/events: %v", base, err)
		}
		t.Cleanup(func() { _ = resp.Body.Close() })
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("GET %s/api/v1/events = %d, body = %s", base, resp.StatusCode, body)
		}
		return resp.Body
	}

	desktop := openStream(daemon.loopbackURL, false)
	browser := openStream(daemon.networkURL, true)

	// Both readers have to be subscribed before the publish, or this measures
	// the race and not the fan-out.
	deadline := time.Now().Add(5 * time.Second)
	for daemon.events.count() < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("only %d of 2 clients subscribed", daemon.events.count())
		}
		time.Sleep(10 * time.Millisecond)
	}

	daemon.events.publish(testCDCEvent(7))

	for name, reader := range map[string]io.Reader{"desktop": desktop, "browser": browser} {
		ids := readSSEIDs(t, reader, 1)
		if len(ids) != 1 || ids[0] != "7" {
			t.Fatalf("%s read ids %v, want [7] — one change reaches every client or none of them", name, ids)
		}
	}
}
