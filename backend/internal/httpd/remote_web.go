package httpd

import (
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

// remoteWebAssetPrefix is the single path the browser build of the renderer is
// served under. Everything about the web client — its assets, its auth cookie,
// its client-side routes — lives beneath this prefix so the surface it adds is
// one subtree rather than a scattering of routes.
const remoteWebAssetPrefix = "/app/"

// remoteWebSessionPath exchanges the connection password for the credential the
// web client needs. It is the one route on the network listener that runs
// before authMiddleware, because it is the route that authenticates.
const remoteWebSessionPath = "/api/v1/remote/session"

// remoteWebCookieName carries the connection token for the browser's own
// requests for the web client's assets. Those requests are issued by the
// browser before any of our JavaScript exists, so they cannot carry a header.
//
// It is deliberately a second cookie rather than a reuse of authCookieName: the
// two are honored on disjoint paths (preview files vs. web-client assets) and
// scoped with different Path values, so keeping them separate means neither
// route family can ever be authenticated by the other's cookie.
const remoteWebCookieName = "ao_web"

// remoteWebCookieHonored reports whether the ao_web cookie may authenticate r.
// It is honored only for a read of a web-client asset: any other method, or any
// path outside the asset prefix, ignores the cookie entirely. That is what keeps
// a cookie the browser attaches to every same-origin request from being able to
// drive the API — a cookie is sent by the browser without the client choosing
// to, which is exactly the property that makes it unsuitable for anything that
// acts.
func remoteWebCookieHonored(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	return strings.HasPrefix(r.URL.Path, remoteWebAssetPrefix)
}

// remoteWebOptions carries what the network listener needs to host the web
// client. The zero value serves nothing, which is the default.
type remoteWebOptions struct {
	// ServeWebClient mirrors config.RemoteAccessConfig.ServeWebClient.
	ServeWebClient bool
	// AppVersion is the desktop version the daemon was launched by, reported to
	// a client so it can tell the operator about a mismatch. Empty when the
	// daemon was started without a supervising app.
	AppVersion string
	// Assets is the bundle to serve. NewMobileLAN fills it from whatever this
	// build embedded (see webClientFS); nil means the build carries none.
	Assets fs.FS
}

// enabled reports whether the web client should be served: the operator opted
// in AND this build has a bundle to serve.
func (o remoteWebOptions) enabled() bool { return o.ServeWebClient && o.Assets != nil }

// remoteWebEntry handles the two routes that must be reachable before
// authMiddleware: the login page a browser lands on with no credential, and the
// exchange that turns the password into one. Everything else falls through
// untouched.
//
// These sit outside authMiddleware rather than inside it because a 401 with a
// JSON envelope is not something a person typing an address into a browser can
// act on. The cost is that this handler authenticates itself, so it takes the
// same authState and lockout the middleware uses and applies them the same way.
func remoteWebEntry(state *authState, lock *lockout, opts remoteWebOptions) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if !opts.enabled() {
			return next
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.URL.Path == remoteWebSessionPath && r.Method == http.MethodPost:
				remoteWebSession(w, r, state, lock, opts)
			case r.URL.Path == "/" && (r.Method == http.MethodGet || r.Method == http.MethodHead):
				remoteWebLogin(w, r, state)
			default:
				next.ServeHTTP(w, r)
			}
		})
	}
}

// remoteWebLogin serves the credential prompt, or sends an already-authenticated
// request on to the client itself.
func remoteWebLogin(w http.ResponseWriter, r *http.Request, state *authState) {
	if mobilebridge.PasswordMatches(state.currentHash(), connectionToken(r)) {
		http.Redirect(w, r, remoteWebAssetPrefix, http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(remoteWebLoginPage))
}

// remoteWebSessionResponse is what a successful exchange returns. Token is the
// credential the client attaches to its own API and stream requests; the cookie
// set alongside it covers only the requests the browser makes on the client's
// behalf.
type remoteWebSessionResponse struct {
	AppVersion string `json:"appVersion"`
	Token      string `json:"token"`
}

// remoteWebSession validates the supplied password and, on success, issues the
// asset cookie and returns the token. It repeats authMiddleware's lockout
// bookkeeping rather than delegating to it, because it runs outside the
// middleware: without this, the one route that takes a password guess would be
// the one route that never counts one.
func remoteWebSession(w http.ResponseWriter, r *http.Request, state *authState, lock *lockout, opts remoteWebOptions) {
	src := sourceKey(r)
	if lock.blocked(src) {
		envelope.WriteAPIError(w, r, http.StatusTooManyRequests, "too_many_requests", "LOCKED_OUT",
			"too many failed attempts; try again shortly", nil)
		return
	}
	tok := bearerToken(r)
	if !mobilebridge.PasswordMatches(state.currentHash(), tok) {
		lock.fail(src)
		envelope.WriteAPIError(w, r, http.StatusUnauthorized, "unauthorized", "BAD_PASSWORD",
			"missing or invalid connection password", nil)
		return
	}
	lock.reset(src)
	//nolint:gosec // Secure is conditional, not omitted: the network listener is
	// plaintext http by design (ADR 0001) and a Secure cookie would never be sent
	// over it, so the flag is set exactly when the link is in fact encrypted. See
	// remoteRequestIsTLS.
	http.SetCookie(w, &http.Cookie{
		Name:     remoteWebCookieName,
		Value:    tok,
		Path:     remoteWebAssetPrefix,
		HttpOnly: true,
		// Strict, not Lax: no other site should ever be able to cause a request
		// that carries this cookie, not even a top-level navigation. The web
		// client only ever reaches its own assets from its own pages.
		SameSite: http.SameSiteStrictMode,
		Secure:   remoteRequestIsTLS(r),
	})
	envelope.WriteJSON(w, http.StatusOK, remoteWebSessionResponse{
		AppVersion: opts.AppVersion,
		Token:      tok,
	})
}

// remoteRequestIsTLS reports whether the client's connection to the daemon is
// encrypted, so the asset cookie can be marked Secure whenever that is true.
//
// X-Forwarded-Proto is honored even though a client can forge it, because the
// supported encrypted path (`tailscale serve`) terminates TLS in front of the
// daemon and the daemon sees plain HTTP. Forging the header can only ADD the
// Secure flag to the forger's own cookie, which makes the browser withhold it
// over plain HTTP: a self-inflicted failure to log in, not an escalation.
func remoteRequestIsTLS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}

// remoteWebAssets serves the embedded web client beneath remoteWebAssetPrefix.
// It runs INSIDE authMiddleware, so every asset request is authenticated like
// any other network request — by the header the client sets once it is running,
// or by the ao_web cookie for the requests the browser makes on its own.
func remoteWebAssets(opts remoteWebOptions) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if !opts.enabled() {
			return next
		}
		assets := opts.Assets
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.URL.Path, remoteWebAssetPrefix) {
				next.ServeHTTP(w, r)
				return
			}
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				envelope.WriteAPIError(w, r, http.StatusMethodNotAllowed, "method_not_allowed", "METHOD_NOT_ALLOWED",
					"the web client is read-only", nil)
				return
			}
			serveWebClientFile(w, r, assets, strings.TrimPrefix(r.URL.Path, remoteWebAssetPrefix))
		})
	}
}

// webClientEntry is the file returned for the client's own routes.
const webClientEntry = "index.html"

// serveWebClientFile serves name from assets, falling back to the entry point
// for any path the bundle does not contain. The fallback is what makes a
// reload of a client-side route work: the browser asks for a path only the
// client knows how to interpret, and the client is what must answer it.
//
// The fallback is limited to paths that do not name a file extension. A missing
// script or stylesheet must 404 rather than quietly return HTML, or a broken
// build shows up as a parse error in the console instead of a missing file.
func serveWebClientFile(w http.ResponseWriter, r *http.Request, assets fs.FS, name string) {
	name = strings.TrimPrefix(path.Clean("/"+name), "/")
	if name == "" || name == "." {
		name = webClientEntry
	}
	f, err := assets.Open(name)
	if err != nil {
		if path.Ext(name) != "" {
			envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "NOT_FOUND",
				"no such web client asset", nil)
			return
		}
		name = webClientEntry
		if f, err = assets.Open(name); err != nil {
			envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "NOT_FOUND",
				"no web client is bundled in this build", nil)
			return
		}
	}
	defer func() { _ = f.Close() }()
	stat, err := f.Stat()
	if err != nil || stat.IsDir() {
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "NOT_FOUND",
			"no such web client asset", nil)
		return
	}
	seeker, ok := f.(io.ReadSeeker)
	if !ok {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "ASSET_UNREADABLE",
			"web client asset is not seekable", nil)
		return
	}
	if name == webClientEntry {
		// The entry point names the hashed asset filenames for this build, so a
		// cached copy from a previous build would load assets that are gone.
		w.Header().Set("Cache-Control", "no-store")
	}
	http.ServeContent(w, r, name, stat.ModTime(), seeker)
}
