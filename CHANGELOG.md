# Changelog

Fork-local changelog covering changes made on this fork. Upstream releases are published
at https://github.com/Untrivial-ai/agent-orchestrator/releases.

## Unreleased

### Added

- The daemon's opt-in network listener now admits a full client, not just the mobile
  app: the renderer's workspace route is reachable over it, and terminal streams
  authenticate through a WebSocket subprotocol, which a browser can offer where it
  cannot set a header.
- A daemon built with `-tags webui` and started with `AO_REMOTE_SERVE_WEB=on` hosts the
  browser client itself, behind the same connection password, and reports on `/healthz`
  the app version it was launched by.
- The renderer now addresses a server rather than assuming the one on this computer: a
  target store holds the address and password, HTTP requests and terminal sockets present
  the credential, and switching targets retires the open sockets and the query cache
  instead of leaving another machine's answers on screen.
- Features that reach for a file on a disk — opening an editor, revealing a folder, the
  native directory picker, the embedded browser view — are now declared capabilities
  rather than assumptions. A capability holds only when the host offers it *and* the
  server is this computer, so connecting to a daemon elsewhere withdraws them with a
  stated reason instead of quietly acting on the wrong machine's files.
- Importing and cloning against a remote server ask for a folder path rather than opening
  a file dialog that could only show this computer's disk.
- A connection screen that takes a server address and password and checks them before
  committing, so a mistyped address does not cost an operator the connection they already
  had. It says which of the four things went wrong — nothing listening, password refused,
  too many attempts, or something answering that is not a daemon — and leaves the address
  in the field to correct.
- The sidebar now names the server the client is talking to and says when the link has
  dropped, so a stalled window is distinguishable from a quiet one. Nothing is shown for a
  daemon on this computer, which has its own failure banner already.
- Servers the operator has connected to are remembered between launches, addresses in
  plain text and passwords in the OS keychain, and removing a server takes its password
  with it. A browser client keeps neither, which its session cookie already covers.
- A client and server on different versions say so, with both versions, next to the server
  name. It is a note rather than a refusal to connect.
- Planning artifacts for remote renderer support under
  `openspec/changes/add-remote-renderer/` — proposal, `remote-access` and `remote-client`
  specs, design, and task list.

### Changed

- Adding a project whose folder is not there now says the folder could not be read,
  rather than reporting it as not a Git repository. The two are different problems, and
  with no local directory picker to rule the first one out, the daemon's answer is the
  only one the operator gets.
- The browser fallback bridge throws from anything behind a withdrawn capability instead
  of resolving to a plausible-looking nothing, so a missing guard surfaces where it is
  rather than as an empty result several screens later.
- The browser build now talks to a real daemon. Serving fixtures moved off
  `VITE_NO_ELECTRON` onto a `VITE_AO_PREVIEW` flag of its own, so "there is no Electron
  preload" and "there is no daemon" stop being the same question; `npm run dev:web` runs
  the renderer against a running daemon and `npm run dev:web:preview` keeps the fixture
  build the end-to-end suite is written against.
- Server-sent event streams (change events, notifications, and the workspace file watch)
  are read with `fetch` instead of `EventSource`, which cannot present a credential.
  Reconnect and last-event resume, which `EventSource` provided, are now explicit: the
  reader climbs a jittered backoff ladder and resumes with `Last-Event-ID`.
