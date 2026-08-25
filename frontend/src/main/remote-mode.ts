/**
 * Whether this desktop client runs its own daemon or attaches to one elsewhere.
 *
 * Every other part of the app treats "the daemon" as something this process
 * starts, supervises, and stops. That is right for the normal install and wrong
 * for a client pointed at a machine down the hall: there is no local process to
 * start, nothing to supervise, and — most importantly — nothing this client is
 * entitled to shut down when its window closes. Someone else's sessions are
 * running on that daemon.
 *
 * So remote mode is resolved once, before anything is spawned, and read from
 * there. It is deliberately a startup decision rather than something that can
 * flip mid-run: the daemon lifecycle branches on it in half a dozen places, and
 * a client that had already spawned a local daemon and then decided it was
 * remote would have to unwind all of them. Changing the setting takes effect on
 * the next launch, which is also when the operator expects it to.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeServerAddress } from "../shared/remote-server";

/** File holding the server this client attaches to, under the ~/.ao state dir. */
export const REMOTE_MODE_FILE_NAME = "remote-mode.json";

/**
 * A resolved decision to attach to a server rather than run one.
 *
 * `source` is carried because it changes what the operator can do about it: a
 * setting is theirs to change from the UI, an environment variable is not, and
 * telling them to click something that will be overridden on the next launch
 * would be worse than saying nothing.
 */
export type RemoteMode = {
	baseUrl: string;
	source: "env" | "setting";
};

/** The environment variable that forces remote mode for one launch. */
export const REMOTE_SERVER_ENV = "AO_REMOTE_SERVER";

/**
 * Decide whether this launch is remote, from the environment and the setting.
 *
 * The environment wins because that is what an override is for: a developer
 * running against a colleague's daemon, or an operator recovering a client that
 * has been left pointed at a machine that no longer exists. Setting the
 * variable to an empty string is how they force local mode for one launch
 * without editing the setting — it is present, so it wins, and it names no
 * server, so there is nothing to attach to.
 *
 * An address that cannot be parsed is treated as no address at all. There is no
 * useful failure mode here: refusing to start would strand a client over a typo
 * in a file the operator may not know exists, and starting with a mangled
 * address would produce connection errors that point at the network instead of
 * at the setting. Falling back to the local daemon leaves a working app, and
 * the address the client is using is shown in the UI.
 */
export function resolveRemoteServer(env: NodeJS.ProcessEnv, persisted: string | null): RemoteMode | null {
	const override = env[REMOTE_SERVER_ENV];
	if (override !== undefined) {
		const baseUrl = normalizeServerAddress(override);
		return baseUrl === null ? null : { baseUrl, source: "env" };
	}
	if (persisted === null) return null;
	const baseUrl = normalizeServerAddress(persisted);
	return baseUrl === null ? null : { baseUrl, source: "setting" };
}

function settingPath(stateDir: string): string {
	return path.join(stateDir, REMOTE_MODE_FILE_NAME);
}

/**
 * The persisted server address, or null when this client runs its own daemon.
 *
 * Every failure reads as "no setting". A missing file is the normal case for
 * every install that has never connected to anything; a file that no longer
 * parses is one an operator hand-edited, and the local daemon is the safe place
 * to land.
 */
export async function readRemoteModeSetting(stateDir: string): Promise<string | null> {
	let raw: string;
	try {
		raw = await readFile(settingPath(stateDir), "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const server = (parsed as { server?: unknown }).server;
		return typeof server === "string" && server !== "" ? server : null;
	} catch {
		return null;
	}
}

/**
 * Record which server the next launch attaches to, or clear it.
 *
 * Written through a temp file and a rename so a client that dies mid-write
 * comes back to the old setting rather than to a truncated file — which would
 * read as local mode and quietly start a daemon the operator did not ask for.
 */
export async function writeRemoteModeSetting(stateDir: string, baseUrl: string | null): Promise<string | null> {
	const file = settingPath(stateDir);
	if (baseUrl === null) {
		// Removing the file rather than writing `{"server": null}` keeps "no
		// setting" a single state on disk, so a fresh install and a client that
		// disconnected are not two cases to reason about.
		await rm(file, { force: true });
		return null;
	}
	const normalized = normalizeServerAddress(baseUrl);
	if (normalized === null) return await readRemoteModeSetting(stateDir);
	await mkdir(stateDir, { recursive: true, mode: 0o750 });
	const tmp = path.join(stateDir, `.remote-mode-${process.pid}-${Date.now()}.json`);
	await writeFile(tmp, `${JSON.stringify({ server: normalized }, null, 2)}\n`, { mode: 0o600 });
	await rename(tmp, file);
	return normalized;
}
