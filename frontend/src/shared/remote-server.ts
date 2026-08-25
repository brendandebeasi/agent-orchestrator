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
