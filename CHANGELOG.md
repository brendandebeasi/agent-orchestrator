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
- Planning artifacts for remote renderer support under
  `openspec/changes/add-remote-renderer/` — proposal, `remote-access` and `remote-client`
  specs, design, and task list.

### Changed

- Server-sent event streams (change events, notifications, and the workspace file watch)
  are read with `fetch` instead of `EventSource`, which cannot present a credential.
  Reconnect and last-event resume, which `EventSource` provided, are now explicit: the
  reader climbs a jittered backoff ladder and resumes with `Last-Event-ID`.
