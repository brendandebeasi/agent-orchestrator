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
- The desktop client can be pointed at a daemon on another computer and stop running one
  of its own. Connecting to a server records it as where the next launch should look, so
  the question is asked once; `AO_REMOTE_SERVER` overrides the setting for a single
  launch. Such a client starts no daemon, attaches to none already running, and — the
  point of the whole thing on a shared machine — takes none down when it quits. Going back
  to a local daemon is a button on the same screen, which clears the setting.
- Settings now says which computer the client is talking to, with a button to change it.
  Until this existed the connection screen only appeared to a client that already had a
  server and had lost its password, so the environment variable was the only way to point
  one at a server in the first place. Changing servers restarts the app, in both
  directions, and says so before it happens.
- `npm run build:web` in `frontend/` builds the browser client straight into the directory
  the daemon embeds from, so producing the bundle and embedding it are one step. The build
  refuses to finish if the entry point came out referencing its assets from the server
  root, which would build cleanly and then serve a blank page.
- The browser client now picks up the credential its login page obtained, instead of
  loading successfully and then failing every call it made. The token is kept per tab, so
  a second tab on the same daemon loads the app and then asks for the password again
  rather than inheriting a session nobody signed into it with.
- `docs/remote-access.md` documents the whole path from the operator's side: turning the
  network listener on, attaching a desktop client, building and hosting the browser
  client, getting TLS through `tailscale serve`, and which four features a remote client
  withdraws and why. Every command in it was run against a live daemon.
- `docs/adr/0003-remote-renderer-over-the-network-listener.md` records the decisions
  behind all of it, as a follow-on to ADR 0001.
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
- "Is the server ready" is now answered by the server in use rather than always by the
  local supervisor. A client attached to another computer would otherwise sit on the
  startup loader forever, because the supervisor it is still wired to correctly reports
  that it never started a daemon. Status events from the local supervisor are dropped
  entirely once the client is aimed elsewhere, so they cannot re-aim it or explain a
  remote server's failures with a local daemon nobody asked for.
- The browser panel is withdrawn on a client attached to a remote server. Unlike the other
  host features, it is absent rather than misdirected: the panel attaches to a browser
  runtime whose address the app reads from this computer's run file, and there is no such
  file when no daemon runs here.
- The content security policy is no longer a constant baked into the bundle. It named the
  loopback range, which was the correct answer while every daemon was on this computer and
  is the wrong one now: a client attached to a server elsewhere would have blocked its own
  first request before it left the page. The browser build carries a policy naming its own
  origin, and the desktop client's is written per launch by the main process and sent as a
  response header, since a page carrying both a header and a tag gets whichever is
  narrower.
