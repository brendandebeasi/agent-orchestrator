/**
 * Whether this client and the server it reached were built from the same
 * release, and what to say when they were not.
 *
 * A local install cannot get this wrong: the app ships the daemon it spawns, so
 * the pair always matches. Over the network the two halves are separately
 * installed and separately updated, and they will drift — the operator updates
 * the desktop app on their laptop and not the server in the closet, or the
 * reverse.
 *
 * The client reports the drift and keeps working. It does not block, because
 * the versions differing is not the same as the protocol being incompatible,
 * and refusing to connect would strand an operator whose only way to fix the
 * server is the client they are being refused. It also does not offer to
 * update anything: the remote binary is not this client's to replace.
 */

/** The comparison's verdict. */
export type VersionCompat =
	/** Both versions are known and equal. */
	| { status: "match"; client: string; server: string }
	/** Both versions are known and are not equal. */
	| { status: "mismatch"; client: string; server: string }
	/**
	 * At least one side did not say. A daemon started without a supervising app
	 * reports no version at all, so this is an ordinary state and not a
	 * degraded one — the client simply has nothing to compare and says nothing.
	 */
	| { status: "unknown"; client: string | null; server: string | null };

/**
 * Compare the two reported versions.
 *
 * The comparison is deliberately exact rather than semver-aware. Reading the
 * numbers would mean deciding which differences are tolerable, and this client
 * has no basis for that decision: the compatible range is a property of the
 * protocol between the two builds, which nothing here measures. An exact
 * comparison makes a claim it can support — these are different builds — and
 * leaves the judgment to the operator, who knows what they installed.
 */
export function compareVersions(client: string | null, server: string | null): VersionCompat {
	const clientVersion = normalize(client);
	const serverVersion = normalize(server);
	if (clientVersion === null || serverVersion === null) {
		return { status: "unknown", client: clientVersion, server: serverVersion };
	}
	if (clientVersion === serverVersion) return { status: "match", client: clientVersion, server: serverVersion };
	return { status: "mismatch", client: clientVersion, server: serverVersion };
}

function normalize(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}
