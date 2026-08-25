import { aoBridge, hasElectronHost } from "./bridge";
import { setApiBaseUrl, setApiDaemonStatus } from "./api-client";
import { serverIsLocal, type ServerTarget } from "./server-target";

export type DaemonStatus = Awaited<ReturnType<typeof aoBridge.daemon.getStatus>>;

export function applyDaemonStatus(nextStatus: DaemonStatus): void {
	// The local supervisor stops being this client's supervisor the moment the
	// client is pointed at another computer. In remote mode it never starts a
	// daemon, so it reports "stopped" for the life of the process — and that
	// answer is not about the server in use. Recording it would explain the
	// remote server's failures with a local daemon nobody asked for, and
	// applying it would un-aim the client on every status event. Dropped before
	// either happens, which is why this precedes the recording below.
	if (!serverIsLocal()) return;
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
/**
 * The port a base URL names, filling in the scheme's default when it omits one.
 * Undefined only for a string that is not a URL, which the address normalizer
 * upstream already refuses to produce.
 */
function portFromBaseUrl(baseUrl: string): number | undefined {
	try {
		const url = new URL(baseUrl);
		if (url.port !== "") return Number(url.port);
		return url.protocol === "https:" ? 443 : 80;
	} catch {
		return undefined;
	}
}

/**
 * What "is the server up" means once the client is aimed at another machine,
 * or null when it is not and the supervisor should be asked instead.
 *
 * The local supervisor is still there and still answering; in remote mode its
 * answer is "stopped" for the life of the process, because it was never asked
 * to start a daemon. The shell gates nearly everything on that answer, so
 * passing it through would leave a perfectly connected client sitting on the
 * startup loader under a failure banner about a daemon nobody wanted.
 *
 * The honest substitute is the state of the server the client actually reached.
 * A remote target is committed only after an authenticated probe of it
 * succeeded (see `connectToServer`), so a remote target is a server that
 * answered — which is what `ready` means here. The port is read off the address
 * rather than invented: it is the port that daemon is listening on.
 *
 * A link that drops afterwards is reported by the connection indicator beside
 * the server's name, not by returning to a loader. A remote link blinks, and a
 * client that discarded its board on every blink would be unusable.
 */
export function remoteServerStatus(target: ServerTarget): DaemonStatus | null {
	if (target.kind === "local") return null;
	const port = target.baseUrl === null ? undefined : portFromBaseUrl(target.baseUrl);
	if (port === undefined) return { state: "stopped", code: "not_configured" };
	return { state: "ready", port };
}

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
