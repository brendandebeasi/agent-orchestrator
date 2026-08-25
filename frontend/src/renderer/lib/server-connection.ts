/**
 * What the client knows about its link to the server it is talking to.
 *
 * Two facts are already tracked elsewhere and neither is the whole answer. The
 * server target (lib/server-target.ts) says where we are pointed but not whether
 * anything is answering there. The event-stream state (lib/events-connection.ts)
 * says whether the change stream is open but nothing about which server it was
 * open to. This module is where the two meet, plus the one fact nobody else
 * holds: what the server said its version was when we last shook hands.
 *
 * It exists because "reconnecting" is a claim about a specific server. A client
 * that shows "reconnecting…" while its target has already moved to a different
 * machine is describing a connection that nobody is trying to make.
 */

import { getEventsConnectionState, subscribeEventsConnection } from "./events-connection";
import {
	getServerTarget,
	serverCredentialPrompt,
	subscribeServerTarget,
	type CredentialPrompt,
} from "./server-target";
import { compareVersions, type VersionCompat } from "./version-compat";

/**
 * How the link to the current server is doing.
 *
 * "unknown" is not a failure: it is the gap between pointing at a server and
 * the change stream having had time to open, and reporting a problem during it
 * would make every launch look like an outage.
 */
export type ServerLinkState =
	/** No server is trusted — the local daemon is down, or none is chosen. */
	| "none"
	/** Pointed at a server; nothing has confirmed or denied it yet. */
	| "unknown"
	/** The change stream is open against this server. */
	| "connected"
	/** The change stream dropped and is retrying against this server. */
	| "reconnecting";

/** Everything a connection indicator needs, in one snapshot. */
export type ServerConnection = {
	/** Whether the daemon shares this client's machine. */
	kind: "local" | "remote";
	/** What to call the server. */
	label: string;
	baseUrl: string | null;
	state: ServerLinkState;
	/**
	 * The server wants a password this client does not hold, and why. Kept apart
	 * from `state` because it is not a report on the link: nothing is being
	 * retried, and no amount of waiting fixes it. Something has to ask the
	 * operator.
	 */
	credentialPrompt: CredentialPrompt;
	/** Result of the last version handshake; "unknown" until one happens. */
	versions: VersionCompat;
};

/** The client's own version, learned once from the host and cached here. */
let clientVersion: string | null = null;
/** What the current server reported. Cleared whenever the target moves. */
let serverVersion: string | null = null;

const listeners = new Set<() => void>();

/**
 * The snapshot handed to `useSyncExternalStore`, memoized because that hook
 * compares by identity and re-derives on every render: a fresh object each call
 * is an infinite render loop, not a stale-data bug.
 */
let snapshot: ServerConnection = derive();

function notify(): void {
	const next = derive();
	if (
		next.kind === snapshot.kind &&
		next.label === snapshot.label &&
		next.baseUrl === snapshot.baseUrl &&
		next.state === snapshot.state &&
		next.credentialPrompt === snapshot.credentialPrompt &&
		next.versions.status === snapshot.versions.status &&
		next.versions.client === snapshot.versions.client &&
		next.versions.server === snapshot.versions.server
	) {
		return;
	}
	snapshot = next;
	listeners.forEach((listener) => listener());
}

function derive(): ServerConnection {
	const target = getServerTarget();
	const events = getEventsConnectionState();
	let state: ServerLinkState;
	if (target.baseUrl === null) state = "none";
	else if (events === "connected") state = "connected";
	else if (events === "disconnected") state = "reconnecting";
	else state = "unknown";
	return {
		kind: target.kind,
		label: target.label,
		baseUrl: target.baseUrl,
		state,
		credentialPrompt: serverCredentialPrompt(),
		versions: compareVersions(clientVersion, serverVersion),
	};
}

/** The current connection snapshot. Stable between real changes. */
export function getServerConnection(): ServerConnection {
	return snapshot;
}

/** Subscribe to connection changes (useSyncExternalStore-compatible). */
export function subscribeServerConnection(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Record what the server said its version was, learned from the connection
 * handshake. Null means the server did not say, which a daemon started without
 * a supervising app never does.
 */
export function setServerVersion(version: string | null): void {
	serverVersion = version;
	notify();
}

/** Record this client's own version, read once from the host at startup. */
export function setClientVersion(version: string | null): void {
	clientVersion = version;
	notify();
}

/** Reset module state. Tests only; there is no runtime reason to forget this. */
export function resetServerConnectionForTest(): void {
	clientVersion = null;
	serverVersion = null;
	snapshot = derive();
}

// A target change invalidates the server version: the version we hold belongs
// to the server we were talking to, and continuing to report it against a
// different one would be a mismatch warning about a machine we have left.
subscribeServerTarget(() => {
	const target = getServerTarget();
	if (target.baseUrl !== snapshot.baseUrl) serverVersion = null;
	notify();
});
subscribeEventsConnection(notify);
