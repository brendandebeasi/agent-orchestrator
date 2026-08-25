import path from "node:path";

/** The environment variable naming this launch's profile. */
export const LAUNCH_PROFILE_ENV = "AO_PROFILE";

/** The argv flag naming this launch's profile. */
export const LAUNCH_PROFILE_ARG_PREFIX = "--ao-profile=";

/** The window title and idle tray tooltip a launch on the default profile shows. */
export const DEFAULT_WINDOW_TITLE = "Agent Orchestrator";

/**
 * Names a profile may take.
 *
 * The name becomes a directory component, so it is validated rather than
 * sanitised: a sanitiser that rewrote `../x` into `x` would silently point two
 * launches at one Chromium profile, which is exactly the LevelDB corruption the
 * dev/packaged split in main.ts exists to avoid. Refusing the name is the safe
 * direction.
 *
 * The anchored leading class also makes `.` and `..` unrepresentable, so
 * traversal needs no separate check.
 *
 * Lowercase only. On a case-insensitive filesystem `VM2` and `vm2` would be one
 * directory but two names, and whether the two collided would depend on the
 * volume. Restricting the alphabet makes that unrepresentable instead of
 * platform-dependent.
 */
const VALID_PROFILE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/**
 * The profile this launch runs under, or null for the default profile.
 *
 * argv wins over the environment, and argv is not a convenience: on macOS a
 * second copy of a packaged app starts through `open -n -a <app> --args ...`,
 * and LaunchServices does not pass the calling shell's environment to what it
 * launches. An environment-only design would work in dev and fail in the
 * packaged app -- the case profiles exist for. The environment stays as the
 * fallback because it is what `npm run` scripts and dev runs can set, and
 * because AO_REMOTE_SERVER already established that shape.
 *
 * A name this cannot accept resolves to the default profile rather than
 * stopping the launch, for the reason resolveRemoteServer already records for a
 * bad address: refusing to start would strand a client over a typo. The
 * fallback is not silent -- the resolved profile is in the window title, so an
 * operator who typo'd sees an unnamed window rather than a second `vm2`. The
 * launcher script, which can still say no, rejects instead.
 *
 * Electron's own bootstrap argv slot needs no skipping here, unlike in
 * parseOpenFolderPathArg: that reads positional entries, where the app path is
 * ambiguous with a dropped folder. This matches a flag prefix, and the app path
 * is never one.
 */
export function resolveLaunchProfile(argv: string[], env: NodeJS.ProcessEnv): string | null {
	const flag = argv.find((entry) => entry.startsWith(LAUNCH_PROFILE_ARG_PREFIX));
	const named = flag !== undefined ? flag.slice(LAUNCH_PROFILE_ARG_PREFIX.length) : env[LAUNCH_PROFILE_ENV];
	if (named === undefined || named === "") return null;
	return VALID_PROFILE.test(named) ? named : null;
}

/** Whether a launcher may pass this name through to a launch. */
export function isValidLaunchProfile(name: string): boolean {
	return VALID_PROFILE.test(name);
}

/**
 * Where this launch keeps its Electron profile.
 *
 * The default profile keeps its literal path, so no existing install moves and
 * there is no migration to write or to get wrong. Named profiles nest under a
 * `profiles/` container so a listing of ~/.ao does not mix daemon state with a
 * variable number of Chromium profiles.
 *
 * The packaged/dev split is preserved inside the profile path for the reason it
 * exists at the top: a dev run and a packaged run of the same profile name are
 * still two Chromium instances, and they still must not share a profile.
 */
export function launchProfileUserDataPath(
	profile: string | null,
	opts: { home: string; packaged: boolean },
): string {
	const root = opts.packaged ? path.join(opts.home, ".ao") : path.join(opts.home, ".ao", "dev");
	return profile === null ? path.join(root, "electron") : path.join(root, "profiles", profile);
}

/**
 * What the window title and idle tray tooltip say.
 *
 * Four dock icons and four tray icons that render identically are not usable.
 * The profile names itself rather than the server it is attached to: the server
 * can change during a session (switching relaunches the app), the profile
 * cannot, and a title that changes under the operator is worse than one that is
 * slightly less specific. The address is already shown in the UI.
 *
 * The separator is the one the tray menu already uses for the same job of
 * qualifying a name with the thing it belongs to (tray.ts, session · project).
 */
export function launchProfileWindowTitle(profile: string | null): string {
	return profile === null ? DEFAULT_WINDOW_TITLE : `${DEFAULT_WINDOW_TITLE} · ${profile}`;
}
