import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setApiBaseUrlMock, setApiDaemonStatusMock, getStatusMock } = vi.hoisted(() => ({
	setApiBaseUrlMock: vi.fn(),
	setApiDaemonStatusMock: vi.fn(),
	getStatusMock: vi.fn(),
}));

vi.mock("./api-client", () => ({
	setApiBaseUrl: setApiBaseUrlMock,
	setApiDaemonStatus: setApiDaemonStatusMock,
}));

/**
 * `hasElectronHost` is fixed at module load, as a host fact should be, so the
 * two host shapes have to be loaded as two module instances rather than toggled
 * on one.
 */
async function loadFor(hasElectronHost: boolean) {
	vi.resetModules();
	vi.doMock("./bridge", () => ({
		aoBridge: { daemon: { getStatus: getStatusMock } },
		hasElectronHost,
	}));
	return import("./daemon-status");
}

beforeEach(() => {
	setApiBaseUrlMock.mockReset();
	setApiDaemonStatusMock.mockReset();
	getStatusMock.mockReset().mockResolvedValue({ state: "ready", port: 4321 });
});

afterEach(() => {
	vi.doUnmock("./bridge");
	vi.resetModules();
});

describe("with a supervisor behind the window", () => {
	it("follows the daemon to the port the supervisor reports", async () => {
		const { applyDaemonStatus } = await loadFor(true);

		applyDaemonStatus({ state: "ready", port: 4321 });

		expect(setApiBaseUrlMock).toHaveBeenCalledWith("http://127.0.0.1:4321");
	});

	it("un-aims the client when the daemon is not ready", async () => {
		const { applyDaemonStatus } = await loadFor(true);

		applyDaemonStatus({ state: "error", message: "spawn failed" });

		expect(setApiBaseUrlMock).toHaveBeenCalledWith(null);
	});

	it("does not aim at the page origin, which in Electron is a file or dev-server URL", async () => {
		const { aimAtHostOrigin } = await loadFor(true);

		aimAtHostOrigin();

		expect(setApiBaseUrlMock).not.toHaveBeenCalled();
	});
});

describe("with no supervisor behind the window", () => {
	it("aims at the origin that served the page", async () => {
		const { aimAtHostOrigin } = await loadFor(false);

		aimAtHostOrigin();

		expect(setApiBaseUrlMock).toHaveBeenCalledWith(window.location.origin);
	});

	it("leaves the address alone when a status arrives, so the stub cannot un-aim the client", async () => {
		const { applyDaemonStatus, aimAtHostOrigin } = await loadFor(false);
		aimAtHostOrigin();
		setApiBaseUrlMock.mockClear();

		applyDaemonStatus({ state: "stopped" });

		expect(setApiBaseUrlMock).not.toHaveBeenCalled();
	});

	it("still records the status, which is what API errors are explained from", async () => {
		const { applyDaemonStatus } = await loadFor(false);

		applyDaemonStatus({ state: "stopped", message: "no supervisor" });

		expect(setApiDaemonStatusMock).toHaveBeenCalledWith({ state: "stopped", message: "no supervisor" });
	});
});

/**
 * `vi.resetModules()` gives `daemon-status` a fresh `server-target` on every
 * load, so the target has to be moved through the same module instance that
 * `daemon-status` is reading — importing it at the top of the file would move a
 * different store than the one under test.
 */
async function loadWithTarget(hasElectronHost: boolean) {
	const daemonStatus = await loadFor(hasElectronHost);
	const serverTarget = await import("./server-target");
	return { ...daemonStatus, ...serverTarget };
}

describe("once the client is pointed at another computer", () => {
	it("stops letting the local supervisor rewrite the address", async () => {
		// The supervisor is still running and still reporting; in remote mode it
		// reports "stopped" for the life of the process, because it was never
		// asked to start a daemon. Passing that through would un-aim the client
		// from the server it is actually talking to, on every status event.
		const { applyDaemonStatus, setRemoteServerTarget } = await loadWithTarget(true);
		setRemoteServerTarget({ baseUrl: "http://workshop.local:3001", label: "workshop", credential: "pw" });
		setApiBaseUrlMock.mockClear();
		setApiDaemonStatusMock.mockClear();

		applyDaemonStatus({ state: "stopped", message: "no local daemon" });

		expect(setApiBaseUrlMock).not.toHaveBeenCalled();
		expect(setApiDaemonStatusMock).not.toHaveBeenCalled();
	});

	it("goes back to following the supervisor when the client comes home", async () => {
		const { applyDaemonStatus, setRemoteServerTarget, setLocalServerTarget } = await loadWithTarget(true);
		setRemoteServerTarget({ baseUrl: "http://workshop.local:3001", label: "workshop", credential: "pw" });
		setLocalServerTarget(null);
		setApiBaseUrlMock.mockClear();

		applyDaemonStatus({ state: "ready", port: 4321 });

		expect(setApiBaseUrlMock).toHaveBeenCalledWith("http://127.0.0.1:4321");
	});
});

describe("what 'is the server up' means for a server on another computer", () => {
	it("defers to the supervisor while the client is pointed at this computer", async () => {
		const { remoteServerStatus } = await loadFor(true);

		expect(remoteServerStatus({ kind: "local", baseUrl: null, label: "This computer", requiresAuth: false })).toBeNull();
	});

	it("reports a remote server as ready, on the port its address names", async () => {
		// A remote target is only committed after an authenticated probe of it
		// succeeded, so a remote target is a server that answered — which is
		// what ready means here. The port is read off the address rather than
		// invented: it is the port that daemon is listening on.
		const { remoteServerStatus } = await loadFor(true);

		expect(
			remoteServerStatus({
				kind: "remote",
				baseUrl: "http://workshop.local:3010",
				label: "workshop.local:3010",
				requiresAuth: true,
			}),
		).toEqual({ state: "ready", port: 3010 });
	});

	it("fills in the scheme's port when the address omits one, so a proxied server is not portless", async () => {
		const { remoteServerStatus } = await loadFor(true);

		expect(
			remoteServerStatus({
				kind: "remote",
				baseUrl: "https://ao.example.com",
				label: "ao.example.com",
				requiresAuth: true,
			}),
		).toEqual({ state: "ready", port: 443 });
	});

	it("reports nothing configured for a remote target that has no address yet", async () => {
		// The shape a launch takes between being told it is remote and being
		// told where. Claiming ready here would let the shell render a board
		// against no server at all.
		const { remoteServerStatus } = await loadFor(true);

		expect(remoteServerStatus({ kind: "remote", baseUrl: null, label: "workshop", requiresAuth: true })).toEqual({
			state: "stopped",
			code: "not_configured",
		});
	});
});
