/**
 * A daemon this client has been pointed at before.
 *
 * Shared by the main process (which persists it), the preload (which types the
 * bridge surface), and the renderer (which shows it), so the three cannot drift
 * apart.
 */
export type SavedServer = {
	/**
	 * Normalized origin — scheme, host, port, nothing else. It is also the
	 * identity: two entries never share one, and saving the same address twice
	 * updates the entry rather than adding a second.
	 *
	 * Using the address as the identity rather than minting an id means there is
	 * no way for the credential store and the server list to disagree about
	 * which server an entry is, which is the failure that would leave a password
	 * behind after the operator removed the server it belonged to.
	 */
	baseUrl: string;
	/** What the operator sees. Free text; they may rename a server. */
	label: string;
	/**
	 * ISO timestamp of the last successful connection, or null for a server that
	 * has never been reached. Ordering by it puts the server the operator
	 * actually uses at the top of the list.
	 */
	lastConnectedAt: string | null;
};

/** Whether an unknown value is shaped like a saved server. */
export function isSavedServer(value: unknown): value is SavedServer {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.baseUrl !== "string" || candidate.baseUrl === "") return false;
	if (typeof candidate.label !== "string") return false;
	return candidate.lastConnectedAt === null || typeof candidate.lastConnectedAt === "string";
}

/**
 * Most recently connected first, then never-connected, then by address so the
 * order is stable rather than dependent on insertion.
 */
export function sortSavedServers(servers: readonly SavedServer[]): SavedServer[] {
	return [...servers].sort((a, b) => {
		if (a.lastConnectedAt !== b.lastConnectedAt) {
			if (a.lastConnectedAt === null) return 1;
			if (b.lastConnectedAt === null) return -1;
			return a.lastConnectedAt < b.lastConnectedAt ? 1 : -1;
		}
		return a.baseUrl.localeCompare(b.baseUrl);
	});
}

/**
 * Turn what an operator types into an origin, or return null if it cannot be
 * one.
 *
 * People type `192.168.1.9:3010`, `my-box.tailnet.ts.net`, and
 * `http://my-box:3010/` — all of which mean the same thing and none of which
 * `new URL()` accepts on its own. The scheme is defaulted rather than demanded
 * because requiring it turns the most common input into an error message, and
 * plain http is the documented shape of this listener (TLS is the operator's to
 * put in front of it), so defaulting to https would break more addresses than
 * it protected.
 */
export function normalizeServerAddress(raw: string): string | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return null;
	}
	if (url.hostname === "") return null;
	// A path, a query, or a fragment is not part of an origin, and silently
	// keeping one would produce requests to `/app/api/v1/...`. Dropping them is
	// friendlier than rejecting the address, because the usual way one appears
	// is the operator pasting the URL out of a browser that is already on the
	// web client.
	return `${url.protocol}//${url.host}`;
}

/**
 * A human-facing label for a server address: the host, without the scheme or a
 * default port. It is what the operator recognizes at a glance, and it is never
 * used as an identifier — the base URL is.
 */
export function serverLabelFromAddress(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}

/**
 * Prefix of the process argument that tells a preload its launch is remote.
 *
 * The renderer has to know where its server is before the first query, and a
 * preload can only answer synchronously from something already in the process.
 * Electron's `additionalArguments` is that channel: the main process resolves
 * remote mode before the window exists, and the value is there in `argv` by the
 * time any script runs. An IPC round trip would arrive after the first render,
 * which is exactly when the answer is needed.
 */
export const REMOTE_SERVER_ARG_PREFIX = "--ao-remote-server=";

/**
 * The remote server this launch was pointed at, from process arguments.
 *
 * Returns null for a normal launch, and also for an argument carrying an
 * address that cannot be one — the main process only ever writes a normalized
 * address here, so anything else came from someone appending the flag by hand,
 * and starting locally is a better answer than sending every request to a
 * mangled origin.
 */
export function remoteServerFromArgv(argv: readonly string[]): string | null {
	const arg = argv.find((value) => value.startsWith(REMOTE_SERVER_ARG_PREFIX));
	if (arg === undefined) return null;
	return normalizeServerAddress(arg.slice(REMOTE_SERVER_ARG_PREFIX.length));
}

/**
 * What the host reports back after being told which server the next launch
 * should attach to.
 *
 * The two extra fields exist because writing the setting is not always the
 * whole answer. Remote mode is resolved once per launch and every daemon path
 * branches on it, so the process cannot change its mind — and the one change
 * that cannot wait is a remote client choosing this computer, because this
 * process will not start a daemon no matter what the file says. The host
 * relaunches for that case and says so here. `overriddenByEnv` is the opposite
 * problem: the setting was written and the next launch will ignore it, because
 * `AO_REMOTE_SERVER` is in the environment and an override that could be edited
 * away from the UI would not be one.
 */
export type RemoteModeChange = {
	/** The address now recorded, or null when the next launch runs its own daemon. */
	server: string | null;
	/** The host is restarting to apply this; the window is about to go away. */
	relaunching: boolean;
	/** An environment variable will decide the next launch regardless of this. */
	overriddenByEnv: boolean;
};
