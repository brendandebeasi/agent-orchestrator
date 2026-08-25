## Context

See `proposal.md` — Why. The constraints that shape the approach, all verified in the
current tree:

- `backend/internal/config/config.go` pins the primary listener to `LoopbackHost =
  "127.0.0.1"` and deliberately exposes no `AO_HOST` override. That stays.
- A second listener already exists for Connect Mobile
  (`backend/internal/httpd/lan_listener.go`): binds `0.0.0.0` only while enabled, wraps
  the shared router in `authMiddleware` (bearer password, hashed, constant-time compare,
  per-source lockout of 5 failures / 1 minute), and is fronted by `lanControlBlock`, an
  outermost 404 filter keyed on the physical socket rather than on spoofable headers.
  `docs/adr/0001-lan-listener-for-mobile.md` records the reasoning.
- `lanControlBlockedPrefixes` currently includes `/api/v1/desktop`, which is the one
  prefix a full renderer needs (`GET /api/v1/desktop/sessions/{sessionId}/workspace` is
  the only route under it that the renderer calls).
- `backend/internal/httpd/auth.go` already has the pattern for a path-scoped auth cookie:
  `previewFilesCookiePath` limits `ao_conn` to `.../preview/files/` so it "can never
  authenticate any other endpoint even if a client sends it." That invariant is the model
  for static-asset auth here.
- `backend/internal/httpd/terminal_mux.go` upgrades `/mux` with
  `CheckOrigin`-equivalent disabled (`InsecureSkipVerify: true`), and the token is read
  from `Authorization: Bearer`. `packages/mobile/lib/mux.ts` can set that header because
  React Native's WebSocket accepts one; `frontend/src/renderer/lib/terminal-mux.ts` calls
  `new WebSocketImpl(url)` and a browser cannot add headers at all.
- `backend/internal/mobilebridge/tailscaleserve.go` already provisions a tailnet-only
  HTTPS front (`tailscale serve --bg --https=443`, never `funnel`), so a TLS story exists
  without inventing one.
- The daemon serves no static files today; there is no file server in `httpd`.
- `frontend/src/renderer/lib/api-client.ts` resolves its base URL from
  `VITE_AO_API_BASE_URL` at build time, but already exports `setApiBaseUrl` /
  `subscribeApiBaseUrl`, so a runtime swap is a small step.
- `frontend/src/renderer/lib/bridge.ts` already exports `aoBridge = window.ao ?? {stub}`,
  a single seam every renderer host call goes through.
- `VITE_NO_ELECTRON=1` currently hard-codes fixture data in `useShellTerminals`,
  `useWorkspaceQuery` (via `lib/preview-mode.ts`), `useSessionScmSummary`, and
  `useMigrationOffer`, so `npm run dev:web` is a fixture harness, not a client.

## Goals / Non-Goals

**Goals:**

- One network listener, one credential, one auth middleware — extended, not duplicated.
- Fail-closed route policy: newly reachable routes are named individually, never opened by
  removing a block.
- A browser can authenticate every transport it needs (HTTP, WebSocket, the change-event
  stream, static assets) without a token in a URL.
- The renderer picks its server at runtime; the same bundle serves Electron-local,
  Electron-remote, and browser.
- Host-bound features fail visibly (absent or disabled with a reason), never silently on
  the wrong machine.

**Non-Goals (design-level, beyond the proposal's scope statement):**

- No authorization model beyond a single shared password. No per-client scopes, no
  accounts, no revocable per-device tokens. Connect Mobile's device list stays the only
  enrollment surface, and it stays loopback-only.
- No change to `terminal_mux`'s framing, no new streaming protocol.
- No server-side rendering, no separate web app codebase. The web client is the existing
  renderer bundle built for a browser target.
- No offline mode or local cache of remote state.

## Decisions

### D1. Extend the existing network listener; do not add a third

Adding a dedicated "desktop remote" listener would mean a second bind, a second password,
a second lockout table, and a second place to get the block list wrong. The existing
listener is already the audited chokepoint. The full client is just another authenticated
client on it.

*Alternative considered:* a separate listener with its own credential, so a phone
credential could not reach desktop routes. Rejected — the newly reachable surface is one
read-only endpoint plus static assets; a second credential axis costs more than it buys.
If per-client scopes are ever needed, they belong on the credential, not on the socket.

### D2. Narrow allow-list in front of the block list, not a shortened block list

`/api/v1/desktop` stays in `lanControlBlockedPrefixes`. `isLANControlBlockedPath` gains an
allow-list check that runs first and matches exact route shapes, seeded with
`GET /api/v1/desktop/sessions/{sessionId}/workspace`.

This keeps the default for anything added under `/api/v1/desktop` later as *blocked*.
Deleting the prefix from the block list would silently expose every future route under it
— exactly the failure mode `lanControlBlock` exists to prevent.

*Alternative considered:* move the workspace route out from under `/api/v1/desktop` to a
neutral prefix. Rejected — it is a breaking change to a generated API surface
(`apispec/specgen/build.go`, the mobile client, and the OpenAPI artifact) for a cosmetic
gain.

### D3. WebSocket auth by negotiated subprotocol

`/mux` accepts `Sec-WebSocket-Protocol: ao.auth.<base64url-nopad(password)>` in addition
to `Authorization: Bearer`. On success the server echoes exactly that subprotocol back;
on failure it refuses the upgrade with 401 and never upgrades.

The base64url wrapping is not obfuscation — RFC 6455 subprotocol names are restricted to
HTTP token characters, and the generated password is not guaranteed to stay within them.
Encoding makes the transport independent of the password's charset.

*Alternatives considered:*
- Token in the query string. Rejected — URLs land in access logs, proxy logs, and browser
  history. The spec forbids it explicitly.
- Cookie on the WebSocket handshake. Rejected — it would require the auth cookie to be
  valid on an API path, breaking the invariant in D5, and it reintroduces CSRF surface
  because a WebSocket handshake is not subject to CORS preflight.
- A short-lived ticket minted by an authenticated POST and spent in the URL. Rejected as
  a second credential lifecycle for no gain over the subprotocol.

### D4. Origin check on the network listener's upgrade

`InsecureSkipVerify: true` on the upgrader is tolerable for a loopback-only socket. Once
the same socket serves a browser page, it is not. On the network listener the upgrade
requires no `Origin` header (native clients), an `Origin` equal to the listener's own
origin (the web client the daemon served), or an `Origin` the operator explicitly
allowlisted — which by default is only `app://renderer`, the scheme no web content can
bear, and which is what a *remote* Electron client presents. Loopback keeps today's
behavior so nothing about the desktop-local path changes.

The check deliberately does not reuse `corsMiddleware`'s policy. That policy trusts any
loopback origin, reasoning that loopback-served content can already reach the
loopback-only daemon directly. On a network address that reasoning fails: a dev server on
some other machine's localhost presents a loopback origin too. So the loopback heuristic
stops at the loopback listener.

This is defense in depth, not the boundary — `authMiddleware` has already refused the
handshake unless it carried the password, which a cross-site page has no way to obtain.

### D5. Static assets authenticate by a path-scoped cookie; the API never does

A browser cannot put a header on `<script src>`. The daemon therefore serves:

- `GET /` and `GET /<unknown-path>` while unauthenticated → a self-contained login page
  with no subresources (inline style and script only), so nothing it references can 401.
- `POST /api/v1/remote/session` with the password → validates through the same
  `authState`, sets `ao_web` (HttpOnly, `SameSite=Strict`, `Path=/app/`, `Secure` when the
  request arrived over TLS), and returns the daemon version plus the token for the SPA to
  hold in memory.
- `GET /app/*` → the built renderer, authenticated by `ao_web` **only**.

`connectionToken` is extended the same way `previewFilesCookiePath` extended it: the
`ao_web` cookie is honored only for `GET`/`HEAD` under the static asset path, so it can
never authenticate `/api`, `/mux`, or anything else. The SPA itself uses the bearer header
for API calls and the subprotocol for `/mux`, both of which a cross-site page cannot
forge. Net CSRF surface: none.

*Alternative considered:* serve assets unauthenticated (they contain no user data).
Rejected — an unauthenticated bundle fingerprints the service and its exact version to
anything that can reach the port, and the spec commits to authenticating assets.

### D5a. The change-event stream is read by `fetch`, not by `EventSource`

Found while implementing D5, which is why it is numbered as an amendment to it rather than
folded in silently: the renderer learns about every session, project, and workspace change
from `GET /api/v1/events`, an SSE stream opened with `EventSource`. A remote client without
it is not degraded, it is dead — nothing on screen would ever update.

`EventSource` is the one transport with no way to present a credential. It sets no headers,
negotiates no subprotocol, and the spec forbids the query string. That leaves two answers:

1. Honor `ao_web` on `GET /api/v1/events` as well as the asset path.
2. Stop using `EventSource` and read the stream with `fetch`, which takes headers like any
   other request.

**Chosen: (2).** (1) would put a cookie on an API route, and the whole reason D5's cookie is
defensible is that it is confined to reads of static files. `SameSite=Strict` would in fact
stop a cross-site read today, but the invariant "no cookie ever authenticates `/api`" is
worth more than the code it saves: it is checkable by reading one function, where the
cookie-on-API version is only safe as long as every future route under it stays a read.

The cost is real and paid once: `EventSource`'s automatic reconnect and its `Last-Event-ID`
resume have to be written by hand. Resume is the smaller half of that — the daemon already
accepts `?after=<seq>` as an equivalent to the header, and the reader tracks the last `id:`
it saw. Reconnect becomes an explicit backoff loop, which the transport already half-owns:
it runs its own retry timer today for the terminal `CLOSED` state that `EventSource` does
not retry out of.

*Alternative considered:* keep `EventSource` on loopback and use the `fetch` reader only
for a remote target. Rejected — two implementations of the same stream, and the one that
runs in development would not be the one that runs remotely.

### D6. The web bundle is embedded behind a build tag

`embed.FS` under a `webui` build tag, with a stub for the default build. Default binaries
are byte-identical to today and the release pipeline opts in explicitly. Serving is
additionally gated on a persisted `remoteAccess.serveWebClient` flag (default false), so
enabling Connect Mobile on an existing install does not change what `GET /` returns.

*Alternative considered:* serve from a directory on disk. Rejected — a path the operator
controls, served over the network, on the same origin that holds a valid cookie, is an
arbitrary-file-read primitive one misconfiguration away.

### D7. Renderer server target is runtime state

A `ServerTarget` store holds `{ baseUrl, label, requiresAuth }` and a credential. It
drives `setApiBaseUrl` (already reactive) and is read by an `openapi-fetch` middleware
that attaches `Authorization` per request, plus by `terminal-mux.ts` for the subprotocol.
Changing the target closes open mux sockets, clears the query cache, and re-runs the
handshake.

Persistence differs by host and is reached through the bridge, not directly: Electron
stores the credential via `safeStorage`; the browser does not persist it at all — the
`ao_web` cookie already survives reload, and putting the password in `localStorage` would
undo `HttpOnly`.

Two things the implementation settled that are worth writing down. First, the Electron
side keeps addresses and passwords in separate files — `remote-servers.json` in plaintext,
`remote-credentials.bin` through `safeStorage` — and the entry's identity is its
normalized base URL rather than a minted id. Sharing a key means the two stores cannot
disagree about which server an entry is, which is the failure that would leave a password
behind after the operator removed the server it belonged to. On a platform where
`safeStorage` has no real backing (Linux without a keyring, where it reports `basic_text`),
credentials are held in memory for the session and never written, matching what
`cloud-auth.ts` already does.

Second, `remoteServers` is deliberately not one of the capabilities from D9. A browser has
a true answer to give — it remembers nothing — and returning an empty list is more useful
to every caller than an exception each would have to catch. Capabilities are for asks a
host genuinely cannot serve; this is an ask it serves with "nothing".

The renderer also distinguishes a credential that was refused from one that was never
supplied. Both send the operator to the connection screen, but "that password was not
accepted" and "this server needs a password" are different sentences, and telling an
operator their password was wrong when they never gave one is the kind of small lie that
costs real debugging time.

### D8. `VITE_NO_ELECTRON` stops implying fixtures

The four hooks that branch on `VITE_NO_ELECTRON` switch to a single `isPreviewMode()`
predicate driven by `VITE_AO_PREVIEW`. `npm run dev:web` keeps `VITE_NO_ELECTRON=1` (no
Electron bridge) but no longer sets preview, so it talks to a real daemon through the
existing vite proxy. A new `dev:web:preview` script restores the fixture harness for the
e2e suites that depend on it.

Absence of the Electron bridge and "render fixtures" are two different facts that happen
to have coincided; conflating them is what makes the current web build unusable as a
client.

### D9. Capabilities are declared by the bridge, gated by one hook

`aoBridge` gains `capabilities: { editorHandoff, revealInFileManager, directoryPicker,
browserPanel }`, typed in `frontend/src/shared/host-capabilities.ts` so the preload and the
stub cannot drift apart. The Electron preload reports all true; the browser fallback stub
reports all false. One `useHostCapability(name)` hook is the only permitted read, so gating
cannot drift per call site, and every existing call site that reaches through `aoBridge`
for one of these is converted.

**The declaration is necessary but not sufficient.** A capability is available only when
the host declares it *and* the server target is local. The preload's answer is fixed for
the life of the window, and remote mode is a startup setting (D10), but the operator can
connect somewhere else long after startup through the connection screen. Every one of
these features reaches for something on a disk and takes for granted that the disk is this
one; point a desktop client at a daemon on another machine and that stops being true while
every declared capability stays declared. So the hook folds `ServerTarget.kind` in, and the
UI withdraws these features on connect without a reload.

`ServerTarget.kind` is deliberately separate from `requiresAuth`. One says how the server
checks who is asking, the other says where its filesystem is. Today `requiresAuth` predicts
`kind` — the loopback daemon asks for nothing and remote ones do — but it does not mean it,
and a daemon on the network that authenticates nothing is still on another disk.

A withdrawn capability is not an error. It does not go through `TopbarActionError` or any
other failure channel; the reason rides on the disabled control's tooltip, or the control
is simply absent. Nothing failed — the operator asked a computer to open a file that is on
a different computer, and the honest response is to not offer it.

The stub behind a false capability throws rather than resolving to a plausible nothing.
Returning `null` or an empty scan is what let these methods be called from a browser for as
long as they were: the caller got something shaped right back, drew a blank, and no one
found out the feature had quietly stopped existing. Two members stay non-throwing, both
because of *when* the renderer reaches them — a value read to choose a render path
(`browser.nativeCompositionEnabled`) has to yield a value, and the `browser.on*`
subscriptions are registered unconditionally in mount effects, where throwing would take
out the panel to prevent nothing.

**What the remote path gives up.** Withdrawing `directoryPicker` also withdraws the local
folder scan and the ancestor-repo check, because both read this machine's disk. The import
flow loses its pre-import preview of what it found, and the daemon becomes the only thing
that validates the path. That is the right trade: a scan of the wrong computer is worse
than no scan, since it would confirm a repository that the daemon will never see. It does
mean the daemon's own errors are now the whole story on that path, which is why
`project.Manager.Add` had to stop answering `NOT_A_GIT_REPO` for a folder that simply is
not there.

### D10. Electron remote mode is a lifecycle branch, not a fork of `main.ts`

A single `remoteServer` setting (env override `AO_REMOTE_SERVER` for development) makes
`main.ts` skip, in order: daemon discovery, spawn, attach, `bundledDaemonIdentityError`,
`shouldLinkOnAttach` supervisor linking, the browser-runtime token handoff, and
shutdown-on-quit. Everything else — windows, menus, tray, updates — is unchanged. When the
setting is empty, not one code path differs from today.

The browser-runtime link is skipped rather than adapted: it reads
`browserRuntimeAddress` from the local `~/.ao/running.json`, which describes a daemon on
this machine and is meaningless for a remote one. That is why `browserPanel` is a
capability rather than a feature that degrades.

Two consequences fell out of building it, both worth recording.

**The setting is read once per launch and cannot change while the app runs.** Half a dozen
paths branch on it, and a process that had already spawned a daemon and then decided it was
remote would have to unwind all of them. Connecting to a server writes the setting for the
*next* launch; going back to a local daemon writes it and asks Electron to relaunch. That
is why the preload learns the address through `additionalArguments` rather than IPC — the
value is fixed before the window exists, and the renderer needs it before its first query,
which is earlier than any round trip can answer.

**The renderer needed a different answer to "is the server up".** It gates nearly everything
on the supervisor's `DaemonStatus`, and in remote mode the supervisor honestly reports
`stopped` forever, for a daemon nobody asked it to start. Passing that through would leave a
connected client on the startup loader under a banner about the wrong computer.
`remoteServerStatus` answers for the server actually in use instead: a remote target is
committed only after an authenticated probe succeeded, so having one *is* the readiness
signal, and the port is read off the address rather than invented. A link that drops later is
reported by the indicator beside the server's name — a remote link blinks, and a client that
discarded its board on every blink would be unusable. The same reasoning is why
`applyDaemonStatus` drops local status events outright once the client is aimed elsewhere:
recording them would explain a remote server's failures with a local daemon, and applying
them would un-aim the client on every event.

### D11. Version compatibility is checked at handshake, reported, not enforced

`POST /api/v1/remote/session` returns the daemon's app version (already carried as
`cfg.Telemetry.AppVersion`), and `/healthz` gains the same field so the existing probe
path can use it. A mismatch outside the supported range is surfaced to the operator with
both versions; the client does not attempt to replace a remote binary, and does not hard
block, because a local-daemon install already guarantees a matched pair and a remote one
is the operator's to manage.

The renderer reads the version from `/healthz` rather than from the session route, and the
same call is what it uses to probe a server before committing to it. The session route only
exists in a daemon built with the web client, so a desktop client pointed at a plain daemon
would find nothing there; `/healthz` is always mounted and, with the password attached,
already answers the two questions that matter — is anything listening, and does it accept
this credential. Comparison is exact string equality rather than a semver range, because
client and server ship as a pair and any difference is worth naming; when either side has
no version to report — a daemon started from the CLI has no supervising app to take one
from — the result is "unknown" and nothing is shown, since a missing version is not
evidence of a mismatch.

### D12. The content security policy stops being a build-time constant

The renderer's policy was one string in `vite.renderer.config.ts`, injected as a `<meta>`
tag at build time, pinning network access to `http://127.0.0.1:*` and `ws://127.0.0.1:*`.
That was exactly right while every daemon was on loopback, and it is the single thing that
would have made all of the above ship and then not work: a desktop client attached to
`http://studio.local:3011` sends its first request and the page blocks it, with a console
error and no failure the connection screen could report, because the request never left.
This was not on the task list. It surfaced from asking what in the bundle still assumes
the daemon is on this machine after `server-target.ts` no longer does.

The policy now has three shapes, one per host, built by `src/shared/content-security-policy.ts`:

- **Browser client.** Served by the daemon it talks to, so its own origin is the whole
  answer and `connect-src 'self'` covers REST, SSE, and the mux. A build-time `<meta>` tag
  is right here, and `AO_BUILD_TARGET=web` is what injects it.
- **Desktop, local daemon.** The loopback range, as before — the port is chosen at runtime,
  so the range is the tightest thing a policy can name.
- **Desktop, remote daemon.** The server's origin plus its WebSocket origin. CSP counts
  `http://host` and `ws://host` as different sources, so both are named; loopback stays
  permitted alongside, because the client is still an Electron app on this machine with a
  browser panel and an ACP runtime there.

The desktop policy cannot be a `<meta>` tag, and this is the load-bearing part: the address
comes from a setting written after the bundle was built, and a page carrying both a tag and
a header gets the intersection of the two, so a tag naming only loopback would silently win
over the header naming the server. The desktop build therefore emits no tag at all and
`registerRendererProtocol` sets the header on the entry-point response — the only response
where a policy means anything — recomputed per launch from the same `remoteMode` the
lifecycle guards read.

The one cost is that the telemetry host now has to be resolved identically in three places:
the renderer, which sends; the renderer build, which writes the browser tag; and the main
process, which writes the desktop header. They share `resolvePosthogHost`, and
`vite.main.config.ts` inlines `VITE_AO_POSTHOG_HOST` into the main bundle from the same
variable the renderer build reads, so the two halves of a packaged build cannot disagree
about it.

### D13. The login page hands the browser client its credential through session storage

The login page and the client are two documents. The page authenticates, the daemon
returns a token and sets `ao_web`, and then the page navigates to `/app/` and stops
existing. The cookie survives that — it is what fetches the bundle — but it is scoped to
`Path=/app/` precisely so it cannot be presented at `/api/v1`, which means the client
cannot use it for anything and needs the token handed to it some other way.

Session storage is the handoff. It is per-tab rather than per-browser, which is the
property that matters: a second tab opened on the same daemon loads the app from the
cookie and then finds no token, and going back to the login page is the correct response
rather than an inherited session nobody authenticated for. It also clears when the tab
closes, so the token's lifetime is the visit's.

Three things follow from the page and the client being separate documents in separate
languages:

- **The keys are asserted equal across the two trees.**
  `remote_web_session_keys_test.go` reads the real text of `remote-session.ts` and of the
  login page and fails if the two key names, or the login path the client returns to, ever
  disagree. Nothing else would catch it: rename one side and the page still serves, the
  client still builds, and the symptom is a browser that logs in and bounces back to the
  prompt forever.
- **The client has to know which bundle it is.** A tab served by the daemon and a tab
  served by vite's dev proxy are indistinguishable at runtime — same origin shape, same
  absent preload — and the difference is entirely in what sits in front of the daemon. So
  the build says: `VITE_AO_WEB_CLIENT=1` is set only by `build:web`.
- **The redirect needs a seam.** `window.location` cannot be replaced or spied on in
  jsdom, so the one-line `lib/navigate.ts` exists to be mocked. It has no other reason to
  exist and says so.

The daemon-served client is aimed as a *remote* target even though its server is its own
origin, because "remote" here means "a daemon this client did not start" — which is what
decides that host-bound features stay withdrawn and that readiness comes from the server
rather than from a local supervisor there isn't one of.

### D14. Changing servers relaunches, and the way in is a settings row

Two gaps closed together, because the second one is what exposed the first.

The way in: nothing pointed a client at a server. The connection screen mounts when the
server target reports a credential prompt, and only a client already aimed somewhere can
report one, so a fresh install could reach remote mode through `AO_REMOTE_SERVER` and no
other way. That is a fine escape hatch and a poor front door. `ServerSettingsSection` puts
the current server's name in General settings with a button that opens the same screen,
which now takes an `onCancel` — the original screen had nothing behind it and correctly
offered no way out, and opened on purpose it does.

The bug: `remoteMode:set` relaunched only when a remote client asked for a local daemon,
on the reasoning that the daemon lifecycle is resolved once per launch and cannot be
changed underneath a running process. True, and half the story. The page is also loaded
once, under a policy that names one server (D12), so a client that started local and was
re-aimed at a server would block its first request to it before the request left the
page — no network error, no failure the connection screen could report, nothing but a
console nobody has open. Any change of server now relaunches:

```
relaunching = server !== (remoteMode?.baseUrl ?? null)
              && !overriddenByEnv
```

The environment override still suppresses it, because a relaunch that comes back to the
same place is a flicker with no result. The screen names which control it is restarting
for, since both buttons can now provoke one and only the pressed one should say so.

This makes a relaunch a routine part of using the feature rather than an edge case, which
is worth the cost it carries: sessions on the old server keep running (that is D3's
detachment working), but this client's window state goes and comes back. The alternative
is a client that reloads its own document with a new policy, which Electron has no clean
way to do without recreating the window and re-resolving the setting — which is a
relaunch with extra steps and more places to be wrong.

## Risks / Trade-offs

- **Unblocking any part of `/api/v1/desktop` widens the surface for every existing
  Connect Mobile user.** → The allow-list is exact-shape and read-only, and
  `lan_listener_test.go` gains assertions that every other route under the prefix, plus
  every other blocked prefix, still 404s.
- **The network listener is plaintext http by default (ADR 0001).** A password and a
  session token now cross it from a laptop, not just a phone on the same Wi-Fi. → The
  enable path states the transport plainly, `tailscale serve` remains the documented way
  to get TLS, and `ao_web` is `Secure` whenever the request arrived over TLS.
- **Cookie auth on the same origin as the API is a classic CSRF setup.** → Scope
  (`Path=/app/`), method (`GET`/`HEAD`), `SameSite=Strict`, and — the actual guarantee —
  `connectionToken` refusing the cookie anywhere outside the asset path, exactly as it
  already refuses `ao_conn` outside preview files. Tested directly.
- **Two clients on one daemon is newly ordinary** (desktop local plus a browser), where
  before it was a desktop plus a phone. Terminal mux fan-out, presence, and
  workspace-watch assumptions may not hold. → Explicit two-client integration test before
  the feature is documented as supported.
- **Capability gating misses a call site**, so a remote client tries to open a file on the
  daemon's machine or silently no-ops. → Single-hook rule (D9) plus a test that the
  browser fallback stub throws rather than no-ops for every ungated host method.
- **The web bundle diverges from the Electron bundle** and rots. → Same entry, same
  components, one extra vite target; the browser path is exercised by the existing e2e
  suite once `dev:web` points at a real daemon.
- **Scope.** This touches the auth middleware, the block list, the WebSocket upgrade, the
  renderer's transport layer, and the Electron lifecycle. → Sequenced so each layer lands
  behind a default-off flag and is independently testable: backend route policy and
  subprotocol first (useful on their own to the mobile client), then renderer transport,
  then hosting, then Electron remote mode.

## Migration Plan

1. Backend route policy and subprotocol auth. No behavior change for anyone until a client
   uses them. Ships default-on because both are strictly additive and fail closed.
2. Renderer runtime target, auth middleware, mux subprotocol, preview-flag split. Local
   Electron behavior identical; `dev:web` becomes a real client against a local daemon.
3. Capability model and gating.
4. Web client hosting: `webui` build tag plus `remoteAccess.serveWebClient` (default
   false). Off by default on upgrade.
5. Electron remote mode behind `remoteServer` (unset by default).
6. ADR (follow-on to 0001) and docs.

Rollback: each stage is independently revertable. Stages 4 and 5 are inert unless a
setting is turned on; stages 1–3 revert by restoring the prefix in the block list and the
build-time base URL constant.

## Open Questions

- Should `tailscale serve` provisioning also front the web client path, or continue to
  front only the bridge port? Deferrable — it changes the address the operator is handed,
  not the client or the specs.
- Should the mobile app move to the same subprotocol auth for `/mux` and drop its header
  path? Deferrable — the header path is required to keep working regardless.
