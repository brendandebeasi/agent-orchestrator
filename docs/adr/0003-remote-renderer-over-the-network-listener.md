# 3. Serving the full renderer over the network listener

Date: 2026-08-25
Status: Accepted

Follows on from [ADR 0001](0001-lan-listener-for-mobile.md). The full design and
task breakdown live in `openspec/changes/add-remote-renderer/`.

## Context

ADR 0001 added a second, authenticated HTTP listener bound to the LAN so a phone
could reach the daemon, and scoped it to what the mobile companion app needed.
Everything else stayed where it was: the desktop app starts its own daemon on
loopback, supervises it, and stops it when the window closes, and the renderer
assumes throughout that "the daemon" is a process on this computer.

What we want now is for the whole renderer to work over that listener -- a
browser tab on a laptop, or a desktop client on one machine attached to a daemon
on another, with the sessions and terminals running where the code is. The
mobile app is a separate, narrower client; this is the same UI, somewhere else.

Three things stood in the way, none of them the network itself.

The network listener's route policy was written for the mobile surface. It
blocks whole prefixes, and the renderer needs routes inside those prefixes.

Browser transports cannot set headers. `Authorization: Bearer` is how the
listener authenticates, and neither the `WebSocket` constructor nor
`EventSource` can send one. The obvious workaround -- a token in the query
string -- puts a live credential in access logs, `Referer` headers, and browser
history.

The renderer assumes it is beside its daemon. It launches editors, reveals
directories in the file manager, opens native file pickers, and embeds a browser
view. On another machine those either do nothing or, worse, do something to the
wrong disk.

## Decision

Serve the renderer from the listener ADR 0001 already added. Do not add a third
listener, and do not make the daemon's bind host configurable -- the loopback
listener stays byte-for-byte what it was, unauthenticated, for the desktop and
CLI clients that reach it through the OS boundary.

**An exact-shape allow-list runs in front of the prefix block list.** The
renderer needs exactly one route under a blocked prefix
(`GET /api/v1/desktop/sessions/{id}/workspace`). Shortening the block list would
have unblocked every sibling, including ones not written yet; the allow-list is
method- and shape-scoped, so a `POST` to the same path and any other route under
`/api/v1/desktop` are still 404 on the network socket. New daemon-control routes
stay blocked by default, which is the direction a mistake should fall.

**WebSocket auth is a negotiated subprotocol.** A client offers
`Sec-WebSocket-Protocol: ao.auth.<base64url-nopad(password)>` on `/mux`; the
daemon validates it through the same `authState` as `authMiddleware`, feeds the
same per-source lockout, and echoes the negotiated subprotocol on success.
Subprotocols are the one header a browser `WebSocket` can set, they are not
logged as URLs, and they are not sent to any other origin. `Authorization:
Bearer` keeps working unchanged for the native clients that can send it.

**Server-sent events are read with `fetch`, not `EventSource`.** Same reason --
`EventSource` can present no credential. The renderer opens three SSE streams
(change events, notifications, per-session workspace file watches), so all three
moved. The reader carries the credential as a header, resumes with
`Last-Event-ID`, and reconnects on a jittered backoff ladder, which is what
`EventSource` was providing for free.

**Static assets authenticate by a path-scoped cookie; nothing else does.** The
login exchange (`POST /api/v1/remote/session`) returns a bearer token and sets
`ao_web`: `HttpOnly`, `SameSite=Strict`, `Path=/app/`, and `Secure` when the
request arrived over TLS. `connectionToken` honors that cookie only for `GET`
and `HEAD` under the asset prefix. So the credential the browser sends
automatically can load the bundle and nothing else -- not the API, not `/mux`,
not a `POST` anywhere. The API credential is the token, held by the tab and
attached deliberately, which is also what keeps a cross-site form post from
reaching the API on a logged-in browser's behalf.

**Hosting the browser client takes two independent opt-ins.** The bundle is
embedded behind `-tags webui` at build time, and serving it requires
`AO_REMOTE_SERVE_WEB` at run time. Serving a UI is a larger surface than serving
an API, and neither the build nor the operator should be able to turn it on
alone: a default build carries no bundle to leak, and a tagged build that nobody
opted into serves nothing.

**Host capabilities are declared by the host, not detected by the renderer.**
`editorHandoff`, `revealInFileManager`, `directoryPicker`, and `browserPanel` are
a declared set. A browser host declares none of them; a desktop client attached
to a remote daemon declares only what still means something. The renderer cannot
work this out by probing -- `window.ao` being present says a preload is there,
not that the feature behind it is meaningful right now -- so the host says.

**Remote mode is a startup decision in the desktop client.** A client pointed
elsewhere does not spawn, supervise, or stop a daemon, and specifically does not
kill one on quit: those are someone else's sessions. The lifecycle branches on it
in half a dozen places, so it is resolved once before anything is spawned, and
changing it relaunches the client.

**The content security policy is computed per launch rather than baked into the
HTML at build time.** It has to name the server, and the server is now a runtime
choice. This is also why changing servers relaunches: the running page's policy
names the old one.

**Plaintext stays plaintext, and TLS is `tailscale serve`.** ADR 0001 accepted
HTTP on a home network as a stated limitation. Nothing here changes that, and
carrying a full renderer over it does not make it safer -- it makes the session
longer and the credential more valuable. The supported way to get a real
certificate is the secure-pairing mode already in the daemon, which points a
tailnet's HTTPS :443 proxy at the bridge port.

## Consequences

- The network listener's surface grows from the mobile API to the whole app API
  plus, optionally, a UI bundle. It is still off by default, still behind the
  same password, and still shares the per-source lockout, which the two new
  credential paths (the subprotocol upgrade and the login exchange) were wired
  into deliberately: without that, the one route that takes a password guess
  would have been the one route that never counted one.
- On an untrusted network, everything ADR 0001 said is now true for longer and
  about more. A captured connection password yields the full app.
- Some features are simply absent on a remote client, which is a visible
  difference between two clients looking at the same daemon. This is stated in
  the UI rather than hidden, because a file picker that opens on the wrong
  machine is worse than one that is not there.
- The loopback path is unchanged. Desktop and CLI clients carry no regression
  risk from any of this, which is what makes the change safe to ship before the
  two-machine manual pass it still wants.
- A future TLS listener remains additive. Nothing above depends on the transport
  being plaintext; the cookie already marks itself `Secure` when the request
  arrived over TLS.
