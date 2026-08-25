package httpd

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal"
)

// The whole walk, in the order a browser walks it.
//
// Every piece of this is already covered on its own: remote_web_test.go proves
// the cookie's attributes, auth_test.go proves what the cookie does and does not
// authenticate, terminal_mux_test.go proves the subprotocol handshake, and
// two_clients_test.go proves the two listeners share one daemon. What none of
// them can prove is that the pieces compose, because each starts from a
// credential handed to it by the test rather than one earned from the step
// before.
//
// The failure this catches is the one that only appears in sequence: a token
// that authenticates the route that issued it and nothing after, an asset
// cookie scoped so tightly the client cannot load, a subprotocol that accepts
// the connection password but not the token the login exchange returned. Each
// of those is invisible to a test that supplies the password directly at every
// step, and each of them is a client that logs in successfully and then does
// nothing at all.

// listOnlySessionService is a SessionService that can list and nothing else.
//
// The embedded interface is nil, so any other method panics rather than
// returning a zero value. That is the point: this test asserts a browser client
// can read the session list over the network listener, and a fake that quietly
// answered thirty other calls would let a future edit route the walk through
// one of them without anyone noticing the coverage had moved.
type listOnlySessionService struct {
	controllers.SessionService
	sessions []domain.Session
}

func (s listOnlySessionService) List(context.Context, sessionsvc.ListFilter) ([]domain.Session, error) {
	return s.sessions, nil
}

// remoteE2ESession is the one session the client should find waiting.
func remoteE2ESession() domain.Session {
	now := time.Now().UTC()
	return domain.Session{
		SessionRecord: domain.SessionRecord{
			ID:        "ao-remote-1",
			ProjectID: "ao",
			Kind:      domain.KindWorker,
			Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
			CreatedAt: now,
			UpdatedAt: now,
		},
		Status:           domain.StatusIdle,
		TerminalHandleID: "ao-remote-1/terminal_0",
	}
}

// TestABrowserClientReachesTheDaemonWithNothingButAPassword walks the entire
// remote path end to end over the network listener: land on the login page with
// no credential, exchange the password for a token and the asset cookie, load
// the client bundle with that cookie, read the session list with that token,
// then open the session's terminal over /mux with that same token offered as a
// subprotocol and read what the pane printed.
//
// Each step uses only what the step before it returned. Nothing is handed the
// password twice.
func TestABrowserClientReachesTheDaemonWithNothingButAPassword(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY spawning not supported on Windows")
	}

	// The pane prints a marker and then holds the PTY open with cat, so the
	// output the client reads is output from a live pane rather than the tail of
	// one that already exited.
	const marker = "agent-output-marker"
	mgr := terminal.NewManager(
		&sharedPaneSource{argv: []string{"/bin/sh", "-c", "printf '" + marker + "\\n'; exec cat"}},
		nil, discardLogger())
	defer mgr.Close()

	session := remoteE2ESession()
	router := NewRouterWithControl(config.Config{}, discardLogger(), mgr, APIDeps{
		Sessions: listOnlySessionService{sessions: []domain.Session{session}},
	}, ControlDeps{})

	const password = "secret12"
	state := &authState{}
	state.setHash(mobilebridge.HashPassword(password))
	lan := NewLANManager(router, state, 0, discardLogger(), nil, remoteWebOptions{
		ServeWebClient: true,
		AppVersion:     "9.9.9",
		Assets:         remoteWebTestAssets(),
	})
	port, err := lan.Start(0)
	if err != nil {
		t.Fatalf("start network listener: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = lan.Stop(ctx)
	})
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	// A jar, because the browser's half of the credential is a cookie it stores
	// and re-sends without being asked. Driving it by hand would test the test.
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("new cookie jar: %v", err)
	}
	client := &http.Client{Jar: jar, Timeout: 10 * time.Second}

	// Step 1: the address, typed into a browser, with nothing to offer.
	loginBody := remoteE2EGet(t, client, base+"/", "")
	if !strings.Contains(loginBody, "<form") {
		t.Fatalf("GET / returned no login form: %s", remoteE2ETruncate(loginBody))
	}

	// Step 2: the password, exchanged once, for everything that follows.
	req, err := http.NewRequest(http.MethodPost, base+remoteWebSessionPath, nil)
	if err != nil {
		t.Fatalf("build session request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+password)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", remoteWebSessionPath, err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST %s = %d, body = %s", remoteWebSessionPath, resp.StatusCode, body)
	}
	var issued remoteWebSessionResponse
	if err := json.Unmarshal(body, &issued); err != nil {
		t.Fatalf("decode session response %s: %v", body, err)
	}
	if issued.Token == "" {
		t.Fatal("session exchange returned no token, so nothing after this step has a credential")
	}
	if issued.AppVersion != "9.9.9" {
		t.Fatalf("session exchange reported version %q, want 9.9.9 -- the client compares this against its own", issued.AppVersion)
	}

	// Step 3: the bundle, loaded by the browser on the cookie alone. The request
	// carries no Authorization header because a <script src> cannot set one --
	// which is the reason the cookie exists.
	entry := remoteE2EGet(t, client, base+remoteWebAssetPrefix+"index.html", "")
	if !strings.Contains(entry, "<title>client</title>") {
		t.Fatalf("the asset request did not return the bundle entry point: %s", remoteE2ETruncate(entry))
	}

	// Step 4: the session list, read by the client on the token alone.
	listed := remoteE2EGet(t, client, base+"/api/v1/sessions", issued.Token)
	if !strings.Contains(listed, string(session.ID)) {
		t.Fatalf("session list did not name %s: %s", session.ID, remoteE2ETruncate(listed))
	}

	// Step 5: the terminal, opened over /mux with the token offered the only way
	// a browser can offer one.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/mux", &websocket.DialOptions{
		Subprotocols: []string{muxAuthProtocol(issued.Token)},
	})
	if err != nil {
		t.Fatalf("dial /mux with the issued token: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "test done") }()

	handle := session.TerminalHandleID
	if err := wsjson.Write(ctx, conn, terminalMuxFrame{Ch: "terminal", ID: handle, Type: "open"}); err != nil {
		t.Fatalf("open terminal %s: %v", handle, err)
	}
	readFrame(t, conn, "terminal", "opened", 5*time.Second)

	// Step 6: what the agent printed, read back over the same socket.
	if got := remoteE2EReadUntil(t, conn, handle, marker, 10*time.Second); !strings.Contains(got, marker) {
		t.Fatalf("terminal output %q never contained %q", got, marker)
	}
}

// remoteE2EGet issues a GET carrying the token as a bearer credential (or no
// credential at all when the token is empty), fails on any non-200, and returns
// the body.
func remoteE2EGet(t *testing.T, client *http.Client, url, token string) string {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("build GET %s: %v", url, err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read GET %s: %v", url, err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s = %d, body = %s", url, resp.StatusCode, remoteE2ETruncate(string(body)))
	}
	return string(body)
}

// remoteE2EReadUntil accumulates the terminal's output frames until the wanted
// text appears or the deadline passes, returning everything read either way so a
// failure shows what the pane actually said.
func remoteE2EReadUntil(t *testing.T, c *websocket.Conn, id, want string, d time.Duration) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	var out strings.Builder
	for {
		var f terminalMuxFrame
		if err := wsjson.Read(ctx, c, &f); err != nil {
			t.Fatalf("reading terminal output: %v (read so far: %q)", err, out.String())
		}
		if f.Ch != "terminal" || f.ID != id || f.Type != "data" {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(f.Data)
		if err != nil {
			t.Fatalf("terminal data frame was not base64: %v", err)
		}
		out.Write(decoded)
		if strings.Contains(out.String(), want) {
			return out.String()
		}
	}
}

// remoteE2ETruncate keeps a failure message readable when the body is a bundle.
func remoteE2ETruncate(s string) string {
	const limit = 400
	if len(s) <= limit {
		return s
	}
	return s[:limit] + "... (truncated)"
}
