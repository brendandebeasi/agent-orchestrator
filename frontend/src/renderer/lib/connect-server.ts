/**
 * Deciding whether an address and a password actually reach a daemon.
 *
 * The connection screen cannot just point the client at an address and watch
 * what breaks: by the time a query fails the operator has already been shown a
 * half-loaded board, and "something went wrong" is not an answer they can act
 * on. Typing the wrong host and typing the wrong password are different
 * mistakes with different fixes, and the fix is only obvious if the client says
 * which one happened.
 *
 * So connecting starts with one deliberate request whose every outcome is
 * enumerated below, and the target is only committed once that request says the
 * server is really there and really accepted us.
 */

import { setServerVersion } from "./server-connection";
import { getServerTarget, setRemoteServerTarget } from "./server-target";

/**
 * The probe route.
 *
 * `/healthz` rather than the web client's `POST /api/v1/remote/session`,
 * because that route exists only on daemons built and configured to host the
 * browser bundle, and a desktop client connecting to a server that serves no
 * web client is an ordinary case, not an error. `/healthz` is on every daemon,
 * is a read, is behind the same auth middleware as everything else on the
 * network listener, and already reports the version this client needs to
 * compare against. It costs the daemon nothing to answer.
 */
const PROBE_PATH = "/healthz";

/** What `/healthz` calls itself. A different answer is a different program. */
const DAEMON_SERVICE_NAME = "agent-orchestrator-daemon";

/** Long enough for a sleepy host on a tailnet, short enough to not feel hung. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * The outcome of one connection attempt.
 *
 * These are the distinctions the operator has to make a decision from, which is
 * why "rejected" and "lockedOut" are separate despite both being an
 * authentication failure: one means retype the password, the other means the
 * password is being retyped too fast and waiting is the fix. Likewise
 * "notADaemon" is separate from "unreachable" — something answered, so the
 * address is not wrong in the way "unreachable" implies, and telling an operator
 * their reachable server is unreachable sends them to check their network for
 * no reason.
 */
export type ConnectionProbe =
	| { outcome: "connected"; appVersion: string | null }
	| { outcome: "unreachable"; detail: string }
	| { outcome: "rejected" }
	| { outcome: "lockedOut" }
	| { outcome: "notADaemon" };

/** Everything a probe needs. The credential is required; see `probeServer`. */
export type ProbeRequest = {
	baseUrl: string;
	credential: string;
	/** Caller-owned cancellation, on top of this module's own timeout. */
	signal?: AbortSignal;
};

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
 * Ask a server whether it is a daemon and whether it accepts this password.
 *
 * The credential is not optional even though `/healthz` on a loopback daemon
 * needs none: this path exists to reach a daemon over the network, and the
 * network listener authenticates every route. A caller with no password to try
 * has nothing to probe with.
 */
export async function probeServer({ baseUrl, credential, signal }: ProbeRequest): Promise<ConnectionProbe> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	let response: Response;
	try {
		response = await fetch(`${baseUrl}${PROBE_PATH}`, {
			method: "GET",
			headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
			signal: controller.signal,
			// The probe must reflect the server, not what a proxy remembered of
			// it, and a cached 200 from a daemon that has since stopped is the
			// worst possible answer here.
			cache: "no-store",
		});
	} catch (error) {
		return { outcome: "unreachable", detail: unreachableDetail(error, signal) };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}

	if (response.status === 401 || response.status === 403) return { outcome: "rejected" };
	if (response.status === 429) return { outcome: "lockedOut" };
	// Anything else that is not a success is something answering on the address
	// that is not a daemon behaving like one — a proxy, a router's admin page, a
	// different service on a reused port.
	if (!response.ok) return { outcome: "notADaemon" };

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { outcome: "notADaemon" };
	}
	if (!isDaemonProbeBody(body)) return { outcome: "notADaemon" };
	// Absent when the daemon was started without a supervising app. That is
	// "cannot tell", not "mismatched", and it is the caller's job to keep those
	// apart — see version-compat.ts.
	const appVersion = typeof body.appVersion === "string" && body.appVersion !== "" ? body.appVersion : null;
	return { outcome: "connected", appVersion };
}

/**
 * Probe a server and, if it answers, point the client at it.
 *
 * Committing only on success is the whole point: a failed attempt must leave
 * the client wherever it already was, so an operator who mistypes an address
 * while connected does not lose the connection they had.
 */
export async function connectToServer(request: ProbeRequest & { label?: string }): Promise<ConnectionProbe> {
	const probe = await probeServer(request);
	if (probe.outcome !== "connected") return probe;
	setRemoteServerTarget({
		baseUrl: request.baseUrl,
		label: request.label ?? serverLabelFromAddress(request.baseUrl),
		credential: request.credential,
	});
	// After the target moves, not before: the target store clears the recorded
	// server version whenever the address changes, so recording it first would
	// throw away the answer we just got.
	setServerVersion(probe.appVersion);
	return probe;
}

/** Whether the client is currently pointed at a server it reached this way. */
export function isConnectedToRemoteServer(): boolean {
	const target = getServerTarget();
	return target.kind === "remote" && target.baseUrl !== null;
}

/**
 * Why a request never produced a response. `fetch` rejects with an opaque
 * `TypeError` for DNS failure, connection refused, and a TLS problem alike, so
 * the honest detail is short: the distinctions worth drawing are the ones a
 * server actually answered.
 */
function unreachableDetail(error: unknown, callerSignal: AbortSignal | undefined): string {
	if (callerSignal?.aborted) return "cancelled";
	if (error instanceof DOMException && error.name === "AbortError") return "timeout";
	return error instanceof Error && error.message !== "" ? error.message : "network error";
}

/** Whether a 200 body is the daemon's probe payload and not some other JSON. */
function isDaemonProbeBody(body: unknown): body is { appVersion?: unknown } {
	if (typeof body !== "object" || body === null) return false;
	const service = (body as { service?: unknown }).service;
	return service === DAEMON_SERVICE_NAME;
}
