/**
 * Where the client points itself before the first render.
 *
 * Three launches arrive here and each has a different answer. A browser tab is
 * served by the daemon it talks to, so the answer is its own origin. A desktop
 * launch that runs its own daemon has no answer yet — the supervisor reports a
 * port once it has one, and until then the client is aimed at nothing on
 * purpose. A desktop launch configured for a remote server knows the address
 * from its launch arguments and should be talking to it by the time the shell
 * mounts, without the operator being asked anything they have already answered.
 *
 * That last case is why this runs before render rather than inside a component.
 * A remote client that mounted first and re-aimed afterwards would show its
 * connection screen for a frame and then replace it, which reads as "the
 * password was wrong" to anyone whose eye caught it.
 */

import { aoBridge } from "./bridge";
import { serverLabelFromAddress } from "../../shared/remote-server";
import { aimAtRemoteServer, clearServerCredential, setRemoteServerTarget } from "./server-target";
import { aimAtHostOrigin } from "./daemon-status";
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
		// Either a browser tab, which belongs to the origin that served it, or a
		// desktop launch whose own supervisor will report a port shortly. Both
		// are settled without asking anyone anything.
		aimAtHostOrigin();
		return Promise.resolve();
	}
	const label = serverLabelFromAddress(baseUrl);
	// Named before the password is known, so that if the password turns out to
	// be missing the connection screen is already about the right machine
	// rather than an empty form appearing for no stated reason.
	aimAtRemoteServer({ baseUrl, label });
	return finishAiming(baseUrl, label);
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
