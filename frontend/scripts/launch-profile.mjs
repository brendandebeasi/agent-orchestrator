// Start a client under a named profile, against an optional server.
//
//   node scripts/launch-profile.mjs vm2
//   node scripts/launch-profile.mjs vm2 https://box.tailnet.ts.net
//
// Each profile is an independent client: its own Electron profile, its own
// single-instance lock, its own recorded server. Run this once per machine you
// want a control plane for. The saved-server list and its credentials are
// shared, so a server you have already connected to once needs no password
// here.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	invalidProfileMessage,
	isValidLaunchProfile,
	knownAppLocations,
	launchCommand,
} from "./launch-profile-helpers.mjs";

const [profile, server] = process.argv.slice(2);

if (!profile) {
	console.error("Usage: node scripts/launch-profile.mjs <profile> [server]");
	process.exit(2);
}

if (!isValidLaunchProfile(profile)) {
	console.error(invalidProfileMessage(profile));
	process.exit(2);
}

/**
 * The app the desktop client last recorded, if it has ever launched here.
 *
 * `ao start` reads the same marker as a hint and stats the path before trusting
 * it, because an app can be recorded and then moved or deleted. Same rule here.
 */
function markerAppPath() {
	// AO_DATA_DIR is honored the way the daemon's config does, so a developer
	// running against an isolated state dir finds the app that dir recorded.
	const stateDir = process.env.AO_DATA_DIR || join(homedir(), ".ao");
	try {
		const marker = JSON.parse(readFileSync(join(stateDir, "app-state.json"), "utf8"));
		return typeof marker.appPath === "string" ? marker.appPath : "";
	} catch {
		return "";
	}
}

function resolveAppPath() {
	const recorded = markerAppPath();
	if (recorded && existsSync(recorded)) return recorded;
	const scanned = knownAppLocations({
		platform: process.platform,
		home: homedir(),
		programFiles: process.env.ProgramFiles,
	});
	return scanned.find((candidate) => existsSync(candidate)) ?? "";
}

const appPath = resolveAppPath();
if (!appPath) {
	console.error(
		"Could not find an installed Agent Orchestrator.\n" +
			"Launch the app once so it records itself, or install it to one of the standard locations.",
	);
	process.exit(1);
}

const { command, args } = launchCommand({ platform: process.platform, appPath, profile, server });

console.log(`Launching profile ${profile}${server ? ` against ${server}` : ""}`);

// Detached, because this script is a launcher and not a supervisor: the client
// outlives the shell that started it, the same way double-clicking the app
// does. `open` returns immediately on macOS regardless; detaching is what makes
// the direct-exec platforms behave the same way.
const child = spawn(command, args, { detached: true, stdio: "ignore" });
child.on("error", (err) => {
	console.error(`Could not launch ${command}: ${err.message}`);
	process.exit(1);
});
child.unref();
