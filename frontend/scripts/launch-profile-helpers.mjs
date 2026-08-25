// Launching a second client, composed rather than typed by hand.
//
// On macOS a second copy of an already-running app does not start by running
// its executable: LaunchServices sees a running instance and activates that one
// instead. `open -n` is what asks for a genuinely new process, and `--args`
// after it is the only channel that reaches the new instance -- LaunchServices
// passes argv but not the calling shell's environment, which is why the flags
// exist in argv form at all.
//
// The pure part lives here, so the argv this composes can be asserted on every
// platform from one machine. The same split as build-web-client-helpers.mjs.

/**
 * Names a profile may take.
 *
 * Duplicated from `src/main/launch-profile.ts` because a `.mjs` build script
 * cannot import the app's TypeScript. `launch-profile-helpers.test.mjs` reads
 * that file and asserts the two are the same pattern, so the duplication is
 * checked rather than trusted.
 */
export const LAUNCH_PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** The macOS application bundle, as `ao start` names it. */
export const APP_BUNDLE_NAME = "Agent Orchestrator.app";

/**
 * Whether the launcher will pass this name through.
 *
 * The app itself falls back to the default profile on a name it cannot use,
 * because it is already starting and refusing would strand the operator over a
 * typo. A launcher has not started anything yet and can still say no, which is
 * the better answer: silently opening a default-profile window is how someone
 * ends up with two clients on one daemon and no idea why.
 */
export function isValidLaunchProfile(name) {
	return typeof name === "string" && LAUNCH_PROFILE_PATTERN.test(name);
}

/**
 * The command and argv that start a new client under `profile`.
 *
 * `appPath` is a `.app` bundle on darwin and an executable everywhere else,
 * which is the same distinction `ao start` draws when it opens the app.
 */
export function launchCommand({ platform, appPath, profile, server }) {
	const appFlags = [`--ao-profile=${profile}`];
	// An absent server is not the same as an empty one: absent leaves the
	// profile's recorded server in charge, and `--ao-server=` with no value
	// forces local mode for the launch. Only pass the flag when there is
	// something to say.
	if (server) appFlags.push(`--ao-server=${server}`);

	if (platform === "darwin") {
		return { command: "open", args: ["-n", "-a", appPath, "--args", ...appFlags] };
	}
	return { command: appPath, args: appFlags };
}

/**
 * Where to look for the app when `~/.ao/app-state.json` does not say.
 *
 * The marker is written by the desktop app on every launch, so it is missing on
 * a machine where the app has never run -- including one where the operator
 * installed it a minute ago and is launching it for the first time through this
 * script. Scanning the platform's standard install paths is what `ao start`
 * does for the same miss.
 */
export function knownAppLocations({ platform, home, programFiles }) {
	switch (platform) {
		case "darwin":
			return [`/Applications/${APP_BUNDLE_NAME}`, `${home}/Applications/${APP_BUNDLE_NAME}`];
		case "win32":
			return programFiles ? [`${programFiles}\\Agent Orchestrator\\Agent Orchestrator.exe`] : [];
		default:
			return ["/opt/Agent Orchestrator/agent-orchestrator", `${home}/.local/bin/agent-orchestrator`];
	}
}

/**
 * What the operator is told when a name is refused.
 *
 * Stating the rule rather than "invalid profile" -- the name is theirs to fix,
 * and the constraint is not guessable from the rejection alone.
 */
export function invalidProfileMessage(name) {
	return (
		`Not a usable profile name: ${JSON.stringify(name)}\n` +
		"Profile names are lowercase letters, digits, dot, dash, and underscore, " +
		"start with a letter or digit, and are at most 32 characters."
	);
}
