# Remote access

By default AO runs everything on one computer: the desktop app starts a daemon
on `127.0.0.1`, and the sessions, worktrees, and agent processes live beside it.
Nothing is reachable from the network, which is why the loopback daemon needs no
password.

Remote access opts a second listener in, on the LAN, behind a password. Two kinds
of client can use it:

- **A desktop client on another computer**, attached to your daemon. Same app,
  same window, sessions running on the other machine.
- **A browser tab**, served the same UI by the daemon itself. Needs a daemon
  built with the web client in it (see [Hosting the browser
  client](#hosting-the-browser-client)).

Both are the full app, not the mobile companion. Some features are missing, and
[which ones](#what-a-remote-client-cannot-do) is not arbitrary.

> **Traffic on this connection is not encrypted.** The listener speaks plain
> HTTP. Use it on a network you trust, or put TLS in front of it with
> [Tailscale](#tls-with-tailscale-serve). The connection password and everything
> the app sends travel in the clear otherwise, and a captured password is the
> whole app.

## Turning the listener on

In the desktop app, open **Connect Mobile** from the sidebar, or **Settings ->
Mobile**. It is the same listener whichever client you plan to attach; the name
predates this.

From a terminal, against a running daemon:

```bash
curl -s -X POST http://127.0.0.1:3001/api/v1/mobile/enable
```

```json
{
  "enabled": true,
  "host": "192.168.8.239",
  "tailscaleHost": "100.88.114.114",
  "port": 3011,
  "password": "y8RhoEGr",
  "warning": "Traffic on this connection is not encrypted. Only use it on a network you trust.",
  "securePairing": { "enabled": false, "available": false, "active": false, "host": "", "port": 0, "reason": "" }
}
```

The password is shown once, on enable and on regenerate, and is stored only as a
hash. To read the current state, rotate the password, or turn the listener off:

```bash
curl -s http://127.0.0.1:3001/api/v1/mobile/status
curl -s -X POST http://127.0.0.1:3001/api/v1/mobile/regenerate
curl -s -X POST http://127.0.0.1:3001/api/v1/mobile/disable
```

Those four routes are loopback-only. Asking for them over the network listener
returns 404, so a client that has the password still cannot rotate it, read it,
or turn the listener off.

State lives in `~/.ao/data/mobile/config.json`. Rotating the password drops
every attached client.

### Checking it from another machine

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.8.239:3011/api/v1/sessions
# 401

curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer y8RhoEGr' \
  http://192.168.8.239:3011/api/v1/sessions
# 200
```

Five failed attempts lock out that source address for a while. The lockout is
per-source, so a device guessing passwords cannot lock out the client you
actually use.

## Attaching a desktop client

Install AO on the second computer as usual, then point it at the first. Open
**Settings -> General -> Server**, choose the server, and enter the connection
password. The client relaunches, because where the daemon is decides how the app
starts.

For one launch, without touching the setting:

```bash
AO_REMOTE_SERVER=http://192.168.8.239:3011 open -a "Agent Orchestrator"
```

`AO_REMOTE_SERVER` wins over the setting whenever it is present, including when
it is present and empty, which is how you force a client back to its own daemon
for one launch:

```bash
AO_REMOTE_SERVER= open -a "Agent Orchestrator"
```

The setting itself is `~/.ao/remote-mode.json`. Deleting it returns the client to
its own daemon on the next launch.

A client in remote mode starts no daemon of its own, supervises none, and stops
none. Quitting it leaves the sessions running -- they were never its processes.
The daemon it attached to is still someone's local daemon, so the person sitting
at that machine can use the app normally at the same time.

## Hosting the browser client

The browser client takes two independent opt-ins: it has to be built into the
binary, and the operator has to ask for it to be served. A stock release does
neither.

Build a daemon with the client embedded:

```bash
cd frontend && npm run build:web
cd ../backend && go build -tags webui -o /tmp/ao ./cmd/ao
```

`npm run build:web` writes the bundle into `backend/internal/httpd/webclient/`,
which is where `-tags webui` embeds it from. Building without the tag ignores
whatever is in that directory; the binary is about 6 MB smaller and carries no
client to serve.

Run it with the hosting flag on:

```bash
AO_REMOTE_SERVE_WEB=on /tmp/ao daemon
```

Then enable the listener as above and open `http://192.168.8.239:3011/` in a
browser. You get a login page, which takes the connection password and hands the
tab a token.

Both opt-ins are load-bearing. Without the build tag there is nothing to serve;
without `AO_REMOTE_SERVE_WEB` a tagged binary serves nothing, and `/` and
everything under `/app/` answer as they would on any other build.

## TLS with `tailscale serve`

The listener has no TLS of its own. The supported way to get a real certificate
is Tailscale's HTTPS proxy, which AO can drive for you: enable **secure pairing**
in the Connect Mobile settings, and the daemon runs

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3011
```

re-applying it whenever the listener restarts, so the proxy is never left
pointing at a dead port. It needs the `tailscale` CLI on `PATH`, MagicDNS, and
HTTPS certificates enabled for the tailnet; the settings UI names which of those
is missing.

With the proxy up, clients use the MagicDNS name instead of the LAN address:

```bash
AO_REMOTE_SERVER=https://your-machine.tailnet-name.ts.net open -a "Agent Orchestrator"
```

Traffic is then encrypted end to end, the asset cookie marks itself `Secure`, and
the connection password no longer crosses the network in the clear. This is the
right setup for anything other than a home network you control.

## What a remote client cannot do

Four features reach past the daemon to the computer it runs on. A remote client
withdraws all four rather than doing them to the wrong disk:

| Feature | Why it is withdrawn |
| --- | --- |
| Open a session in your editor | The worktree is a path on the server's disk, not yours. |
| Reveal a worktree in the file manager | Same path, same problem. |
| Native directory picker | Browsing your own folders would pick a path the server cannot see. |
| The agent-controllable browser panel | The embedded browser view runs in the desktop process; there is nothing on the server for it to attach to. |

A browser tab has none of the four either, for a simpler reason: they are
Electron features and a tab is not Electron.

The rule in code is that a feature is available only when the host is wired for
it **and** the daemon is local, so a desktop client attached to a remote daemon
lands in the same place as a browser tab. Where a button would have been, the app
says which of the two conditions failed.

Everything else works: sessions, terminals, chat, the Kanban board, projects,
pull requests, agent reviews, notifications, and the workspace file view.

One consequence worth knowing before you go looking for the bug: **project paths
are resolved on the server**. Adding a project from a remote client means typing
a path that exists on the server's disk, and since the directory picker is one of
the withdrawn features, typing is what you will be doing.

## See also

- [ADR 0001](adr/0001-lan-listener-for-mobile.md) -- why the listener exists and
  why it is plaintext.
- [ADR 0003](adr/0003-remote-renderer-over-the-network-listener.md) -- how the
  full renderer is served over it.
