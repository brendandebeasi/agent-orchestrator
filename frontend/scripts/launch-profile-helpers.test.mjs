import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	invalidProfileMessage,
	isValidLaunchProfile,
	knownAppLocations,
	launchCommand,
	LAUNCH_PROFILE_PATTERN,
} from "./launch-profile-helpers.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

describe("composing the launch", () => {
	// `open -n` is what asks macOS for a genuinely new process rather than
	// activating the running one, and `--args` is the only channel that reaches
	// it, since LaunchServices carries no environment.
	it("goes through open -n --args on macOS", () => {
		expect(
			launchCommand({ platform: "darwin", appPath: "/Applications/Agent Orchestrator.app", profile: "vm2" }),
		).toEqual({
			command: "open",
			args: ["-n", "-a", "/Applications/Agent Orchestrator.app", "--args", "--ao-profile=vm2"],
		});
	});

	it("runs the executable directly elsewhere", () => {
		expect(launchCommand({ platform: "linux", appPath: "/opt/ao/agent-orchestrator", profile: "vm2" })).toEqual({
			command: "/opt/ao/agent-orchestrator",
			args: ["--ao-profile=vm2"],
		});
	});

	it("passes a server through when one is named", () => {
		const { args } = launchCommand({
			platform: "darwin",
			appPath: "/Applications/Agent Orchestrator.app",
			profile: "vm2",
			server: "https://box.tailnet.ts.net",
		});
		expect(args).toContain("--ao-server=https://box.tailnet.ts.net");
	});

	// Absent and empty are different answers: absent leaves the profile's
	// recorded server in charge, empty forces local mode for the launch.
	it.each([undefined, null, ""])("omits the server flag entirely for %p", (server) => {
		const { args } = launchCommand({
			platform: "darwin",
			appPath: "/Applications/Agent Orchestrator.app",
			profile: "vm2",
			server,
		});
		expect(args.some((arg) => arg.startsWith("--ao-server="))).toBe(false);
	});

	it("keeps the app flags after --args, where the new instance can see them", () => {
		const { args } = launchCommand({
			platform: "darwin",
			appPath: "/Applications/Agent Orchestrator.app",
			profile: "vm2",
			server: "https://box",
		});
		const separator = args.indexOf("--args");
		expect(separator).toBeGreaterThan(-1);
		expect(args.slice(separator + 1)).toEqual(["--ao-profile=vm2", "--ao-server=https://box"]);
	});
});

describe("refusing a name the app could not use", () => {
	it.each(["vm2", "vm-2", "vm_2", "vm.2", "a", "0"])("accepts %s", (name) => {
		expect(isValidLaunchProfile(name)).toBe(true);
	});

	it.each(["../evil", "..", ".", "/abs", "a/b", "VM2", "-vm2", "vm 2", "", "a".repeat(33)])(
		"refuses %p",
		(name) => {
			expect(isValidLaunchProfile(name)).toBe(false);
		},
	);

	it("states the rule rather than just refusing", () => {
		const message = invalidProfileMessage("VM2");
		expect(message).toContain("VM2");
		expect(message).toContain("lowercase");
		expect(message).toContain("32");
	});

	/**
	 * The one duplication in this file, checked rather than trusted.
	 *
	 * A `.mjs` script cannot import the app's TypeScript, so the pattern exists
	 * twice. If they drift, the launcher accepts a name the app then silently
	 * downgrades to the default profile -- two clients on one daemon, and
	 * nothing anywhere saying why.
	 */
	it("uses the same pattern the app validates against", () => {
		const source = readFileSync(resolve(scriptsDir, "../src/main/launch-profile.ts"), "utf8");
		const match = source.match(/const VALID_PROFILE = (\/.*\/);/);
		expect(match, "VALID_PROFILE not found in launch-profile.ts").not.toBeNull();
		expect(match[1]).toBe(LAUNCH_PROFILE_PATTERN.toString());
	});
});

describe("finding the app when the marker does not say", () => {
	it("scans both macOS install locations", () => {
		expect(knownAppLocations({ platform: "darwin", home: "/Users/b" })).toEqual([
			"/Applications/Agent Orchestrator.app",
			"/Users/b/Applications/Agent Orchestrator.app",
		]);
	});

	it("returns nothing to scan on Windows without a Program Files to scan", () => {
		expect(knownAppLocations({ platform: "win32", home: "C:\\Users\\b" })).toEqual([]);
	});

	it("scans Linux install locations", () => {
		expect(knownAppLocations({ platform: "linux", home: "/home/b" })).toEqual([
			"/opt/Agent Orchestrator/agent-orchestrator",
			"/home/b/.local/bin/agent-orchestrator",
		]);
	});
});
