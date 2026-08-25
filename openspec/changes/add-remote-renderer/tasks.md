## 1. Backend route policy

- [x] 1.1 Add an exact-shape allow-list to `isLANControlBlockedPath` in `backend/internal/httpd/lan_listener.go` that runs before the prefix block list, seeded with `GET /api/v1/desktop/sessions/{sessionId}/workspace`, keeping `/api/v1/desktop` in `lanControlBlockedPrefixes`; verify with new cases in `lan_listener_test.go` asserting the allowed route reaches the handler.
- [x] 1.2 Extend `lan_listener_test.go` with a table asserting every other route under `/api/v1/desktop` (including an invented future one) and every other blocked prefix still returns 404 on the network socket while reaching the handler on loopback; verify `go test ./internal/httpd/ -run LANControl` passes.
- [x] 1.3 Assert the allow-list is method-scoped: `POST`/`DELETE` to the allowed workspace path returns 404 on the network socket; verify by the new test case.

## 2. Backend WebSocket auth

- [x] 2.1 Accept `Sec-WebSocket-Protocol: ao.auth.<base64url-nopad(password)>` on `/mux` in `backend/internal/httpd/terminal_mux.go`, validated through the same `authState` used by `authMiddleware`, echoing the negotiated subprotocol on success; verify with a `terminal_mux_test.go` case that dials with the subprotocol and reads a frame.
- [x] 2.2 Refuse the upgrade with 401 and no upgrade when the subprotocol credential is wrong, absent, or supplied only in the query string; verify with three `terminal_mux_test.go` cases asserting status and that no WebSocket handshake completes.
- [x] 2.3 Keep `Authorization: Bearer` working unchanged for native clients (the mobile app's path); verify the existing `terminal_mux_test.go` header cases still pass unmodified.
- [x] 2.4 Replace `InsecureSkipVerify: true` with an origin check that applies only to upgrades arriving on the network listener (no `Origin` header, or `Origin` equal to that listener's own origin), leaving loopback behavior identical; verify with cases covering loopback-with-foreign-origin (accepted, as today) and network-with-foreign-origin (refused).
- [x] 2.5 Feed the per-source lockout in `auth.go` from failed subprotocol upgrades as well as failed HTTP requests; verify with a test that six bad upgrades lock out a subsequent good one.

## 3. Backend remote session and asset hosting

- [ ] 3.1 Add `POST /api/v1/remote/session`: validates the password through `authState`, returns the daemon app version and the connection token, and sets `ao_web` (HttpOnly, `SameSite=Strict`, `Path=/app/`, `Secure` when the request arrived over TLS); verify with a new `remote_session_test.go` asserting the cookie attributes and the 401 path.
- [ ] 3.2 Extend `connectionToken` in `backend/internal/httpd/auth.go` to honor `ao_web` only for `GET`/`HEAD` under the asset path, mirroring `previewFilesCookiePath`; verify with `auth_test.go` cases asserting the cookie authenticates `/app/index.html` and does not authenticate `/api/v1/sessions`, `/mux`, or a `POST` to `/app/`.
- [ ] 3.3 Add `remoteAccess.serveWebClient` (default false) to the daemon settings store and thread it into router construction; verify with a test that the asset routes are absent when the flag is false.
- [ ] 3.4 Add a `webui`-build-tag `embed.FS` asset handler plus a default-build stub, serving `GET /app/*` from the embedded bundle and returning the entry point for unknown paths under `/app/`; verify `go build ./...` succeeds both with and without `-tags webui` and that the stub build returns 404 for `/app/`.
- [ ] 3.5 Serve a self-contained login page (inline style and script only, no subresources) at `GET /` on the network listener when `serveWebClient` is on and the request is unauthenticated; verify with a test asserting the response references no external URLs and returns 200 without credentials.
- [ ] 3.6 Add the app version to `/healthz` alongside the existing fields; verify with a `server_test.go` assertion on the field.
- [ ] 3.7 Confirm `backend/internal/httpd/cors.go` needs no allowlist widening for the same-origin web client, and add a `cors_test.go` case asserting a request from an unlisted origin to the network listener is still refused.

## 4. Renderer transport

- [ ] 4.1 Add a `ServerTarget` store holding `{ baseUrl, label, requiresAuth }` plus the credential, driving `setApiBaseUrl` from `frontend/src/renderer/lib/api-client.ts`; verify with unit tests that a target change propagates through `subscribeApiBaseUrl`.
- [ ] 4.2 Add an `openapi-fetch` middleware that attaches `Authorization: Bearer` from the store on every request; verify with an `api-client.test.ts` case asserting the header is present after a credential is set and absent when the target requires no auth.
- [ ] 4.3 Offer the credential as the `ao.auth.*` subprotocol in `frontend/src/renderer/lib/terminal-mux.ts` when the target requires auth; verify with a unit test asserting the constructed `WebSocket` receives the encoded subprotocol argument.
- [ ] 4.4 On target change, close open mux sockets, clear the react-query cache, and re-run the handshake; verify with a test asserting sockets are closed and queries refetch against the new base URL.
- [ ] 4.5 Discard the stored credential and return to the connection prompt when the server answers 401; verify with a test driving a 401 through the middleware.

## 5. Renderer preview-mode split

- [ ] 5.1 Add `isPreviewMode()` in `frontend/src/renderer/lib/preview-mode.ts` driven by `VITE_AO_PREVIEW`, and switch `useShellTerminals`, `useWorkspaceQuery`, `useSessionScmSummary`, and `useMigrationOffer` from `VITE_NO_ELECTRON` to it; verify existing unit tests pass and add one per hook asserting it queries the server when preview is off.
- [ ] 5.2 Change `dev:web` to set only `VITE_NO_ELECTRON=1` and add `dev:web:preview` that also sets `VITE_AO_PREVIEW=1`; verify the e2e suites that depend on fixtures pass against `dev:web:preview`.
- [ ] 5.3 Verify `npm run dev:web` against a locally running daemon renders real sessions, shells, workspace status, and SCM summaries through the existing vite proxy.

## 6. Renderer capability model

- [ ] 6.1 Add `capabilities` to `aoBridge` in `frontend/src/renderer/lib/bridge.ts` (`editorHandoff`, `revealInFileManager`, `directoryPicker`, `browserPanel`), reported true by the Electron preload and false by the browser fallback stub; verify with a unit test on each host shape.
- [ ] 6.2 Add a `useHostCapability(name)` hook as the only permitted read of `capabilities`, and add a lint rule or test asserting no other module reads the field; verify the rule fires on a deliberate violation.
- [ ] 6.3 Convert every call site of the four host-bound features to gate on the hook, rendering the action absent or disabled with a stated reason; verify with component tests that each action is unavailable when its capability is false.
- [ ] 6.4 Make the browser fallback stub throw rather than silently resolve for every ungated host method; verify with a test enumerating the stub's methods.
- [ ] 6.5 Replace the local directory picker with a path-entry field validated against the daemon when the target is remote, surfacing the daemon's error when the path does not exist; verify with a component test plus an integration case against a remote target.

## 7. Renderer connection experience

- [ ] 7.1 Add a connection screen that takes an address and password, distinguishes unreachable from rejected, and leaves the address editable on failure; verify with component tests for both failure modes.
- [ ] 7.2 Show the connected server in the UI and indicate reconnecting state on drop, without presenting last-known session output as live; verify with a test that simulates a dropped mux socket.
- [ ] 7.3 Persist server entries and credentials through the bridge (Electron `safeStorage`; browser persists nothing), with an operator action to remove a saved server that deletes its credential; verify with tests on both host shapes.
- [ ] 7.4 Report a version mismatch between client and server with both versions after the handshake, without blocking; verify with a test feeding a mismatched handshake response.

## 8. Electron remote mode

- [ ] 8.1 Add a `remoteServer` setting with an `AO_REMOTE_SERVER` env override, read once at startup in `frontend/src/main.ts`; verify with a unit test on the resolver.
- [ ] 8.2 When `remoteServer` is set, skip daemon discovery, spawn, attach, `bundledDaemonIdentityError`, `shouldLinkOnAttach` supervisor linking, the browser-runtime token handoff, and shutdown-on-quit; verify with tests asserting none of those paths run and that they all run when the setting is empty.
- [ ] 8.3 Report `browserPanel: false` from the preload when in remote mode, since the browser-runtime address comes from the local run file; verify with a preload unit test.
- [ ] 8.4 Verify end to end that quitting the desktop client in remote mode leaves the remote daemon and its sessions running.

## 9. Web client build

- [ ] 9.1 Add a vite build target that emits the renderer bundle for a browser host under a `/app/` base path; verify `npm run build:web` produces an index and assets that reference only relative paths.
- [ ] 9.2 Wire the built bundle into the backend `webui` build tag embed; verify a `-tags webui` binary serves the client and a default binary does not.

## 10. Integration verification

- [ ] 10.1 Add an integration test with two clients on one daemon (a loopback client and a network client) driving the same session, asserting terminal mux fan-out, presence, and workspace watch behave for both.
- [ ] 10.2 Add an end-to-end test that authenticates over the network listener, loads the session list, opens a terminal by subprotocol, and reads agent output.
- [ ] 10.3 Confirm the loopback path is byte-identical in behavior: run the full existing backend and frontend suites with network access disabled and assert no diffs in behavior or output.

## 11. Documentation

- [ ] 11.1 Write an ADR under `docs/adr/` as a follow-on to `0001-lan-listener-for-mobile.md` recording the allow-list, subprotocol auth, cookie scoping, and build-tag decisions; verify it links back to 0001 and to this change.
- [ ] 11.2 Document enabling network access, the transport warning, and the `tailscale serve` path in the README and `docs/development.md`; verify the documented commands run as written.
- [ ] 11.3 Document the desktop remote mode setting and the withdrawn feature set; verify the list matches the capabilities declared in code.
