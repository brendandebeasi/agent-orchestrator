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
	 * Whether the daemon runs on the machine this client runs on.
	 *
	 * Separate from `requiresAuth`, which the location currently predicts but
	 * does not mean: one describes how the server authenticates, the other
	 * describes where its filesystem is. Anything that reaches for something on
	 * this computer on the server's behalf — an editor, a file manager, a
	 * directory picker — is asking this question and not that one.
	 */
	kind: "local" | "remote";
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
	kind: "local",
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

/**
 * Whether the credential we last held was refused by the server, as opposed to
 * never having been supplied. Only meaningful while `credential` is null.
 */
let credentialRejected = false;

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
	setServerTarget(
		{ kind: "local", baseUrl: normalizeBaseUrl(baseUrl), label: LOCAL_SERVER_LABEL, requiresAuth: false },
		null,
	);
}

/** Point the client at a daemon reached over the network. */
export function setRemoteServerTarget(next: { baseUrl: string; label: string; credential: string }): void {
	setServerTarget(
		{ kind: "remote", baseUrl: normalizeBaseUrl(next.baseUrl), label: next.label, requiresAuth: true },
		next.credential,
	);
}

/**
 * Whether the current server shares a filesystem with this client. Read by the
 * capability gate: a browser client served by the daemon it talks to is still
 * remote in the sense that matters here, because the machine running the
 * renderer is not the machine holding the worktree.
 */
export function serverIsLocal(): boolean {
	return target.kind === "local";
}

/**
 * What the client wants from the operator before it can talk to its server.
 *
 * `null` covers both a server that needs no password and one whose password we
 * hold. The other two are the same missing credential with different histories,
 * and they are kept apart because the prompt says different things: a password
 * that was tried and refused is a correction, and one that was never supplied
 * is a first request. Telling an operator their password was rejected when they
 * have not typed one yet sends them looking for a mistake they did not make.
 */
export type CredentialPrompt = null | "rejected" | "missing";

/**
 * Whether the server wants a password this client does not have, and why. It is
 * deliberately not "is the credential null": a local daemon holds no credential
 * and needs none.
 */
export function serverCredentialPrompt(): CredentialPrompt {
	if (!target.requiresAuth || credential !== null) return null;
	return credentialRejected ? "rejected" : "missing";
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
	credentialRejected = true;
	notify();
}

function setServerTarget(next: ServerTarget, nextCredential: string | null): void {
	const unchanged =
		next.kind === target.kind &&
		next.baseUrl === target.baseUrl &&
		next.label === target.label &&
		next.requiresAuth === target.requiresAuth &&
		nextCredential === credential;
	if (unchanged) return;
	target = next;
	credential = nextCredential;
	// Any move ends the rejection. Either a fresh credential arrived, whose fate
	// is its own story, or the client is pointed somewhere else, where the last
	// server's verdict does not apply. Carrying it forward would tell the
	// operator their new password was refused before it was ever sent.
	credentialRejected = false;
	notify();
}
