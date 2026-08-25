package httpd

import (
	"encoding/base64"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

// authState holds the current password hash for the LAN listener. Swapped
// atomically on regenerate so an in-flight request never sees a torn value.
type authState struct{ hash atomic.Pointer[string] }

func (a *authState) setHash(h string) { a.hash.Store(&h) }
func (a *authState) currentHash() string {
	if p := a.hash.Load(); p != nil {
		return *p
	}
	return ""
}

// lockout throttles password guessing per source address.
type lockout struct {
	mu       sync.Mutex
	limit    int
	cooldown time.Duration
	now      func() time.Time
	fails    map[string]int
	until    map[string]time.Time
}

func newLockout(limit int, cooldown time.Duration, now func() time.Time) *lockout {
	return &lockout{limit: limit, cooldown: cooldown, now: now, fails: map[string]int{}, until: map[string]time.Time{}}
}

func (l *lockout) blocked(src string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	t, ok := l.until[src]
	if !ok {
		return false
	}
	if l.now().Before(t) {
		return true
	}
	// Cooldown elapsed: clear the lockout AND the fail counter so the source
	// starts a fresh window. Without this the counter stays at the limit and the
	// very next failure would immediately re-lock for another full cooldown —
	// and a client that keeps polling would stay locked out forever. This also
	// bounds map growth, since expired entries are pruned on the next request.
	delete(l.until, src)
	delete(l.fails, src)
	return false
}

func (l *lockout) fail(src string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.fails[src]++
	if l.fails[src] >= l.limit {
		l.until[src] = l.now().Add(l.cooldown)
	}
}

func (l *lockout) reset(src string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.fails, src)
	delete(l.until, src)
}

func sourceKey(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	return ""
}

// authCookieName carries the connection token for a preview page's in-page
// subresource requests. See connectionToken / maybeSetPreviewAuthCookie.
const authCookieName = "ao_conn"

// previewFilesMarker is the path segment that identifies a preview-file request
// (GET /api/v1/sessions/{id}/preview/files/*). The auth cookie is both scoped to
// and honored only on this path, so it can never authenticate any other endpoint.
const previewFilesMarker = "/preview/files/"

// previewFilesCookiePath returns the cookie Path to scope the auth cookie to the
// requesting session's preview files (".../preview/files/"), or "" if the request
// is not a preview-file request. Scoping this tightly is what keeps the cookie
// from ever reaching /kill, /send, another session, or any non-preview route.
func previewFilesCookiePath(urlPath string) string {
	i := strings.Index(urlPath, previewFilesMarker)
	if i < 0 {
		return ""
	}
	return urlPath[:i+len(previewFilesMarker)]
}

// muxAuthSubprotocolPrefix marks a WebSocket subprotocol that carries the
// connection token: "ao.auth.<base64url-nopad(password)>". A browser cannot put
// a header on a WebSocket handshake, and the token must not go in the URL (URLs
// land in access logs, proxy logs, and history), so the subprotocol — the one
// client-controlled field in the handshake — carries it instead.
//
// The base64url wrapping is not obfuscation. RFC 6455 restricts subprotocol
// names to HTTP token characters, and the connection password is not guaranteed
// to stay within them; encoding makes the transport independent of the
// password's charset.
const muxAuthSubprotocolPrefix = "ao.auth."

// isWebSocketUpgrade reports whether r is a WebSocket handshake, so the
// subprotocol credential is only ever read on a request that could actually
// negotiate one.
func isWebSocketUpgrade(r *http.Request) bool {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return false
	}
	for _, token := range strings.Split(r.Header.Get("Connection"), ",") {
		if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
			return true
		}
	}
	return false
}

// websocketAuthSubprotocol returns the offered subprotocol that carries a
// connection token and the decoded token itself, or two empty strings when the
// request offers none. The protocol string is returned verbatim because a
// successful upgrade must echo back exactly what the client offered.
func websocketAuthSubprotocol(r *http.Request) (protocol, token string) {
	if !isWebSocketUpgrade(r) {
		return "", ""
	}
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, offered := range strings.Split(header, ",") {
			offered = strings.TrimSpace(offered)
			if !strings.HasPrefix(offered, muxAuthSubprotocolPrefix) {
				continue
			}
			decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(offered, muxAuthSubprotocolPrefix))
			if err != nil || len(decoded) == 0 {
				continue
			}
			return offered, string(decoded)
		}
	}
	return "", ""
}

// connectionToken returns the caller's connection token. It comes from the
// Authorization: Bearer header (the mobile API client and a preview page's
// top-level navigation); from a negotiated WebSocket subprotocol on a handshake
// (a browser, which can set no headers there); or from one of two narrowly
// scoped cookies, each honored on exactly one route family that a browser
// fetches without any JavaScript of ours in the loop:
//
//   - ao_conn on the preview-files route — a preview page's subresource
//     requests (images/CSS/JS), which the WebView issues without our header.
//   - ao_web on GET/HEAD of the web-client assets — the browser's own requests
//     for the client's script and style, issued before the client exists to
//     attach a header.
//
// Restricting each cookie to its path means neither can authenticate any other
// endpoint even if a client sends it everywhere. The token is never read from
// the query string.
func connectionToken(r *http.Request) string {
	if t := bearerToken(r); t != "" {
		return t
	}
	if _, t := websocketAuthSubprotocol(r); t != "" {
		return t
	}
	if previewFilesCookiePath(r.URL.Path) != "" {
		if c, err := r.Cookie(authCookieName); err == nil {
			return c.Value
		}
	}
	if remoteWebCookieHonored(r) {
		if c, err := r.Cookie(remoteWebCookieName); err == nil {
			return c.Value
		}
	}
	return ""
}

// maybeSetPreviewAuthCookie drops the auth cookie when a preview FILE is fetched
// with a valid token, so the WebView's follow-up subresource requests on the same
// password-protected preview route authenticate too (they never carry our
// Authorization header). The cookie is Path-scoped to this session's preview
// files only, HttpOnly, and re-sent only when it doesn't already match the token
// that just authenticated — so a normal subresource costs no Set-Cookie, but a
// cookie left over from a regenerated password is overwritten instead of being
// kept until it 401s every image/CSS/JS on the page. This runs on the LAN
// listener only; the loopback/desktop preview path never reaches authMiddleware,
// so desktop preview behavior is unchanged.
func maybeSetPreviewAuthCookie(w http.ResponseWriter, r *http.Request, tok string) {
	path := previewFilesCookiePath(r.URL.Path)
	if path == "" {
		return
	}
	if c, err := r.Cookie(authCookieName); err == nil && c.Value == tok {
		return // already current; don't re-send Set-Cookie on every subresource
	}
	//nolint:gosec // Secure is intentionally omitted: the LAN bridge is plaintext
	// http by design (ADR 0001, home-network-only), and a Secure cookie would never
	// be sent over it. The token already travels the same plain link via Bearer.
	http.SetCookie(w, &http.Cookie{
		Name:     authCookieName,
		Value:    tok,
		Path:     path,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		// No Secure: the LAN link is plain http (a TLS tunnel still sends it),
		// matching how the Bearer token already travels.
	})
}

// authMiddleware authenticates LAN requests against the current connection
// password. connected, which may be nil, is notified of the source address of
// every request that authenticates; it exists so telemetry can observe that a
// phone actually reached this desktop, and it must not block the request, since
// it runs inline on every authenticated call.
func authMiddleware(state *authState, lock *lockout, connected *mobileConnectReporter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			src := sourceKey(r)
			if lock.blocked(src) {
				envelope.WriteAPIError(w, r, http.StatusTooManyRequests, "too_many_requests", "LOCKED_OUT",
					"too many failed attempts; try again shortly", nil)
				return
			}
			if tok := connectionToken(r); mobilebridge.PasswordMatches(state.currentHash(), tok) {
				lock.reset(src)
				connected.report(src)
				maybeSetPreviewAuthCookie(w, r, tok)
				next.ServeHTTP(w, r)
				return
			}
			lock.fail(src)
			envelope.WriteAPIError(w, r, http.StatusUnauthorized, "unauthorized", "BAD_PASSWORD",
				"missing or invalid connection password", nil)
		})
	}
}
