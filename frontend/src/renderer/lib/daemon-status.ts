import { aoBridge, hasElectronHost } from "./bridge";
import { setApiBaseUrl, setApiDaemonStatus } from "./api-client";

export type DaemonStatus = Awaited<ReturnType<typeof aoBridge.daemon.getStatus>>;

export function applyDaemonStatus(nextStatus: DaemonStatus): void {
	setApiDaemonStatus(nextStatus);
	// Only a supervisor gets to say where the server is. It spawned the daemon,
	// it read the port off it, and a restart on a different port is a fact only
	// it can report. A browser has none of that: its server is whichever one it
	// was aimed at, and letting a status stub write here would un-aim the client
	// every time it answered.
	if (!hasElectronHost) return;
	if (nextStatus.state === "ready" && nextStatus.port) {
		setApiBaseUrl(`http://127.0.0.1:${nextStatus.port}`);
	} else {
		setApiBaseUrl(null);
	}
}

/**
 * Aim a browser client at the server that served it.
 *
 * In development that is the vite dev server, which proxies `/api` and `/mux`
 * to the daemon; in the embedded build it is the daemon's own `/app/` handler.
 * Either way the answer is the same origin the page came from, which is also
 * the only origin a browser can reach without a CORS grant the daemon does not
 * issue. Electron never calls this — its address comes from the supervisor —
 * and a build pinned to a fixed server through `VITE_AO_API_BASE_URL` does not
 * need it either.
 */
export function aimAtHostOrigin(): void {
	if (hasElectronHost || typeof window === "undefined") return;
	setApiBaseUrl(window.location.origin);
}

export async function refreshDaemonStatus(): Promise<DaemonStatus> {
	const nextStatus = await readDaemonStatus();
	applyDaemonStatus(nextStatus);
	return nextStatus;
}

export function readDaemonStatus(): Promise<DaemonStatus> {
	return aoBridge.daemon.getStatus();
}
