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
 * Which file a profile records its server in.
 *
 * The server a client is attached to is the one thing that must differ between
 * concurrent clients, and it must persist: an operator who set up a client per
 * machine should not re-enter four addresses on every launch.
 *
 * The state directory itself is shared — it is derived from the run file, not
 * from userData — so the split is per file and deliberate. remote-servers.json
 * and remote-credentials.bin stay shared, because they are the operator's
 * address book: splitting them would mean entering the same addresses and the
 * same passwords once per profile, and would multiply the places a credential
 * is stored. What a client *is* differs per profile; what the operator *knows*
 * does not.
 *
 * The default profile keeps the exact existing filename, so an install that
 * predates profiles still finds its setting. A per-profile name rather than a
 * per-profile directory also keeps writeRemoteModeSetting's temp-file-and-
 * rename within one directory, which is what makes the rename atomic.
 */
export function remoteModeFileName(profile: string | null): string {
	return profile === null ? REMOTE_MODE_FILE_NAME : `remote-mode.${profile}.json`;
}

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
 * The argv flag that forces remote mode for one launch.
 *
 * The same override as REMOTE_SERVER_ENV, in the one place a packaged macOS app
 * can still be reached: a second copy starts through `open -n -a <app> --args`,
 * and LaunchServices passes argv but not the calling shell's environment. An
 * operator launching a client per machine names the server the same way they
 * name the profile, or they could name neither.
 */
export const REMOTE_SERVER_ARG_PREFIX = "--ao-server=";

/**
 * Decide whether this launch is remote, from argv, the environment, and the
 * setting, in that order of precedence.
 *
 * An override wins because that is what an override is for: a developer running
 * against a colleague's daemon, or an operator recovering a client that has
 * been left pointed at a machine that no longer exists. Setting either override
 * to an empty string is how they force local mode for one launch without
 * editing the setting — it is present, so it wins, and it names no server, so
 * there is nothing to attach to.
 *
 * argv sits above the environment for the reason REMOTE_SERVER_ARG_PREFIX
 * records: it is the only one of the two that survives `open -n -a`. Both
 * report `source: "env"`, because what that field decides is whether the UI
 * offers the operator a setting to change, and a launch flag is no more theirs
 * to change from inside a running window than a variable is. Splitting it into
 * a third source would mean a third branch everywhere it is read, to say the
 * same thing.
 *
 * An address that cannot be parsed is treated as no address at all. There is no
 * useful failure mode here: refusing to start would strand a client over a typo
 * in a file the operator may not know exists, and starting with a mangled
 * address would produce connection errors that point at the network instead of
 * at the setting. Falling back to the local daemon leaves a working app, and
 * the address the client is using is shown in the UI.
 */
export function resolveRemoteServer(
	argv: string[],
	env: NodeJS.ProcessEnv,
	persisted: string | null,
): RemoteMode | null {
	const flag = argv.find((entry) => entry.startsWith(REMOTE_SERVER_ARG_PREFIX));
	const override = flag !== undefined ? flag.slice(REMOTE_SERVER_ARG_PREFIX.length) : env[REMOTE_SERVER_ENV];
	if (override !== undefined) {
		const baseUrl = normalizeServerAddress(override);
		return baseUrl === null ? null : { baseUrl, source: "env" };
	}
	if (persisted === null) return null;
	const baseUrl = normalizeServerAddress(persisted);
	return baseUrl === null ? null : { baseUrl, source: "setting" };
}

/**
 * Distinguishes one in-flight write from another within this process.
 *
 * The temp file has to live in the same directory as its target for the rename
 * to be atomic, so every profile writes into one directory. The name used to
 * carry the pid and a millisecond timestamp, which is unique enough for one
 * window clicking Save and not for two profiles saving at once: two writes in
 * the same millisecond from the same process built the same path, and the
 * second rename found nothing there to rename. A counter cannot tie.
 */
let writeSequence = 0;

function settingPath(stateDir: string, profile: string | null): string {
	return path.join(stateDir, remoteModeFileName(profile));
}

/**
 * The persisted server address, or null when this client runs its own daemon.
 *
 * Every failure reads as "no setting". A missing file is the normal case for
 * every install that has never connected to anything; a file that no longer
 * parses is one an operator hand-edited, and the local daemon is the safe place
 * to land.
 */
export async function readRemoteModeSetting(stateDir: string, profile: string | null = null): Promise<string | null> {
	let raw: string;
	try {
		raw = await readFile(settingPath(stateDir, profile), "utf8");
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
export async function writeRemoteModeSetting(
	stateDir: string,
	baseUrl: string | null,
	profile: string | null = null,
): Promise<string | null> {
	const file = settingPath(stateDir, profile);
	if (baseUrl === null) {
		// Removing the file rather than writing `{"server": null}` keeps "no
		// setting" a single state on disk, so a fresh install and a client that
		// disconnected are not two cases to reason about.
		await rm(file, { force: true });
		return null;
	}
	const normalized = normalizeServerAddress(baseUrl);
	if (normalized === null) return await readRemoteModeSetting(stateDir, profile);
	await mkdir(stateDir, { recursive: true, mode: 0o750 });
	const tmp = path.join(stateDir, `.${remoteModeFileName(profile)}.${process.pid}-${(writeSequence += 1)}.tmp`);
	await writeFile(tmp, `${JSON.stringify({ server: normalized }, null, 2)}\n`, { mode: 0o600 });
	await rename(tmp, file);
	return normalized;
}
