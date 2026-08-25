## Why

The daemon binds `127.0.0.1` and the desktop supervisor hardcodes that address, so the
GUI and the agents it drives have to share a machine. Most of what a remote client needs
already exists, built for the phone: an opt-in listener on `0.0.0.0` behind a bearer
password with per-source lockout, and a tailnet-only HTTPS proxy via `tailscale serve`.
Two things keep the desktop and browser clients out: route policy on that listener, and
transport details (request headers on a WebSocket, cross-origin requests) that a browser
cannot satisfy.

## What Changes

- The network listener serves the routes a full client needs. `/api/v1/desktop/...` (the
  workspace summary the renderer reads) becomes reachable behind auth; `/shutdown`,
  `/internal/`, `/api/v1/mobile`, `/api/v1/dev`, `/api/v1/system/install`, and
  `/api/v1/browser` stay blocked at the socket.
- `/mux` accepts a connection token offered as a WebSocket subprotocol, so a browser --
  which cannot set request headers on a WebSocket -- can authenticate. The
  `Authorization: Bearer` header keeps working for native clients.
- The daemon optionally serves the built web renderer from the network listener, making
  the browser client same-origin: no CORS allowlist entry per client machine, and no
  token in a query string.
- The renderer's API base URL and credentials become runtime state instead of a
  build-time constant, with a connection screen for entering a server address and
  password.
- The `VITE_NO_ELECTRON` short-circuits that return fixture data become an explicit
  preview flag, so a real web build talks to a real daemon instead of mocks.
- Electron gains a remote mode that skips daemon spawn, attach, binary-identity checks,
  the supervisor link, and shutdown-on-quit, and connects to a configured server instead.
- Features that act on the client machine's filesystem or window are gated on a
  capability flag when the daemon is remote: editor handoff, reveal in file manager, the
  native folder picker used to add a project, and the browser panel (with it, the
  `ao preview` link the daemon establishes at spawn time).

Out of scope: any public exposure (this stays LAN or tailnet only), moving agents to
hosted infrastructure, and any change to the loopback listener's bind host or its
unauthenticated posture.

## Capabilities

### New Capabilities

- `remote-access`: the daemon's authenticated network surface for full clients -- which
  routes it serves, how a header-less client authenticates the terminal WebSocket, and
  how the web client is hosted.
- `remote-client`: how the renderer and the Electron supervisor target a server that is
  not on this machine -- server selection, credential handling, and which features are
  withdrawn when the daemon is remote.

### Modified Capabilities

None. This is the first OpenSpec change in the repository, so there are no existing
capability specs to amend.

## Impact

Backend:

- `backend/internal/httpd/lan_listener.go` -- blocked-prefix policy
- `backend/internal/httpd/auth.go` -- subprotocol token extraction
- `backend/internal/httpd/terminal_mux.go` -- subprotocol negotiation on upgrade
- `backend/internal/httpd/router.go` -- static web client mount
- `backend/internal/mobilebridge/config.go` -- persisted remote-access settings

Frontend:

- `frontend/src/renderer/lib/api-client.ts` -- runtime base URL, auth header
- `frontend/src/renderer/lib/terminal-mux.ts` -- subprotocol on connect
- `frontend/src/renderer/lib/bridge.ts` -- capability reporting on the fallback bridge
- `frontend/src/renderer/hooks/*` -- preview-data short-circuits
- `frontend/src/main.ts`, `frontend/src/main/daemon-*.ts` -- remote mode
- `frontend/vite.renderer.config.ts` plus a web entry point and build script

Docs: `docs/adr/` (a follow-on to ADR 0001), `README.md`, `docs/development.md`.
