import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	REMOTE_MODE_FILE_NAME,
	readRemoteModeSetting,
	resolveRemoteServer,
	writeRemoteModeSetting,
} from "./remote-mode";

let stateDir: string;

beforeEach(async () => {
	stateDir = await mkdtemp(path.join(tmpdir(), "ao-remote-mode-"));
});

afterEach(async () => {
	await rm(stateDir, { recursive: true, force: true });
});

describe("deciding whether a launch is remote", () => {
	it("runs a local daemon when nothing says otherwise", () => {
		expect(resolveRemoteServer({}, null)).toBeNull();
	});

	it("attaches to the server the operator saved", () => {
		expect(resolveRemoteServer({}, "http://box:3010")).toEqual({
			baseUrl: "http://box:3010",
			source: "setting",
		});
	});

	it("lets the environment override the setting", () => {
		expect(resolveRemoteServer({ AO_REMOTE_SERVER: "http://other:3010" }, "http://box:3010")).toEqual({
			baseUrl: "http://other:3010",
			source: "env",
		});
	});

	it("takes an empty override as a way to force local mode for one launch", () => {
		// The variable is present, so it wins; it names no server, so there is
		// nothing to attach to. That is the escape hatch for a client left
		// pointed at a machine that no longer exists.
		expect(resolveRemoteServer({ AO_REMOTE_SERVER: "" }, "http://box:3010")).toBeNull();
	});

	it("accepts an address typed the way people type one", () => {
		expect(resolveRemoteServer({ AO_REMOTE_SERVER: "box:3010" }, null)?.baseUrl).toBe("http://box:3010");
	});

	it("falls back to the local daemon rather than starting with a mangled address", () => {
		// Refusing to start would strand the client over a typo in a file the
		// operator may not know exists.
		expect(resolveRemoteServer({}, "::::")).toBeNull();
		expect(resolveRemoteServer({ AO_REMOTE_SERVER: "::::" }, "http://box:3010")).toBeNull();
	});
});

describe("the persisted setting", () => {
	it("reads as absent on an install that has never connected anywhere", async () => {
		await expect(readRemoteModeSetting(stateDir)).resolves.toBeNull();
	});

	it("survives a write and a read", async () => {
		await writeRemoteModeSetting(stateDir, "http://box:3010");

		await expect(readRemoteModeSetting(stateDir)).resolves.toBe("http://box:3010");
	});

	it("normalizes on the way in, so the next launch matches a saved server", async () => {
		await writeRemoteModeSetting(stateDir, "  BOX:3010/app  ");

		await expect(readRemoteModeSetting(stateDir)).resolves.toBe("http://box:3010");
	});

	it("clears by removing the file, leaving one shape for having no setting", async () => {
		await writeRemoteModeSetting(stateDir, "http://box:3010");

		await writeRemoteModeSetting(stateDir, null);

		await expect(readRemoteModeSetting(stateDir)).resolves.toBeNull();
		await expect(readFile(path.join(stateDir, REMOTE_MODE_FILE_NAME), "utf8")).rejects.toThrow();
	});

	it("is a no-op to clear a setting that was never written", async () => {
		await expect(writeRemoteModeSetting(stateDir, null)).resolves.toBeNull();
	});

	it("keeps the old setting when handed an address that cannot be one", async () => {
		await writeRemoteModeSetting(stateDir, "http://box:3010");

		await expect(writeRemoteModeSetting(stateDir, "::::")).resolves.toBe("http://box:3010");
		await expect(readRemoteModeSetting(stateDir)).resolves.toBe("http://box:3010");
	});

	it("reads a hand-edited file that no longer parses as no setting", async () => {
		await writeFile(path.join(stateDir, REMOTE_MODE_FILE_NAME), "{ server: ");

		await expect(readRemoteModeSetting(stateDir)).resolves.toBeNull();
	});

	it("ignores a file whose server is not an address", async () => {
		await writeFile(path.join(stateDir, REMOTE_MODE_FILE_NAME), JSON.stringify({ server: 3010 }));

		await expect(readRemoteModeSetting(stateDir)).resolves.toBeNull();
	});
});

/**
 * The guards that make remote mode real.
 *
 * `src/main.ts` imports Electron at module scope and wires the whole
 * application on the way past, so it cannot be loaded in a unit test — which
 * leaves the one decision that matters most about remote mode unreachable by
 * the usual means: whether the daemon lifecycle actually declines to run. These
 * cases read the source and assert the guard is present at each branch point.
 *
 * That is a narrower claim than "the paths do not run", and worth stating
 * plainly. It does not prove the guard works; `resolveRemoteServer` above and
 * the shape of the guard do that. What it catches is the failure that would
 * otherwise be silent: someone refactoring one of these functions and dropping
 * the early return, which turns every remote client back into one that spawns a
 * daemon and kills it on quit — on a machine that may be someone else's.
 */
describe("the daemon lifecycle in main.ts", () => {
	const MAIN_SOURCE = readFileSync(path.resolve(process.cwd(), "src/main.ts"), "utf8");

	/**
	 * The text of one top-level function, from its declaration to the closing
	 * brace in the first column. Every function named here is declared at the
	 * top level of `main.ts`, which is what makes this reliable enough to
	 * assert on.
	 */
	function bodyOf(name: string): string {
		const start = MAIN_SOURCE.search(new RegExp(String.raw`^(?:async )?function ${name}\(`, "m"));
		expect(start, `main.ts has no top-level function named ${name}`).toBeGreaterThan(-1);
		const end = MAIN_SOURCE.indexOf("\n}\n", start);
		expect(end, `could not find the end of ${name}`).toBeGreaterThan(-1);
		return MAIN_SOURCE.slice(start, end);
	}

	// Discovery, the bundled-binary identity check, spawning, attaching, and
	// `shouldLinkOnAttach` supervisor linking are all downstream of
	// `startDaemonInner`, which only `startDaemon` calls. Guarding the entry
	// point declines all of them at once rather than in six places that could
	// drift apart.
	const GUARDED = [
		"startDaemon",
		"refreshDaemonStatus",
		"stopDaemon",
		"establishBrowserRuntimeLink",
		"establishSupervisorLink",
	];

	it.each(GUARDED)("declines to touch a local daemon from %s", (name) => {
		expect(bodyOf(name)).toMatch(/^\tif \(remoteMode\) return[^;]*;$/m);
	});

	it.each(GUARDED)("changes nothing about %s for a launch that runs its own daemon", (name) => {
		// The guard is the function's only mention of the setting, so with it
		// unset there is no branch left to take: control falls through to the
		// code that shipped before remote mode existed.
		const mentions = bodyOf(name).match(/remoteMode/g) ?? [];
		expect(mentions).toHaveLength(1);
	});

	it("does not kill a daemon on quit that it did not start", () => {
		// The last-resort orphan cleanup. `daemonProcess` is always null in
		// remote mode so this could be left implicit, but this is the line that
		// decides whether quitting takes a daemon with it, and the answer for a
		// shared machine belongs where it is decided.
		const handler = MAIN_SOURCE.slice(MAIN_SOURCE.indexOf('\nprocess.on("exit"'));
		expect(handler.slice(0, handler.indexOf("\n});"))).toMatch(/^\tif \(remoteMode\) return;$/m);
	});

	it("tells the preload where the server is through the window's launch arguments", () => {
		// The renderer needs the address before its first query, and IPC cannot
		// answer that early. This is the only channel that can.
		expect(bodyOf("createWindowInternal")).toMatch(
			/additionalArguments: remoteMode \? \[`\$\{REMOTE_SERVER_ARG_PREFIX\}\$\{remoteMode\.baseUrl\}`\] : \[\]/,
		);
	});
});
