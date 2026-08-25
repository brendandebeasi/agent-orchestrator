package httpd

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal"
)

// terminalMuxReadLimit caps a single inbound frame. Client→server frames are small
// (keystrokes, resize, control), so a generous 1 MiB is ample headroom while
// still bounding memory per message.
const terminalMuxReadLimit = 1 << 20

// mountTerminalMux registers the long-lived terminal-multiplexing WebSocket at /mux. It
// is intentionally outside the per-request Timeout middleware (the connection is
// long-lived). When mgr is nil the route is not mounted — the daemon simply has
// no terminal surface yet.
func mountTerminalMux(r chi.Router, mgr *terminal.Manager, allowedOrigins []string, log *slog.Logger) {
	if mgr == nil {
		return
	}
	r.Get("/mux", terminalMuxHandler(mgr, allowedOrigins, log))
}

// networkUpgradeOriginAllowed decides whether a WebSocket upgrade that arrived
// on the network listener may proceed, given its Origin header.
//
// It deliberately does not reuse corsMiddleware's policy. That policy trusts
// ANY loopback origin on the reasoning that loopback-served content can already
// reach the loopback-only daemon directly. Once the daemon answers on a network
// address that reasoning no longer holds: a dev server on some other machine's
// localhost presents a loopback origin too, and it is not local to this daemon
// at all. So the loopback heuristic stops at the loopback listener; here an
// origin must be the listener's own, or an entry the operator explicitly
// named — which by default means only app://renderer, a scheme no web content
// can bear.
//
// This is defense in depth, not the boundary: authMiddleware has already
// rejected the handshake unless it carried the connection password, which a
// cross-site page has no way to obtain.
func networkUpgradeOriginAllowed(r *http.Request, allowedOrigins []string) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // native clients (the mobile app, the CLI) send none
	}
	if isSelfOrigin(r, origin) {
		return true // the web client this daemon served
	}
	for _, allowed := range allowedOrigins {
		if strings.TrimSpace(allowed) == origin {
			return true
		}
	}
	return false
}

// terminalMuxHandler upgrades the request to a WebSocket and hands the connection to the
// terminal manager. httpd owns only the upgrade and the transport adaptation;
// all stream logic lives in internal/terminal.
func terminalMuxHandler(mgr *terminal.Manager, allowedOrigins []string, log *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// A WebSocket handshake is not subject to CORS preflight, so on the
		// network listener the origin is checked here as well. Loopback keeps
		// today's behavior exactly: the check is skipped, because the daemon
		// binds loopback only and the desktop renderer's origin differs from
		// the loopback host, mirroring the legacy Node mux server.
		if isNetworkListenerRequest(r) && !networkUpgradeOriginAllowed(r, allowedOrigins) {
			envelope.WriteAPIError(w, r, http.StatusForbidden, "forbidden", "ORIGIN_FORBIDDEN",
				"Origin is not allowed to open a terminal stream on this daemon", nil)
			return
		}
		// InsecureSkipVerify disables coder/websocket's own same-origin check;
		// the policy above replaces it so both listeners answer by one rule.
		opts := &websocket.AcceptOptions{InsecureSkipVerify: true}
		// Echo back exactly the credential subprotocol the client offered. A
		// browser fails the connection if it offers a subprotocol and the
		// server names none. Auth already ran in the middleware; this only
		// completes the negotiation.
		if protocol, _ := websocketAuthSubprotocol(r); protocol != "" {
			opts.Subprotocols = []string{protocol}
		}
		c, err := websocket.Accept(w, r, opts)
		if err != nil {
			log.Warn("terminal mux: websocket upgrade failed", "err", err)
			return
		}
		c.SetReadLimit(terminalMuxReadLimit)
		mgr.Serve(r.Context(), &terminalMuxConn{c: c})
	}
}

// terminalMuxConn adapts a coder/websocket connection to terminal.wsConn. JSON framing
// uses wsjson (text messages); Ping is a control frame; Close sends a normal
// closure.
type terminalMuxConn struct{ c *websocket.Conn }

func (a *terminalMuxConn) ReadJSON(ctx context.Context, v any) error { return wsjson.Read(ctx, a.c, v) }
func (a *terminalMuxConn) WriteJSON(ctx context.Context, v any) error {
	return wsjson.Write(ctx, a.c, v)
}
func (a *terminalMuxConn) Ping(ctx context.Context) error { return a.c.Ping(ctx) }
func (a *terminalMuxConn) Close(reason string) error {
	return a.c.Close(websocket.StatusNormalClosure, reason)
}
