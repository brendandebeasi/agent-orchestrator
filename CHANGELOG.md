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
- Planning artifacts for remote renderer support under
  `openspec/changes/add-remote-renderer/` — proposal, `remote-access` and `remote-client`
  specs, design, and task list.
