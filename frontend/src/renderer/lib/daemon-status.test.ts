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
