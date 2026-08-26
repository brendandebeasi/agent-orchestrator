## Context

See `proposal.md` -- Why. Verified in the current tree:

- `internal/httpd/lan_listener.go` builds the network-facing handler as
  `markNetworkListener(lanControlBlock(remoteWebEntry(...)(authed)))`, where
  `authed` wraps `remoteWebAssets`. The loopback server
  (`internal/httpd/server.go`) uses `NewRouterWithControl` directly. The web
  dashboard therefore exists only on the network listener.
- The bind was `net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", port))`, with a
  `//nolint:gosec` comment calling binding all interfaces "the deliberate
  purpose" of the listener.
- `internal/config/config.go` documents the primary listener's host as
  deliberately not configurable, with the reasoning that the daemon has no
  auth, CORS, or TLS and `AO_HOST=0.0.0.0` "would turn it into a public no-auth
  service".
- `tailscale serve` (`internal/mobilebridge/tailscaleserve.go`) proxies to the
  listener. It adds TLS on the tailnet path; it does not change what the
  listener binds, so it does not narrow LAN reachability.

## Goals / Non-Goals

**Goals:**

- Let an operator reach the dashboard on a daemon whose network they do not
  own, without offering that daemon to the network.
- Leave an unconfigured daemon byte-identical in behaviour.
- Change only what the listener binds, never what it accepts once bound.

**Non-Goals:**

- Serving the web client from the loopback listener.
- Any change to authentication, the lockout, the route block list, or TLS.
- Making the primary loopback listener's host configurable. That reasoning
  (no auth, no CORS, no TLS) is untouched and still correct.

## Decisions

### D1: A setting on the network listener, not on the daemon

`AO_LAN_HOST` narrows the authenticated listener. It is deliberately not
`AO_HOST`, which `config.go` refuses to add for the primary listener, and the
distinction is the whole reason this is safe: the primary listener has no
authentication, so widening it would create an open service, while this one has
a password and a lockout, and the setting can only narrow it.

The direction matters. A setting that can only reduce reachability cannot be
the cause of an exposure, whatever value it is given.

### D2: An IP, not a hostname

`net.ParseIP` or reject. A hostname can resolve to several addresses, and
"which interface am I on" is exactly the question an operator is asking when
they set this. Resolving it for them, and possibly resolving it differently
later, would answer a question they did not ask.

Rejecting at `config.Load` rather than at bind time means the daemon refuses to
start on a typo instead of starting and quietly binding the default. For a
setting whose entire job is to restrict exposure, failing closed at startup is
the only safe direction: a value that silently fell back to `0.0.0.0` would put
the daemon on the LAN precisely when the operator believed they had taken it
off.

### D3: Empty means the default, at both layers

`NewLANManagerOn("")` and an unset `AO_LAN_HOST` both resolve to
`DefaultLANHost`. `NewLANManager` stays as it was and delegates. A caller that
has not thought about the bind interface gets what this listener has always
done, which keeps every existing call site and test meaningful without
rewriting them.

### D4: The ephemeral-port fallback follows the configured interface

When the wanted port is taken the listener already falls back to an
OS-assigned port. That fallback now binds the same interface rather than
`0.0.0.0`, because a fallback that widened reachability would defeat the
setting in exactly the situation nobody is watching.

## Risks / Trade-offs

- **An operator can bind an interface that does not exist**, and the daemon
  fails to start rather than silently binding something else. That is the
  intended direction, but it is a new way for a daemon to refuse to start, and
  the error names the address.
- **The dashboard over a tunnel is plaintext HTTP inside the tunnel.** The
  tunnel is encrypted, so this is fine on the wire, but the connection password
  still crosses it and is still reusable by anything with access to the
  operator's own loopback.
- **Nothing stops an operator from setting this to a LAN address**, which is a
  deliberate exposure and reads as one.

## Migration Plan

None. An unset `AO_LAN_HOST` produces the previous bind exactly.

## Open Questions

None.
