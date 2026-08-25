## Why

`add-remote-renderer` gave the desktop app a remote mode: it can skip daemon spawn and
drive a daemon on another machine. What it did not give is more than one of them at a
time. An operator with agents running on four VMs wants four control planes side by side,
and today the second launch exits at `app.requestSingleInstanceLock()` because every
launch shares one Electron profile.

The alternative -- one app window per server inside a single process -- means threading a
window identity through 41 `mainWindow` references and 50 `ipcMain` handlers that read
module globals rather than `event.sender`, putting the single-window path at risk for the
sake of a case that a second process already covers. Electron's single-instance lock is
keyed by the `userData` path (verified: two Electron 33 processes with distinct `userData`
both take the lock; two sharing one do not), so naming a profile is the whole mechanism.

## What Changes

- A launch names a profile via `--profile=<name>` in argv or `AO_PROFILE` in the
  environment. Argv is required, not a convenience: on macOS a second copy of a packaged
  app starts through `open -n -a <app> --args ...`, and LaunchServices does not carry the
  caller's environment.
- A named profile relocates `userData` to a sibling directory under the same `~/.ao` root,
  which gives that launch its own Chromium profile and its own single-instance lock.
- An unnamed launch is unchanged, to the byte: same `userData` path, same lock, no
  migration for existing installs.
- The remote-mode record (`remote-mode.json`, "which server is this window") becomes
  per-profile. The saved-server list and its credentials stay shared, so a server address
  and password are entered once and available to every profile.
- `--server=<url>` joins `AO_REMOTE_SERVER` as a per-launch server override, for the same
  macOS argv reason.
- The window title and tray tooltip name the profile, so four dock icons are
  distinguishable. An unnamed launch shows today's text unchanged.
- A launcher script composes the platform-correct invocation so an operator is not
  hand-writing `open -n -a ... --args ...`.

Out of scope: one orchestrator dispatching work across machines. An orchestrator delegates
by shelling out to `ao spawn`
(`backend/internal/session_manager/chat_spawn.go`), and `ao` resolves its daemon as
`http://127.0.0.1:<port>` from a local run file (`backend/internal/cli/client.go`). Giving
the CLI a `--server` is a separate change; this one gives the operator four independent
clients, not cross-machine dispatch.

Also out of scope: any change to daemon spawn, to the remote transport, or to what a
remote client is allowed to do. This change is entirely about which profile directory a
launch uses.

## Capabilities

### Modified Capabilities

- `remote-client`: gains profile-scoped client state -- how a launch selects a profile,
  what that profile isolates, what it deliberately shares, and how concurrent clients are
  told apart.

### New Capabilities

None.

## Impact

Frontend:

- `frontend/src/main/launch-profile.ts` -- new; profile resolution and validation
- `frontend/src/main.ts` -- `userData` path, window title
- `frontend/src/main/remote-mode.ts` -- profile-scoped record path, `--server=` argv
- `frontend/src/main/tray.ts` -- tooltip
- `frontend/scripts/` and `package.json` -- launcher

Docs: `docs/remote-access.md`, `CHANGELOG.md`.

No backend change.
