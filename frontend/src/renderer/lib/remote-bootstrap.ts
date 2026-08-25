/**
 * Where the client points itself before the first render.
 *
 * Four launches arrive here and each has a different answer. A desktop launch
 * that runs its own daemon has no answer yet — the supervisor reports a port
 * once it has one, and until then the client is aimed at nothing on purpose. A
 * desktop launch configured for a remote server knows the address from its
 * launch arguments and should be talking to it by the time the shell mounts,
 * without the operator being asked anything they have already answered. A tab
 * served by vite's dev server is aimed at its own origin, which the proxy
 * forwards to a loopback daemon that wants no credential. A tab a daemon served
 * itself is aimed at its own origin too, but has to present the credential its
 * login page obtained, and goes back to that page when it has none.
 *
 * That last case is why this runs before render rather than inside a component.
 * A remote client that mounted first and re-aimed afterwards would show its
 * connection screen for a frame and then replace it, which reads as "the
 * password was wrong" to anyone whose eye caught it.
 */

import { aoBridge } from "./bridge";
import { serverLabelFromAddress } from "../../shared/remote-server";
import { REMOTE_LOGIN_PATH, readRemoteSession } from "../../shared/remote-session";
import { aimAtRemoteServer, clearServerCredential, setRemoteServerTarget } from "./server-target";
import { aimAtHostOrigin } from "./daemon-status";
import { replaceLocation } from "./navigate";
import { probeServer } from "./connect-server";
import { setServerVersion } from "./server-connection";

/**
 * Aim the client, and report when the last thing that can change the aim has
 * been read.
 *
 * The aiming itself happens synchronously, before this function first yields,
 * so anything that fires a request during startup is already pointed somewhere
 * by the time it does. What the returned promise waits for is narrower: the
 * saved password, which arrives over IPC a moment later and decides whether the
 * shell opens on the board or on the connection screen. Rendering before that
 * answer arrives would show the connection screen for a frame and then throw it
 * away, so the caller holds the first paint until this resolves — an IPC read
 * of a local file, not a network round trip.
 *
 * Reaching the server is deliberately not awaited. That can take the probe's
 * full timeout, and blocking the launch on it would leave an operator staring
 * at nothing whenever the machine they saved is asleep.
 */
export function aimAtConfiguredServer(): Promise<void> {
	const baseUrl = aoBridge.remoteServer;
	if (baseUrl === null) {
		// A tab the daemon itself served has a credential waiting for it and a
		// login page to fall back to; every other browser tab and every ordinary
		// desktop launch is settled without asking anyone anything — the origin
		// that served it, or the port its own supervisor will report shortly.
		if (isDaemonServedClient()) aimAtServingDaemon();
		else aimAtHostOrigin();
		return Promise.resolve();
	}
	const label = serverLabelFromAddress(baseUrl);
	// Named before the password is known, so that if the password turns out to
	// be missing the connection screen is already about the right machine
	// rather than an empty form appearing for no stated reason.
	aimAtRemoteServer({ baseUrl, label });
	return finishAiming(baseUrl, label);
}

/**
 * Whether this bundle is the one a daemon serves at `/app/`, rather than the
 * one vite's dev server serves while proxying to a daemon on loopback.
 *
 * Both are the renderer in a browser aimed at its own origin, and nothing they
 * can observe at runtime separates them — same origin shape, same absent
 * Electron preload. The difference is entirely in what is in front of the
 * daemon: a network listener behind a connection password in one case, a dev
 * proxy to loopback in the other. So the build says which one it produced.
 */
function isDaemonServedClient(): boolean {
	return import.meta.env.VITE_AO_WEB_CLIENT === "1";
}

/**
 * Aim a daemon-served tab at the daemon that served it, using the credential
 * its login page left behind.
 *
 * The target is set as a remote one even though the daemon is at this tab's own
 * origin, because "remote" here means "not a daemon this client started" — which
 * is what decides that host-bound features stay withdrawn and that readiness is
 * answered by the server rather than by a local supervisor that does not exist.
 *
 * With no credential to find, the tab goes back to the login page. That is the
 * ordinary state of a second tab: the asset cookie is the browser's, so the app
 * loads, but the token is the tab's and it has none.
 */
function aimAtServingDaemon(): void {
	if (typeof window === "undefined") return;
	const session = readRemoteSession(sessionStorageOrNull());
	if (session === null) {
		replaceLocation(REMOTE_LOGIN_PATH);
		return;
	}
	const baseUrl = window.location.origin;
	setRemoteServerTarget({ baseUrl, label: serverLabelFromAddress(baseUrl), credential: session.token });
	// Already known from the exchange the login page made, so the client can
	// report a version mismatch without a handshake of its own. Empty means the
	// daemon was launched by no app and has no version to report, which
	// `setServerVersion` records as unknown rather than as a mismatch.
	setServerVersion(session.appVersion === "" ? null : session.appVersion);
}

/**
 * The tab's session storage, or null where reaching for it raises — which the
 * property access itself does under some browser privacy settings, before any
 * read has been attempted.
 */
function sessionStorageOrNull(): Storage | null {
	try {
		return window.sessionStorage;
	} catch {
		return null;
	}
}

async function finishAiming(baseUrl: string, label: string): Promise<void> {
	let credential: string | null = null;
	try {
		credential = await aoBridge.remoteServers.readCredential(baseUrl);
	} catch {
		// A keychain that will not open is a reason to ask for the password
		// again, not a reason to fail the launch.
	}
	// Nothing to authenticate with, and the client is already aimed, which is
	// what puts the connection screen on screen with the address filled in.
	if (credential === null) return;
	setRemoteServerTarget({ baseUrl, label, credential });
	// Left running behind the first render for the two things the target alone
	// cannot supply. One is the server's version, which only a handshake
	// reveals. The other is whether the saved password still works: a server
	// whose password has been changed since it was saved would otherwise be
	// found out by whichever query happened to land first, which is a worse
	// moment to discover it and a less obvious one to explain.
	void probeServer({ baseUrl, credential })
		.then((probe) => {
			if (probe.outcome === "connected") {
				setServerVersion(probe.appVersion);
				return;
			}
			// Only an explicit refusal is acted on. Unreachable is what a
			// sleeping laptop looks like, and dropping a working password
			// because the machine was closed would make the operator retype it
			// every morning; the reconnect indicator is the right report for
			// that. Clearing the credential here is what routes the shell to
			// the connection screen with "that password was rejected" rather
			// than to a board whose every query fails.
			if (probe.outcome === "rejected") clearServerCredential();
		})
		.catch(() => {
			// probeServer resolves its failures; this is belt and braces.
		});
}
