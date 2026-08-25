package httpd

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// LANManager owns the daemon's second, network-facing HTTP listener. It binds
// 0.0.0.0 only while Connect Mobile is enabled and wraps the shared router in
// authMiddleware. The loopback listener is unaffected.
type LANManager struct {
	handler     http.Handler // shared router, already auth-wrapped
	defaultPort int
	log         *slog.Logger
	state       *authState // shared with authMiddleware; SetPasswordHash writes through here

	mu    sync.Mutex
	srv   *http.Server
	ln    net.Listener
	bound int
}

// NewLANManager wraps handler in the LAN control-block and authMiddleware
// (backed by the shared state) and returns a manager that can start/stop the
// network-facing listener. Most callers want NewMobileLAN, which owns the state.
//
// The wrapping order, outermost first:
//
//	markNetworkListener  → record the physical socket for downstream checks
//	lanControlBlock      → 404 host-control routes before anything else runs
//	remoteWebEntry       → the login page and the password exchange (pre-auth)
//	authMiddleware       → every remaining route needs the connection password
//	remoteWebAssets      → the web client bundle, authenticated like any route
func NewLANManager(handler http.Handler, state *authState, defaultPort int, log *slog.Logger, sink ports.EventSink, web remoteWebOptions) *LANManager {
	lock := newLockout(5, time.Minute, time.Now)
	authed := authMiddleware(state, lock, newMobileConnectReporter(sink, time.Now))(remoteWebAssets(web)(handler))
	return &LANManager{
		handler:     markNetworkListener(lanControlBlock(remoteWebEntry(state, lock, web)(authed))),
		defaultPort: defaultPort,
		log:         loggerOrDefault(log),
		state:       state,
	}
}

// lanControlBlockedPrefixes are the loopback-only daemon-control route
// prefixes that must never be reachable through the LAN listener: /shutdown,
// the telemetry routes under /internal/, and the Connect Mobile control
// surface under /api/v1/mobile, developer maintenance routes under /api/v1/dev,
// and host-mutating installer routes under /api/v1/system/install. Some routes
// are gated in the shared router by localControlRequest,
// which trusts the client-supplied Host header (and RealIP, which trusts
// X-Forwarded-For/X-Real-IP) — both spoofable by any LAN client. The LAN
// listener is the one thing a caller cannot spoof: it is the physical socket the
// request arrived on. So the block below is applied only to the LAN-served
// handler, outermost (wrapping authMiddleware), independent of any header.
var lanControlBlockedPrefixes = []string{
	"/shutdown",
	"/internal/",
	"/api/v1/mobile",
	"/api/v1/dev",
	"/api/v1/browser",
	"/api/v1/desktop",
	"/api/v1/system/install",
}

// networkListenerContextKey marks a request as having arrived on the
// network-facing listener.
type networkListenerContextKey struct{}

// markNetworkListener records that a request was served by the network-facing
// listener rather than by loopback. Like lanControlBlock, it keys off the
// physical socket — the one thing a caller cannot spoof — so handlers
// downstream can apply stricter rules without trusting Host, X-Forwarded-For,
// or any other client-supplied header.
func markNetworkListener(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), networkListenerContextKey{}, true)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// isNetworkListenerRequest reports whether r arrived on the network-facing
// listener. False for every loopback request, including one whose headers claim
// otherwise.
func isNetworkListenerRequest(r *http.Request) bool {
	marked, _ := r.Context().Value(networkListenerContextKey{}).(bool)
	return marked
}

// lanControlAllowedRoutes are the individual routes that a full remote client
// needs but that fall under a blocked prefix. Each entry names one method and
// one exact route shape; "{}" matches exactly one path segment. The list is
// consulted before lanControlBlockedPrefixes, so a prefix stays blocked by
// default and every route carved out of it is named here deliberately. Removing
// a prefix from the block list instead would silently expose every route added
// under it later — the failure mode lanControlBlock exists to prevent.
//
// Keep this list minimal and read-only. A route that mutates the host, rather
// than the workspace, does not belong here no matter which client wants it.
var lanControlAllowedRoutes = []lanRoute{
	// The renderer's workspace summary: the only /api/v1/desktop route a full
	// client calls, and a read.
	{method: http.MethodGet, pattern: "/api/v1/desktop/sessions/{}/workspace"},
}

// lanRoute is one method-and-shape pair in lanControlAllowedRoutes.
type lanRoute struct {
	method  string
	pattern string
}

// lanControlBlock returns 404 for any request whose path is, or is nested
// under, a loopback-only control-route prefix, before it ever reaches auth or
// the shared router. It answers as if the route were never mounted at all —
// no 403/401 that would confirm the path exists.
func lanControlBlock(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isLANControlBlockedPath(r.Method, r.URL.Path) {
			notFoundJSON(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// isLANControlBlockedPath reports whether method and path are refused on the
// LAN listener. An exact match in lanControlAllowedRoutes wins first; otherwise
// path matches a blocked prefix on an exact segment boundary, so
// "/api/v1/mobile" blocks itself and everything beneath it
// ("/api/v1/mobile/status") but must not catch unrelated siblings such as
// "/api/v1/mobileapp".
func isLANControlBlockedPath(method, path string) bool {
	if isLANControlAllowedRoute(method, path) {
		return false
	}
	if strings.HasPrefix(path, "/api/v1/sessions/") && strings.HasSuffix(strings.TrimSuffix(path, "/"), "/preview/server") {
		return true
	}
	for _, prefix := range lanControlBlockedPrefixes {
		trimmed := prefix
		if len(trimmed) > 1 && trimmed[len(trimmed)-1] == '/' {
			trimmed = trimmed[:len(trimmed)-1]
		}
		if path == trimmed || strings.HasPrefix(path, trimmed+"/") {
			return true
		}
	}
	return false
}

// isLANControlAllowedRoute reports whether method and path match one of the
// carve-outs exactly. HEAD is treated as GET, matching how net/http serves a
// GET handler for a HEAD request.
func isLANControlAllowedRoute(method, path string) bool {
	if method == http.MethodHead {
		method = http.MethodGet
	}
	for _, route := range lanControlAllowedRoutes {
		if route.method == method && matchLANRoutePattern(route.pattern, path) {
			return true
		}
	}
	return false
}

// matchLANRoutePattern compares path against a pattern segment by segment,
// where the "{}" placeholder matches exactly one non-empty segment. It does not
// match a prefix: the segment counts must be equal, so "/a/{}/b" never admits
// "/a/x/b/c". A trailing slash is a different path and does not match, so the
// carve-out admits exactly one spelling of the route.
func matchLANRoutePattern(pattern, path string) bool {
	patternSegments := strings.Split(strings.Trim(pattern, "/"), "/")
	pathSegments := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(patternSegments) != len(pathSegments) {
		return false
	}
	for i, want := range patternSegments {
		got := pathSegments[i]
		if got == "" {
			return false
		}
		if want == "{}" {
			continue
		}
		if want != got {
			return false
		}
	}
	return true
}

// IsLANControlBlockedPathForTest exposes the LAN block check to package-external
// tests so route-level invariants can be asserted without a live listener.
func IsLANControlBlockedPathForTest(method, path string) bool {
	return isLANControlBlockedPath(method, path)
}

// NewMobileLAN constructs a LANManager with its own private authState. Callers
// outside this package (the daemon) cannot construct an authState directly
// since it is unexported; this gives them a LANManager that owns one, and the
// daemon rotates the connection password exclusively via SetPasswordHash.
func NewMobileLAN(handler http.Handler, defaultPort int, log *slog.Logger, sink ports.EventSink, cfg config.Config) *LANManager {
	web := remoteWebOptions{
		ServeWebClient: cfg.RemoteAccess.ServeWebClient,
		AppVersion:     cfg.Telemetry.AppVersion,
	}
	if assets, ok := webClientFS(); ok {
		web.Assets = assets
	}
	return NewLANManager(handler, &authState{}, defaultPort, log, sink, web)
}

// SetPasswordHash stores the current connection password hash on the shared
// authState so the auth middleware (already wrapping handler) validates
// against it. Satisfies controllers.LANController.
func (m *LANManager) SetPasswordHash(hash string) {
	m.state.setHash(hash)
}

// PasswordHash returns the current connection password hash. Used to snapshot the
// prior hash before an enable/regenerate so a failed persist can be rolled back.
// Satisfies controllers.LANController.
func (m *LANManager) PasswordHash() string {
	return m.state.currentHash()
}

// Start binds the network-facing listener on 0.0.0.0:port (falling back to an
// ephemeral port if that port is in use) and serves the wrapped handler. It is
// idempotent: a second call while running returns the already-bound port.
func (m *LANManager) Start(port int) (int, error) {
	m.mu.Lock()
	if m.srv != nil {
		defer m.mu.Unlock()
		return m.bound, nil // idempotent
	}
	if port == 0 {
		port = m.defaultPort
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		if !isAddrInUse(err) {
			m.mu.Unlock()
			return 0, fmt.Errorf("bind LAN 0.0.0.0:%d: %w", port, err)
		}
		//nolint:gosec // G102: binding all interfaces is the deliberate purpose of the Connect Mobile LAN listener; it runs only while the bridge is enabled and behind authMiddleware.
		if ln, err = net.Listen("tcp", "0.0.0.0:0"); err != nil {
			m.mu.Unlock()
			return 0, fmt.Errorf("bind LAN ephemeral: %w", err)
		}
		m.log.Warn("LAN port in use; bound ephemeral", "wanted", port, "bound", ln.Addr())
	}
	m.ln = ln
	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		m.mu.Unlock()
		_ = ln.Close()
		return 0, fmt.Errorf("bind LAN: unexpected listener address type %T", ln.Addr())
	}
	m.bound = tcpAddr.Port
	m.srv = &http.Server{Handler: m.handler, ReadHeaderTimeout: 10 * time.Second}
	srv := m.srv
	boundPort := m.bound
	m.mu.Unlock()
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			m.log.Error("LAN listener serve", "err", err)
		}
	}()
	m.log.Info("LAN listener started", "addr", ln.Addr())
	return boundPort, nil
}

// Stop gracefully shuts down the listener (honoring ctx) and clears the bound
// state. It is a no-op if the listener is not running.
func (m *LANManager) Stop(ctx context.Context) error {
	m.mu.Lock()
	srv := m.srv
	m.srv, m.ln, m.bound = nil, nil, 0
	m.mu.Unlock()
	if srv == nil {
		return nil
	}
	return srv.Shutdown(ctx)
}

// Running reports whether the LAN listener is currently serving.
func (m *LANManager) Running() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.srv != nil
}

// BoundPort returns the port the listener is bound to, or 0 when not running.
func (m *LANManager) BoundPort() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.bound
}
