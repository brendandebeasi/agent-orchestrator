## Why

The web dashboard is served by the network listener, not the loopback one
(`lan_listener.go` wraps the shared router in `remoteWebEntry` and
`remoteWebAssets`; the loopback server gets the bare router). So reaching the
dashboard means running that listener, and that listener hardcodes
`net.Listen("tcp", "0.0.0.0:<port>")` with no override anywhere in `httpd/`,
`mobilebridge/`, or `config/`.

For a daemon on a machine the operator owns, binding every interface is the
right default and what the phone needs. For a daemon on a client's network it
is the only option and the wrong one: the choice becomes "no dashboard" or "a
password-authenticated, plaintext HTTP daemon that runs commands in git
worktrees, offered to everything else on that LAN".

Those are not the same ask. "Reachable from my workstation" and "reachable from
every machine on this network" only coincide because the bind address was never
a choice.

## What Changes

- `AO_LAN_HOST` names the interface the network listener binds. It defaults to
  `0.0.0.0`, so a daemon nobody configures behaves exactly as it does today.
- The value must be an IP address. A hostname can resolve to several addresses,
  which would make "which interface" ambiguous at the moment an operator most
  wants it pinned.
- Nothing else changes. The setting can only narrow what the listener accepts;
  the connection password, the per-source lockout, and the route block list all
  still apply, and none of them is reachable through this.

With `AO_LAN_HOST=127.0.0.1` the listener answers only on the box's own
loopback, which an SSH tunnel reaches and nothing else does. That makes the
dashboard available over a tunnel the operator already has, with SSH doing the
authentication and nothing new listening where strangers can find it.

Out of scope: serving the web client from the loopback listener. That would be
a second, unauthenticated copy of the same surface, and the point here is to
keep exactly one.

## Capabilities

### Modified Capabilities

- `remote-access`: the network listener's bind interface becomes a setting
  rather than a constant.

### New Capabilities

None.

## Impact

- `backend/internal/config/config.go` -- `RemoteAccessConfig.ListenHost`,
  `DefaultLANHost`, the `AO_LAN_HOST` read and its validation
- `backend/internal/httpd/lan_listener.go` -- `NewLANManagerOn`, the bind in
  `Start`

Docs: `docs/remote-access.md`, `CHANGELOG.md`. No frontend change.
