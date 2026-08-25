import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readCredentialMock, setApiBaseUrlMock } = vi.hoisted(() => ({
	readCredentialMock: vi.fn(),
	setApiBaseUrlMock: vi.fn(),
}));

/**
 * The bootstrap's whole job is to decide where the client points, and the two
 * things that decide it are host facts fixed at module load: the address on the
 * launch arguments, and whether there is an Electron host at all. So each case
 * loads the module against the host it is about, rather than toggling one.
 */
async function loadFor(host: { remoteServer: string | null; hasElectronHost: boolean }) {
	vi.resetModules();
	vi.doMock("./bridge", () => ({
		hasElectronHost: host.hasElectronHost,
		aoBridge: {
			remoteServer: host.remoteServer,
			remoteServers: { readCredential: readCredentialMock },
			daemon: { getStatus: vi.fn() },
		},
	}));
	// Stubbed because `aimAtHostOrigin` is the browser's half of the answer and
	// asserting on the address the client ends up with is the point; the real
	// api-client would go on to build a fetch client around it.
	vi.doMock("./api-client", () => ({
		setApiBaseUrl: setApiBaseUrlMock,
		setApiDaemonStatus: vi.fn(),
	}));
	const bootstrap = await import("./remote-bootstrap");
	const serverTarget = await import("./server-target");
	return { ...bootstrap, ...serverTarget };
}

const DAEMON_BODY = { service: "agent-orchestrator-daemon", status: "ok", appVersion: "1.4.2" };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

beforeEach(() => {
	readCredentialMock.mockReset().mockResolvedValue(null);
	setApiBaseUrlMock.mockReset();
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(DAEMON_BODY)));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock("./bridge");
	vi.doUnmock("./api-client");
	vi.resetModules();
});

describe("a launch that runs its own daemon", () => {
	it("leaves the aiming to the supervisor and asks the keychain nothing", async () => {
		const { aimAtConfiguredServer, getServerTarget } = await loadFor({
			remoteServer: null,
			hasElectronHost: true,
		});

		await aimAtConfiguredServer();

		expect(getServerTarget().kind).toBe("local");
		expect(readCredentialMock).not.toHaveBeenCalled();
		// The supervisor has not reported a port yet, so there is nothing to
		// aim at — which is different from aiming at the wrong thing.
		expect(setApiBaseUrlMock).not.toHaveBeenCalled();
	});
});

describe("a page served over HTTP", () => {
	it("aims at the origin that served it", async () => {
		const { aimAtConfiguredServer } = await loadFor({ remoteServer: null, hasElectronHost: false });

		await aimAtConfiguredServer();

		expect(setApiBaseUrlMock).toHaveBeenCalledWith(window.location.origin);
	});
});

describe("a launch pointed at another computer", () => {
	it("names the server before it knows the password, so the prompt is about the right machine", async () => {
		// Synchronously, before the first yield: anything that fires a request
		// during startup has to find the client already pointed somewhere.
		const { aimAtConfiguredServer, getServerTarget } = await loadFor({
			remoteServer: "http://workshop.local:3010",
			hasElectronHost: true,
		});

		const settled = aimAtConfiguredServer();

		expect(getServerTarget()).toMatchObject({
			kind: "remote",
			baseUrl: "http://workshop.local:3010",
			label: "workshop.local:3010",
			requiresAuth: true,
		});
		await settled;
	});

	it("asks for the password when none was saved", async () => {
		const { aimAtConfiguredServer, serverCredentialPrompt, getServerCredential } = await loadFor({
			remoteServer: "http://workshop.local:3010",
			hasElectronHost: true,
		});

		await aimAtConfiguredServer();

		expect(getServerCredential()).toBeNull();
		expect(serverCredentialPrompt()).toBe("missing");
	});

	it("connects without asking when the password was saved", async () => {
		readCredentialMock.mockResolvedValue("hunter2");
		const { aimAtConfiguredServer, serverCredentialPrompt, getServerCredential } = await loadFor({
			remoteServer: "http://workshop.local:3010",
			hasElectronHost: true,
		});

		await aimAtConfiguredServer();

		expect(readCredentialMock).toHaveBeenCalledWith("http://workshop.local:3010");
		expect(getServerCredential()).toBe("hunter2");
		expect(serverCredentialPrompt()).toBeNull();
	});

	it("asks for the password when the keychain will not open", async () => {
		// A locked or broken credential store is a reason to ask again, not a
		// reason to fail the launch.
		readCredentialMock.mockRejectedValue(new Error("keychain locked"));
		const { aimAtConfiguredServer, serverCredentialPrompt } = await loadFor({
			remoteServer: "http://workshop.local:3010",
			hasElectronHost: true,
		});

		await aimAtConfiguredServer();

		expect(serverCredentialPrompt()).toBe("missing");
	});

	it("does not wait for the server to answer before it resolves", async () => {
		// Blocking the launch on a handshake would leave an operator staring at
		// nothing every time the machine they saved is asleep.
		readCredentialMock.mockResolvedValue("hunter2");
		let releaseProbe = (): void => {};
		vi.stubGlobal(
			"fetch",
			vi.fn().mockReturnValue(
				new Promise<Response>((resolve) => {
					releaseProbe = () => resolve(jsonResponse(DAEMON_BODY));
				}),
			),
		);
		const { aimAtConfiguredServer, getServerCredential } = await loadFor({
			remoteServer: "http://workshop.local:3010",
			hasElectronHost: true,
		});

		await aimAtConfiguredServer();

		expect(getServerCredential()).toBe("hunter2");
		releaseProbe();
	});

	it("records the server's version once the handshake behind the first render answers", async () => {
		readCredentialMock.mockResolvedValue("hunter2");
		const { aimAtConfiguredServer } = await loadFor({
			remoteServer: "http://workshop.local:3010",
			hasElectronHost: true,
		});
		const { getServerConnection } = await import("./server-connection");

		await aimAtConfiguredServer();
		await vi.waitFor(() => expect(getServerConnection().versions.server).toBe("1.4.2"));
	});

	it("throws away a saved password the server no longer accepts", async () => {
		// Found here rather than by whichever query happened to land first,
		// which is a worse moment to discover it and a less obvious one to
		// explain.
		readCredentialMock.mockResolvedValue("stale");
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
		const { aimAtConfiguredServer, serverCredentialPrompt } = await loadFor({
			remoteServer: "http://workshop.local:3010",
			hasElectronHost: true,
		});

		await aimAtConfiguredServer();
		await vi.waitFor(() => expect(serverCredentialPrompt()).toBe("rejected"));
	});

	it("keeps a saved password when the server is merely asleep", async () => {
		// A closed laptop is not a wrong password, and making the operator
		// retype one every morning because their server was off is worse than
		// reporting the outage where outages are reported.
		readCredentialMock.mockResolvedValue("hunter2");
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
		const { aimAtConfiguredServer, serverCredentialPrompt, getServerCredential } = await loadFor({
			remoteServer: "http://workshop.local:3010",
			hasElectronHost: true,
		});

		await aimAtConfiguredServer();
		await vi.waitFor(() => expect(getServerCredential()).toBe("hunter2"));
		expect(serverCredentialPrompt()).toBeNull();
	});
});
