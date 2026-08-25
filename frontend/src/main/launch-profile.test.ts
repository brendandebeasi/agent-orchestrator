import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	isValidLaunchProfile,
	LAUNCH_PROFILE_ARG_PREFIX,
	LAUNCH_PROFILE_ENV,
	launchProfileUserDataPath,
	launchProfileWindowTitle,
	resolveLaunchProfile,
} from "./launch-profile";

/** argv as a packaged app sees it: the executable, then the app's own flags. */
function packagedArgv(...flags: string[]): string[] {
	return ["/Applications/Agent Orchestrator.app/Contents/MacOS/Agent Orchestrator", ...flags];
}

/** argv as a dev run sees it: the electron binary, the app path, then flags. */
function devArgv(...flags: string[]): string[] {
	return ["/repo/frontend/node_modules/electron/dist/electron", "/repo/frontend", ...flags];
}

describe("resolving the launch profile", () => {
	it("runs on the default profile when nothing names one", () => {
		expect(resolveLaunchProfile(packagedArgv(), {})).toBeNull();
	});

	it("takes the profile named in argv", () => {
		expect(resolveLaunchProfile(packagedArgv(`${LAUNCH_PROFILE_ARG_PREFIX}vm2`), {})).toBe("vm2");
	});

	it("takes the profile named in the environment", () => {
		expect(resolveLaunchProfile(packagedArgv(), { [LAUNCH_PROFILE_ENV]: "vm2" })).toBe("vm2");
	});

	// argv has to win: on macOS a second copy of a packaged app starts through
	// `open -n -a <app> --args ...`, which carries no environment.
	it("prefers argv over the environment", () => {
		expect(
			resolveLaunchProfile(packagedArgv(`${LAUNCH_PROFILE_ARG_PREFIX}vm2`), { [LAUNCH_PROFILE_ENV]: "vm3" }),
		).toBe("vm2");
	});

	it("reads the same flag from a dev launch, where Electron's app path sits in argv", () => {
		expect(resolveLaunchProfile(devArgv(`${LAUNCH_PROFILE_ARG_PREFIX}vm2`), {})).toBe("vm2");
	});

	it.each([
		["an empty flag value", packagedArgv(`${LAUNCH_PROFILE_ARG_PREFIX}`), {}],
		["an empty environment value", packagedArgv(), { [LAUNCH_PROFILE_ENV]: "" }],
	])("treats %s as the default profile", (_label, argv, env) => {
		expect(resolveLaunchProfile(argv, env)).toBeNull();
	});

	// An empty flag beats a populated environment variable, the same way
	// AO_REMOTE_SERVER= forces local mode over a saved server: it is present, so
	// it wins, and it names nothing, so there is nothing to resolve.
	it("lets an empty flag override a named environment profile", () => {
		expect(resolveLaunchProfile(packagedArgv(`${LAUNCH_PROFILE_ARG_PREFIX}`), { [LAUNCH_PROFILE_ENV]: "vm3" })).toBeNull();
	});

	it("ignores a flag that only looks like the profile flag", () => {
		expect(resolveLaunchProfile(packagedArgv("--ao-profile", "vm2"), {})).toBeNull();
	});
});

describe("validating a profile name", () => {
	it.each(["vm2", "vm-2", "vm_2", "vm.2", "a", "0", "a".repeat(32)])("accepts %s", (name) => {
		expect(resolveLaunchProfile(packagedArgv(`${LAUNCH_PROFILE_ARG_PREFIX}${name}`), {})).toBe(name);
		expect(isValidLaunchProfile(name)).toBe(true);
	});

	// The name becomes a directory component. Every one of these would either
	// escape ~/.ao/profiles or collide with another name on a case-insensitive
	// volume, and a collision is two Chromium instances in one profile.
	it.each([
		["parent traversal", "../evil"],
		["a bare parent", ".."],
		["a bare dot", "."],
		["an absolute path", "/abs"],
		["a nested path", "a/b"],
		["a Windows path", "a\\b"],
		["uppercase", "VM2"],
		["a leading dot", ".hidden"],
		["a leading dash", "-vm2"],
		["a space", "vm 2"],
		["a name over the length limit", "a".repeat(33)],
		["a null byte", "vm2\0"],
	])("falls back to the default profile on %s", (_label, name) => {
		expect(resolveLaunchProfile(packagedArgv(`${LAUNCH_PROFILE_ARG_PREFIX}${name}`), {})).toBeNull();
		expect(resolveLaunchProfile(packagedArgv(), { [LAUNCH_PROFILE_ENV]: name })).toBeNull();
		expect(isValidLaunchProfile(name)).toBe(false);
	});
});

describe("where a launch keeps its Electron profile", () => {
	// The default paths are asserted as literals rather than composed, because
	// the point of the default branch is that it is byte-identical to what
	// main.ts wrote before profiles existed. Composing them here would let both
	// sides drift together and still pass.
	it("leaves a packaged default launch where it was", () => {
		expect(launchProfileUserDataPath(null, { home: "/Users/b", packaged: true })).toBe("/Users/b/.ao/electron");
	});

	it("leaves a dev default launch where it was", () => {
		expect(launchProfileUserDataPath(null, { home: "/Users/b", packaged: false })).toBe("/Users/b/.ao/dev/electron");
	});

	it("nests a packaged named profile under the same root", () => {
		expect(launchProfileUserDataPath("vm2", { home: "/Users/b", packaged: true })).toBe("/Users/b/.ao/profiles/vm2");
	});

	// A dev run and a packaged run of one profile name are still two Chromium
	// instances, so the split that keeps them apart has to survive inside the
	// profile path too.
	it("keeps dev and packaged apart within a named profile", () => {
		expect(launchProfileUserDataPath("vm2", { home: "/Users/b", packaged: false })).toBe(
			"/Users/b/.ao/dev/profiles/vm2",
		);
	});

	it("gives two profiles two directories", () => {
		const opts = { home: "/Users/b", packaged: true };
		expect(launchProfileUserDataPath("vm2", opts)).not.toBe(launchProfileUserDataPath("vm3", opts));
	});
});

describe("labelling a window", () => {
	it("shows the unchanged title on the default profile", () => {
		expect(launchProfileWindowTitle(null)).toBe("Agent Orchestrator");
	});

	it("names the profile when there is one", () => {
		expect(launchProfileWindowTitle("vm2")).toBe("Agent Orchestrator · vm2");
	});
});

/**
 * The wiring, read as source.
 *
 * `src/main.ts` imports Electron at module scope and wires the whole
 * application on the way past, so it cannot be loaded in a unit test -- the same
 * constraint `remote-mode.test.ts` records. These cases assert that main.ts
 * hands the profile decision to this module rather than keeping a second copy
 * of it, which is the failure that would otherwise be silent: a userData path
 * that no longer follows the profile leaves every launch sharing one Chromium
 * profile again.
 */
describe("the wiring in main.ts", () => {
	const MAIN_SOURCE = readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");

	it("pins userData through the helper", () => {
		expect(MAIN_SOURCE).toMatch(/app\.setPath\(\s*"userData",\s*launchProfileUserDataPath\(/);
	});

	// The literal main.ts used to build. If it comes back, something is
	// resolving a profile and then ignoring it.
	it("no longer builds the default userData path inline", () => {
		expect(MAIN_SOURCE).not.toContain('path.join(os.homedir(), ".ao", "electron")');
		expect(MAIN_SOURCE).not.toContain('path.join(os.homedir(), ".ao", "dev", "electron")');
	});

	// One resolution, read everywhere. Two would let the title, the tray, and
	// the directory that was actually pinned disagree.
	it("resolves the profile exactly once", () => {
		expect(MAIN_SOURCE.match(/resolveLaunchProfile\(/g)).toHaveLength(1);
	});

	it("titles the window through the helper", () => {
		expect(MAIN_SOURCE).toMatch(/title: launchProfileWindowTitle\(/);
		expect(MAIN_SOURCE).not.toMatch(/title: "Agent Orchestrator"/);
	});
});
