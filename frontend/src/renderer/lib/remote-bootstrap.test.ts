import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readCredentialMock, setApiBaseUrlMock, replaceLocationMock } = vi.hoisted(() => ({
	readCredentialMock: vi.fn(),
	setApiBaseUrlMock: vi.fn(),
	replaceLocationMock: vi.fn(),
}));

/**
 * The bootstrap's whole job is to decide where the client points, and the two
 * things that decide it are host facts fixed at module load: the address on the
 * launch arguments, and whether there is an Electron host at all. So each case
 * loads the module against the host it is about, rather than toggling one.
 */
async function loadFor(host: { remoteServer: string | null; hasElectronHost: boolean; webClient?: boolean }) {
	vi.resetModules();
	// The one host fact the build decides rather than the launch: whether this
	// bundle is the one a daemon serves at /app/, which has a credential waiting
	// for it, or the one vite's dev server serves, which does not.
	vi.stubEnv("VITE_AO_WEB_CLIENT", host.webClient ? "1" : "");
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
	// `window.location` is unforgeable, so leaving the page is reachable only
	// through the module that wraps it. That is the module's entire reason to
	// exist; see lib/navigate.ts.
	vi.doMock("./navigate", () => ({ replaceLocation: replaceLocationMock }));
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
	replaceLocationMock.mockReset();
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(DAEMON_BODY)));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	window.sessionStorage.clear();
	vi.doUnmock("./bridge");
	vi.doUnmock("./api-client");
	vi.doUnmock("./navigate");
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

	it("presents no credential, because the dev proxy fronts a daemon that wants none", async () => {
		// `npm run dev:web` and the daemon-served bundle are the same code in the
		// same shape of browser, and only the build distinguishes them. Aiming
		// the dev build at a credentialed target would make it demand a password
		// for a loopback daemon that has none to check.
		const { aimAtConfiguredServer, getServerTarget } = await loadFor({
			remoteServer: null,
			hasElectronHost: false,
		});

		await aimAtConfiguredServer();

		expect(getServerTarget().kind).toBe("local");
	});
});

describe("a tab the daemon served itself", () => {
	it("uses the credential its login page left behind", async () => {
		window.sessionStorage.setItem("ao.remote.token", "hunter2");
		const { aimAtConfiguredServer, getServerTarget, getServerCredential, serverCredentialPrompt } = await loadFor({
			remoteServer: null,
			hasElectronHost: false,
			webClient: true,
		});

		await aimAtConfiguredServer();

		// Remote, though the daemon is at this tab's own origin: "remote" here
		// means a daemon this client did not start, which is what keeps the
		// host-bound features withdrawn and readiness answered by the server.
		expect(getServerTarget()).toMatchObject({
			kind: "remote",
			baseUrl: window.location.origin,
			requiresAuth: true,
		});
		expect(getServerCredential()).toBe("hunter2");
		expect(serverCredentialPrompt()).toBeNull();
	});

	it("takes the server's version from the exchange rather than repeating the handshake", async () => {
		window.sessionStorage.setItem("ao.remote.token", "hunter2");
		window.sessionStorage.setItem("ao.remote.serverVersion", "1.4.2");
		const { aimAtConfiguredServer } = await loadFor({
			remoteServer: null,
			hasElectronHost: false,
			webClient: true,
		});
		const { getServerConnection } = await import("./server-connection");

		await aimAtConfiguredServer();

		expect(getServerConnection().versions.server).toBe("1.4.2");
	});

	it("reports the version as unknown when the daemon was launched by no app", async () => {
		// A daemon started from the CLI has no app version to report, and the
		// login page stores the empty string it got back. Comparing that against
		// a real client version would warn about a mismatch that is not one.
		window.sessionStorage.setItem("ao.remote.token", "hunter2");
		window.sessionStorage.setItem("ao.remote.serverVersion", "");
		const { aimAtConfiguredServer } = await loadFor({
			remoteServer: null,
			hasElectronHost: false,
			webClient: true,
		});
		const { getServerConnection } = await import("./server-connection");

		await aimAtConfiguredServer();

		expect(getServerConnection().versions.server).toBeNull();
	});

	it("goes back to the login page when the tab has no session of its own", async () => {
		// The ordinary state of a second tab: the asset cookie belongs to the
		// browser, so the app loads, but the token belongs to the tab that
		// exchanged the password and this one has none.
		const { aimAtConfiguredServer, getServerCredential } = await loadFor({
			remoteServer: null,
			hasElectronHost: false,
			webClient: true,
		});

		await aimAtConfiguredServer();

		expect(replaceLocationMock).toHaveBeenCalledWith("/");
		expect(getServerCredential()).toBeNull();
	});

	it("treats a storage that throws as no session rather than failing the launch", async () => {
		// Safari's private mode and some enterprise policies make this property
		// access raise. The recovery for "no session" is the right one either way.
		vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
			throw new Error("access denied");
		});
		const { aimAtConfiguredServer } = await loadFor({
			remoteServer: null,
			hasElectronHost: false,
			webClient: true,
		});

		await expect(aimAtConfiguredServer()).resolves.toBeUndefined();
		expect(replaceLocationMock).toHaveBeenCalledWith("/");
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
