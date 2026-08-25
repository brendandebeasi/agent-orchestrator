/**
 * Which daemon this client is talking to, and the credential it talks with.
 *
 * There has only ever been one answer to that question — the daemon the desktop
 * app launched on this machine — so it lived as a base URL inside the API
 * client. A client that can reach a daemon on another machine needs the answer
 * to be state: it changes at runtime, more than one transport reads it (REST,
 * the terminal stream, the change-event stream), and it now carries a
 * credential the local answer never needed.
 *
 * This module is the single owner of that state and deliberately imports
 * nothing: every transport reads from here, and nothing here reads from a
 * transport.
 */

/** A daemon this client can talk to. */
export type ServerTarget = {
	/**
	 * Origin the client sends requests to, without a trailing slash. `null`
	 * means no server is trusted yet — before the local daemon reports a port,
	 * or before the operator has connected to a remote one. Requests made while
	 * it is null fail with the supervisor's own reason rather than a network
	 * error against a guessed address.
	 */
	baseUrl: string | null;
	/** What the operator is shown. Not an identifier; never sent anywhere. */
	label: string;
	/**
	 * Whether the server demands the connection password. It is a property of
	 * the server, not of whether a credential happens to be held: the local
	 * daemon listens on loopback and authenticates nothing, and a client that
	 * sent it a header would be sending a credential it has no reason to.
	 */
	requiresAuth: boolean;
};

/**
 * Build-time override, used by the e2e harness and any build pinned to a fixed
 * daemon. When set it is the fallback the local target returns to, so clearing
 * the target does not strand a build that has no supervisor to ask.
 */
const explicitBaseUrl: string | undefined = import.meta.env.VITE_AO_API_BASE_URL;

/** Label for the daemon running alongside this client. */
export const LOCAL_SERVER_LABEL = "This computer";

function normalizeBaseUrl(raw: string | null | undefined): string | null {
	const value = raw ?? explicitBaseUrl ?? null;
	return value === null ? null : value.replace(/\/+$/, "");
}

let target: ServerTarget = {
	baseUrl: normalizeBaseUrl(explicitBaseUrl ?? null),
	label: LOCAL_SERVER_LABEL,
	requiresAuth: false,
};

/**
 * The connection password for the current target, held in memory only. It is
 * deliberately not part of ServerTarget: the target is read on every request
 * and passed around for display, and a credential that travels with it is a
 * credential that ends up in a log line or a React devtools panel.
 */
let credential: string | null = null;

const listeners = new Set<() => void>();

function notify(): void {
	listeners.forEach((listener) => listener());
}

/** The server this client is currently talking to. */
export function getServerTarget(): ServerTarget {
	return target;
}

/**
 * Subscribe to target changes (useSyncExternalStore-compatible). Anything bound
 * to one server — an open socket, a stream, a cached query — uses this to
 * rebind when the answer changes, whether that is the local daemon coming back
 * on a different port or the operator connecting somewhere else entirely.
 */
export function subscribeServerTarget(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The credential for the current target, or null when it needs none. */
export function getServerCredential(): string | null {
	return target.requiresAuth ? credential : null;
}

/**
 * The credential as request headers — empty for a server that authenticates
 * nothing. Every transport that builds its own request (the change and
 * notification streams, the workspace watch) goes through this rather than
 * formatting the header itself.
 */
export function serverAuthHeaders(): Record<string, string> {
	const value = getServerCredential();
	return value === null ? {} : { Authorization: `Bearer ${value}` };
}

/**
 * Point the client at the daemon on this machine. This is the supervisor's
 * path: it reports a port when the daemon is up and null when it is not.
 */
export function setLocalServerTarget(baseUrl: string | null): void {
	setServerTarget({ baseUrl: normalizeBaseUrl(baseUrl), label: LOCAL_SERVER_LABEL, requiresAuth: false }, null);
}

/** Point the client at a daemon reached over the network. */
export function setRemoteServerTarget(next: { baseUrl: string; label: string; credential: string }): void {
	setServerTarget(
		{ baseUrl: normalizeBaseUrl(next.baseUrl), label: next.label, requiresAuth: true },
		next.credential,
	);
}

/**
 * Forget the credential without changing the target, which is what a 401 means:
 * the address is right and the password is not. The target stays so the
 * operator is asked for a password rather than for an address they already
 * gave.
 */
export function clearServerCredential(): void {
	if (credential === null) return;
	credential = null;
	notify();
}

function setServerTarget(next: ServerTarget, nextCredential: string | null): void {
	const unchanged =
		next.baseUrl === target.baseUrl &&
		next.label === target.label &&
		next.requiresAuth === target.requiresAuth &&
		nextCredential === credential;
	if (unchanged) return;
	target = next;
	credential = nextCredential;
	notify();
}
