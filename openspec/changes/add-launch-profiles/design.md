## Context

See `proposal.md` -- Why. The constraints that shape the approach, all verified in the
current tree:

- `frontend/src/main.ts:169` pins `userData` to `~/.ao/electron` (packaged) or
  `~/.ao/dev/electron` (dev), before `app.whenReady()`. Its comment records both reasons:
  keep the app's whole footprint inside `~/.ao`, and give dev its own profile because "two
  Chromium instances sharing one profile corrupt its LevelDB stores". `sessionData` and
  `crashDumps` derive from `userData`, so the one override reparents them all.
- `frontend/src/main.ts:290` takes `app.requestSingleInstanceLock()` and quits when it is
  refused.
- Electron's lock is keyed by the `userData` path. Verified empirically against this
  repo's Electron 33.4.11: three processes, one holding `userData=A`, a second on `A`
  (refused), a third on `B` (granted). This is not an inference from documentation.
- `frontend/src/main.ts:678` `editorStateDir()` returns `path.dirname(runFilePath())` --
  `~/.ao` packaged, `~/.ao/dev` in dev. It is derived from the run file, not from
  `userData`, so relocating `userData` does not move it. Every remote file lives there:
  `remote-mode.json`, `remote-servers.json`, `remote-credentials.bin`.
- `frontend/src/main/remote-mode.ts` already resolves remote mode from an environment
  variable layered over a persisted setting, with the env var winning and an empty value
  meaning "force local for one launch". `resolveRemoteServer(env, persisted)` is a pure
  function with tests.
- `frontend/src/main.ts:2369` calls it once, before the window and before any spawn, and
  the answer reaches the renderer through `additionalArguments` because IPC cannot answer
  early enough (`main.ts:499`).
- `frontend/src/main/open-folder-arg.ts` is the repo's argv-parsing precedent: a pure
  function over `argv`, unit tested, with `process.defaultApp` used to skip Electron's own
  bootstrap slot. It ignores any entry starting with `-`, so new flags cannot be mistaken
  for a dropped folder.
- `frontend/src/main.ts:2279` reads `--installed-via=` with
  `argv.find((a) => a.startsWith(prefix))`. That is the established shape for an
  app-owned launch flag.
- `frontend/src/main.ts:470` sets `title: "Agent Orchestrator"` on the window;
  `frontend/src/main/tray.ts:70` sets the same string as the tray tooltip when nothing
  needs attention.
- There is no `main.test.ts`. The convention is to put logic in a tested `main/*.ts`
  module and assert the wiring by reading `main.ts` as text
  (`frontend/src/main/remote-mode.test.ts:128`).

## Goals / Non-Goals

**Goals:**

- Four concurrent clients, each attached to a different daemon, from parts that already
  exist.
- An unnamed launch is byte-identical to today: same paths, same lock, no migration.
- Profile selection works for a packaged macOS app, which is the deployment the operator
  actually has.
- Client state is isolated where isolation is the point and shared where sharing saves the
  operator work.

**Non-Goals:**

- Cross-machine dispatch. Four clients are four control planes, not one orchestrator.
- Multiple windows inside one process. That is the design this change was chosen over.
- Any change to daemon spawn, transport, auth, or remote capability gating.
- Profile management UI. A launcher script and a documented flag are the surface.

## Decisions

### D1: Profile is a launch flag, not a setting

A profile decides `userData`, which must be pinned before `app.whenReady()` -- before any
settings file could be read from a profile-scoped location without circularity. It is also
what the single-instance lock keys on, so it cannot be changed by a running process that
already holds a lock. Launch-time input is the only place it can come from.

This mirrors the reasoning already recorded for remote mode: a startup decision, changed
by relaunching, because half the app's lifecycle branches on it.

### D2: Argv, with env as fallback

`--ao-profile=<name>` in argv wins; `AO_PROFILE` in the environment is the fallback.

Argv is not optional. On macOS a second copy of a packaged app is launched with
`open -n -a "Agent Orchestrator" --args ...`, and LaunchServices does not pass the calling
shell's environment to the launched app. An env-only design would work in dev and fail in
the packaged app -- the case this change exists for.

Env is kept as the fallback because it is what works in dev and in `npm run` scripts, and
because `AO_REMOTE_SERVER` already established that shape.

The flag is namespaced `--ao-` rather than a bare `--profile`. Electron forwards unknown
switches to Chromium, which owns a family of `--profile*` switches
(`--profile-directory`, `--profiling-file`, ...), and a bare `--server` is similarly
generic. `--installed-via=` set the precedent for an app-owned flag; the `ao-` prefix makes
the ownership visible in a process list, which matters when the operator is looking at four
Electrons in `ps`.

### D3: Invalid names fall back to the default profile

A name must match `^[a-z0-9][a-z0-9._-]{0,31}$`, and the literal names `.` and `..` are
rejected. Anything else resolves to `null`, meaning the default profile.

The name becomes a directory component, so it is validated rather than sanitised. A
sanitiser that rewrote `../x` into `x` would silently point two launches at one profile --
which is precisely the LevelDB corruption the existing dev/packaged split was introduced to
avoid. Refusing the name is the safe direction.

Falling back rather than exiting follows the rule `resolveRemoteServer` already states for
a bad address: refusing to start would strand a client over a typo, and there is a working
thing to do instead. The fallback is not silent -- the resolved profile is in the window
title, so an operator who typo'd sees an unnamed window rather than a second `vm2`.

Case is not folded. On a case-insensitive filesystem `VM2` and `vm2` would be one
directory and two locks would collide; restricting the alphabet to lowercase makes that
unrepresentable instead of platform-dependent.

### D4: Profiles nest under the existing root

    default      ~/.ao/electron            ~/.ao/dev/electron
    profile vm2  ~/.ao/profiles/vm2        ~/.ao/dev/profiles/vm2

The default branch keeps its literal path, so no existing install moves and there is no
migration to write or to get wrong. Profiles go in a `profiles/` container rather than
beside `electron/` so a directory listing of `~/.ao` does not mix daemon state with a
variable number of Chromium profiles.

The packaged/dev split is preserved inside the profile path for the same reason it exists
at the top: a dev run and a packaged run of the same profile name are still two Chromium
instances, and they still must not share a profile.

### D5: `remote-mode.json` is per-profile; servers and credentials are shared

`editorStateDir()` is not derived from `userData`, so this is a deliberate choice per file
rather than something the `userData` move decides.

- `remote-mode.json` holds "which server is this client attached to". That is the one
  thing that must differ between the four windows, and it must persist -- an operator who
  set up four profiles should not re-supply four addresses on every launch. Non-default
  profiles read and write `remote-mode.<profile>.json` in the same directory. The default
  profile keeps the exact existing filename, so an existing install's setting is still
  found.
- `remote-servers.json` and `remote-credentials.bin` are the address book. Splitting them
  per profile would mean entering the same four addresses and four passwords four times,
  and would multiply the number of places a credential is stored. They stay shared.

The split falls out of the same distinction: what a client *is* differs per profile; what
the operator *knows* does not.

A per-profile filename rather than a per-profile directory keeps `writeRemoteModeSetting`'s
temp-file-and-rename atomicity within one directory, which is what makes the rename atomic.

### D6: `--ao-server=` joins `AO_REMOTE_SERVER`

Same macOS argv reason as D2. It slots into `resolveRemoteServer` ahead of the environment
variable, preserving the existing precedence story (an explicit override for this launch
beats the persisted setting) and the existing empty-value escape hatch: `--ao-server=` with
no value forces local mode for one launch, exactly as `AO_REMOTE_SERVER=` does.

Precedence, highest first: `--ao-server=`, `AO_REMOTE_SERVER`, the profile's persisted
setting.

### D7: The profile names itself in the window title and tray tooltip

Four dock icons and four tray icons that render identically are not usable. A named profile
shows `Agent Orchestrator -- <profile>`; an unnamed one shows `Agent Orchestrator`,
unchanged.

The profile name is used rather than the server address: the address can change during a
session (the operator switches servers, which relaunches), the profile cannot, and a title
that changes under the operator is worse than one that is slightly less specific. The
address is already shown in the UI.

### D8: A launcher script, not a launcher UI

`open -n -a "Agent Orchestrator" --args --ao-profile=vm2 --ao-server=https://...` is
correct and unmemorable. A script wraps it; a dev equivalent goes in `package.json`.

A UI for spawning profiles would have to live inside one of the instances, which makes that
instance a supervisor of the others -- a lifecycle relationship this change deliberately
does not create. Each instance stays unaware that the others exist.

## Risks / Trade-offs

- **Four full Chromium instances.** Roughly 4x the memory of one client. Accepted
  explicitly: it is the cost of not refactoring the single-window path.
- **Four dock and tray icons.** Mitigated by D7, not eliminated.
- **No cross-profile awareness.** Nothing tells profile `vm2` that `vm3` exists, so
  nothing coordinates them -- no shared notification stream, no combined attention count.
  That is a real limitation of this shape and the reason the other shape existed.
- **A profile directory is never garbage collected.** A typo'd-then-corrected profile name
  leaves a Chromium profile behind under `~/.ao/profiles/`. Cheap to delete by hand,
  and cheaper than a cleanup path that could delete a profile in use.
- **Shared credentials mean shared blast radius.** Any profile can read every saved
  password, since they all use one `safeStorage` file. This is unchanged from today's
  single-instance behavior and consistent with these being one operator's own servers.

## Migration Plan

None required. An unnamed launch resolves to the existing paths and the existing
`remote-mode.json` filename, so an install that never passes a profile flag sees no change
on disk and no change in behavior.

## Open Questions

None.
