# Roadmap

Fork-local roadmap. Upstream work is tracked in `docs/STATUS.md` and `docs/plans/`.

## In progress

- **Remote renderer** — run the GUI on one machine and the daemon plus agents on
  another. Spec: `openspec/changes/add-remote-renderer/`. Sequenced as backend route
  policy and WebSocket subprotocol auth, then renderer runtime transport, then the
  capability model, then web-client hosting, then Electron remote mode.

## Not planned

- Public-internet exposure of the daemon. Network access stays a trusted-network or
  tailnet feature; TLS remains the operator's responsibility via `tailscale serve`.
- Per-client scopes or accounts. A single shared password remains the only credential.
