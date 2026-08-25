import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteModeChange, SavedServer } from "../../shared/remote-server";
import { getServerTarget, setLocalServerTarget } from "../lib/server-target";
import { resetServerConnectionForTest } from "../lib/server-connection";
import { resetRemoteServersStoreForTest, useRemoteServersStore } from "../stores/remote-servers-store";
import { ConnectServerScreen } from "./ConnectServerScreen";

/**
 * The screen is tested through `fetch` rather than by mocking the probe. The
 * whole point of the screen is that it tells apart the failures a server can
 * produce, and a mocked probe would be asserting that the component renders
 * whatever it was handed — which it obviously does. Driving it from the wire
 * shapes the daemon actually returns is what makes these cases mean something.
 */

const bridge = vi.hoisted(() => ({
	list: vi.fn(async (): Promise<SavedServer[]> => []),
	save: vi.fn(async (_input: { server: SavedServer; credential: string | null }): Promise<SavedServer[]> => []),
	remove: vi.fn(async (_baseUrl: string): Promise<SavedServer[]> => []),
	readCredential: vi.fn(async (_baseUrl: string): Promise<string | null> => null),
}));

/**
 * The rest of the host, kept mutable because `remoteServer` is what tells the
 * screen apart from itself: the same component is a first-run prompt on a
 * launch that runs its own daemon and a re-authentication prompt on a launch
 * that was pointed at someone else's, and only that field says which.
 */
const host = vi.hoisted(() => ({
	remoteServers: bridge,
	remoteServer: null as string | null,
	remoteMode: {
		get: vi.fn(async () => null),
		set: vi.fn(async (_baseUrl: string | null): Promise<RemoteModeChange> => ({
			server: null,
			relaunching: false,
			overriddenByEnv: false,
		})),
	},
}));

vi.mock("../lib/bridge", () => ({
	aoBridge: host,
	hasElectronHost: true,
}));

/** A daemon answering `/healthz` the way a real one does. */
function daemonAnswer(appVersion: string | null = "1.4.2"): Response {
	return new Response(JSON.stringify({ service: "agent-orchestrator-daemon", appVersion }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const fetchMock = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
	bridge.list.mockClear();
	bridge.save.mockClear();
	bridge.remove.mockClear();
	bridge.readCredential.mockClear();
	bridge.list.mockResolvedValue([]);
	bridge.save.mockResolvedValue([]);
	bridge.remove.mockResolvedValue([]);
	bridge.readCredential.mockResolvedValue(null);
	host.remoteServer = null;
	host.remoteMode.get.mockClear();
	host.remoteMode.set.mockClear();
	host.remoteMode.set.mockResolvedValue({ server: null, relaunching: false, overriddenByEnv: false });
	resetRemoteServersStoreForTest();
	setLocalServerTarget(null);
	resetServerConnectionForTest();
});

afterEach(() => {
	vi.unstubAllGlobals();
	resetRemoteServersStoreForTest();
	setLocalServerTarget(null);
	resetServerConnectionForTest();
});

async function fillAndSubmit(address: string, password: string) {
	const user = userEvent.setup();
	await user.clear(screen.getByLabelText("Server address"));
	await user.type(screen.getByLabelText("Server address"), address);
	await user.type(screen.getByLabelText("Password"), password);
	await user.click(screen.getByRole("button", { name: "Connect" }));
	return user;
}

describe("connecting to a server", () => {
	it("points the client at a server that answered", async () => {
		fetchMock.mockResolvedValue(daemonAnswer());
		const onConnected = vi.fn();
		render(<ConnectServerScreen onConnected={onConnected} />);

		await fillAndSubmit("box.tailnet.ts.net:3010", "hunter2");

		await waitFor(() => expect(onConnected).toHaveBeenCalledWith("http://box.tailnet.ts.net:3010"));
		expect(getServerTarget()).toMatchObject({
			kind: "remote",
			baseUrl: "http://box.tailnet.ts.net:3010",
			requiresAuth: true,
		});
	});

	it("saves the server only after the server accepted the password", async () => {
		fetchMock.mockResolvedValue(daemonAnswer());
		render(<ConnectServerScreen />);

		await fillAndSubmit("box:3010", "hunter2");

		await waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
		expect(bridge.save.mock.calls[0]?.[0]).toMatchObject({
			server: { baseUrl: "http://box:3010", label: "box:3010" },
			credential: "hunter2",
		});
	});

	it("keeps the password out of the store when the operator declines", async () => {
		fetchMock.mockResolvedValue(daemonAnswer());
		render(<ConnectServerScreen />);
		const user = userEvent.setup();
		await user.click(screen.getByRole("checkbox", { name: /remember/i }));

		await fillAndSubmit("box:3010", "hunter2");

		await waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
		// The address is still worth remembering; the password is not stored.
		expect(bridge.save.mock.calls[0]?.[0]).toMatchObject({ credential: null });
	});

	it("records the server as where the next launch should look, so this is asked once", async () => {
		fetchMock.mockResolvedValue(daemonAnswer());
		render(<ConnectServerScreen />);

		await fillAndSubmit("box:3010", "hunter2");

		await waitFor(() => expect(host.remoteMode.set).toHaveBeenCalledWith("http://box:3010"));
	});

	it("does not commit the next launch to a server this one could not reach", async () => {
		fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
		render(<ConnectServerScreen />);

		await fillAndSubmit("nowhere.invalid:3010", "hunter2");

		await screen.findByText(/Nothing answered at that address/);
		expect(host.remoteMode.set).not.toHaveBeenCalled();
	});

	// A client that was talking to somewhere else has a page loaded under a
	// content security policy naming the old server, which would block every
	// request to the new one before it left the page. The host restarts for
	// that, and the screen has to say so: the alternative is a window that goes
	// unresponsive for a moment and then disappears, which reads as a crash.
	it("says the restart is coming when the host has to come back as a different launch", async () => {
		fetchMock.mockResolvedValue(daemonAnswer());
		host.remoteMode.set.mockResolvedValue({
			server: "http://box:3010",
			relaunching: true,
			overriddenByEnv: false,
		});
		const onConnected = vi.fn();
		render(<ConnectServerScreen onConnected={onConnected} />);

		await fillAndSubmit("box:3010", "hunter2");

		await screen.findByRole("button", { name: "Restarting…" });
		// Nothing is handed back to the caller, because there is no client left
		// to hand it to: dismissing a screen over a window that is on its way
		// out would show the operator a board that is about to vanish.
		expect(onConnected).not.toHaveBeenCalled();
	});
});

/**
 * Reached deliberately from settings rather than because the client lost its
 * password. The difference is that there is a working client behind the screen,
 * which is the one thing that makes backing out of it meaningful.
 */
describe("changing servers on purpose", () => {
	it("offers a way back only when there is something to go back to", async () => {
		const onCancel = vi.fn();
		const { unmount } = render(<ConnectServerScreen onCancel={onCancel} />);
		await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
		expect(onCancel).toHaveBeenCalledTimes(1);

		unmount();
		render(<ConnectServerScreen />);
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
	});

	it("cannot be backed out of while the host is restarting into the new server", async () => {
		fetchMock.mockResolvedValue(daemonAnswer());
		host.remoteMode.set.mockResolvedValue({
			server: "http://box:3010",
			relaunching: true,
			overriddenByEnv: false,
		});
		render(<ConnectServerScreen onCancel={vi.fn()} />);

		await fillAndSubmit("box:3010", "hunter2");

		await screen.findByRole("button", { name: "Restarting…" });
		// The setting is already written and the process is already leaving.
		// A cancel here would not undo either; it would only mislead.
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
	});
});

/**
 * The way back. A launch that was pointed at a server cannot be talked into
 * spawning one here — remote mode is decided before the window exists and the
 * daemon lifecycle branches on it throughout — so the offer is to change the
 * setting and come back as a local launch.
 */
describe("going back to a daemon on this computer", () => {
	it("is offered to a launch that was pointed at a server", () => {
		host.remoteServer = "http://box:3010";
		render(<ConnectServerScreen />);

		expect(screen.getByRole("button", { name: /Use this computer instead/i })).toBeInTheDocument();
	});

	it("is not offered to a launch that already runs its own daemon", () => {
		render(<ConnectServerScreen />);

		expect(screen.queryByRole("button", { name: /Use this computer instead/i })).toBeNull();
	});

	it("clears the setting rather than stopping the server other people are using", async () => {
		host.remoteServer = "http://box:3010";
		host.remoteMode.set.mockResolvedValue({ server: null, relaunching: true, overriddenByEnv: false });
		render(<ConnectServerScreen />);
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: /Use this computer instead/i }));

		await waitFor(() => expect(host.remoteMode.set).toHaveBeenCalledWith(null));
	});

	it("says the restart is coming instead of leaving a pressed button looking idle", async () => {
		host.remoteServer = "http://box:3010";
		host.remoteMode.set.mockResolvedValue({ server: null, relaunching: true, overriddenByEnv: false });
		render(<ConnectServerScreen />);
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: /Use this computer instead/i }));

		await waitFor(() => expect(screen.getByRole("button", { name: /restarting/i })).toBeDisabled());
	});

	it("admits when an environment variable will decide the next launch anyway", async () => {
		// Otherwise the operator presses the button, the setting is cleared, the
		// app comes back attached to the same server, and nothing on screen ever
		// explained why.
		host.remoteServer = "http://box:3010";
		host.remoteMode.set.mockResolvedValue({ server: null, relaunching: false, overriddenByEnv: true });
		render(<ConnectServerScreen />);
		const user = userEvent.setup();

		await user.click(screen.getByRole("button", { name: /Use this computer instead/i }));

		await waitFor(() => expect(screen.getByText(/AO_REMOTE_SERVER/)).toBeInTheDocument());
	});
});

describe("when nothing answers at the address", () => {
	it("says the address did not answer, not that the password was wrong", async () => {
		fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
		render(<ConnectServerScreen />);

		await fillAndSubmit("nowhere.invalid:3010", "hunter2");

		expect(await screen.findByText(/Nothing answered at that address/)).toBeInTheDocument();
		expect(screen.queryByText(/rejected that password/)).not.toBeInTheDocument();
	});

	it("leaves the address in the field so the operator can fix one character", async () => {
		fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
		render(<ConnectServerScreen />);

		const user = await fillAndSubmit("boxx.tailnet.ts.net:3010", "hunter2");
		await screen.findByText(/Nothing answered at that address/);

		const address = screen.getByLabelText("Server address") as HTMLInputElement;
		expect(address.value).toBe("boxx.tailnet.ts.net:3010");
		expect(address).not.toBeDisabled();

		// And the correction goes through without retyping the rest of it.
		fetchMock.mockResolvedValue(daemonAnswer());
		await user.clear(address);
		await user.type(address, "box.tailnet.ts.net:3010");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		await waitFor(() => expect(getServerTarget().baseUrl).toBe("http://box.tailnet.ts.net:3010"));
	});

	it("leaves the client pointed where it already was", async () => {
		setLocalServerTarget("http://127.0.0.1:3001");
		fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
		render(<ConnectServerScreen />);

		await fillAndSubmit("nowhere.invalid:3010", "hunter2");
		await screen.findByText(/Nothing answered at that address/);

		expect(getServerTarget()).toMatchObject({ kind: "local", baseUrl: "http://127.0.0.1:3001" });
	});

	it("does not remember a server it could not reach", async () => {
		fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
		render(<ConnectServerScreen />);

		await fillAndSubmit("nowhere.invalid:3010", "hunter2");
		await screen.findByText(/Nothing answered at that address/);

		expect(bridge.save).not.toHaveBeenCalled();
	});
});

describe("when the server rejects the password", () => {
	it("says the password was rejected, not that the server was unreachable", async () => {
		fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
		render(<ConnectServerScreen />);

		await fillAndSubmit("box:3010", "wrong");

		expect(await screen.findByText("The server rejected that password.")).toBeInTheDocument();
		expect(screen.queryByText(/Nothing answered/)).not.toBeInTheDocument();
	});

	it("keeps the address that was right and lets the password be retyped", async () => {
		fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
		render(<ConnectServerScreen />);

		const user = await fillAndSubmit("box:3010", "wrong");
		await screen.findByText("The server rejected that password.");

		expect((screen.getByLabelText("Server address") as HTMLInputElement).value).toBe("box:3010");

		fetchMock.mockResolvedValue(daemonAnswer());
		await user.type(screen.getByLabelText("Password"), "-right");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		await waitFor(() => expect(getServerTarget().baseUrl).toBe("http://box:3010"));
	});

	it("replaces the previous message rather than stacking a second one", async () => {
		fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
		render(<ConnectServerScreen />);

		const user = await fillAndSubmit("box:3010", "wrong");
		await screen.findByText("The server rejected that password.");

		fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
		await user.click(screen.getByRole("button", { name: "Connect" }));

		await screen.findByText(/Nothing answered at that address/);
		expect(screen.queryByText("The server rejected that password.")).not.toBeInTheDocument();
	});

	it("separates a lockout from a rejection, because waiting is the fix", async () => {
		fetchMock.mockResolvedValue(new Response("too many requests", { status: 429 }));
		render(<ConnectServerScreen />);

		await fillAndSubmit("box:3010", "wrong");

		expect(await screen.findByText(/Too many failed attempts/)).toBeInTheDocument();
	});

	it("calls a non-daemon answer what it is", async () => {
		fetchMock.mockResolvedValue(
			new Response("<html>router admin</html>", { status: 200, headers: { "content-type": "text/html" } }),
		);
		render(<ConnectServerScreen />);

		await fillAndSubmit("192.168.1.1:80", "hunter2");

		expect(await screen.findByText(/not an Agent Orchestrator server/)).toBeInTheDocument();
	});
});

describe("an address that cannot be one", () => {
	it("says so without pretending a request was made", async () => {
		render(<ConnectServerScreen />);

		await fillAndSubmit("   ", "hunter2");

		expect(await screen.findByText(/cannot use that address/)).toBeInTheDocument();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("clears the complaint as soon as the address is edited", async () => {
		render(<ConnectServerScreen />);
		const user = await fillAndSubmit("   ", "hunter2");
		await screen.findByText(/cannot use that address/);

		await user.type(screen.getByLabelText("Server address"), "box:3010");

		expect(screen.queryByText(/cannot use that address/)).not.toBeInTheDocument();
	});
});

describe("saved servers", () => {
	const saved: SavedServer[] = [
		{ baseUrl: "http://box:3010", label: "box:3010", lastConnectedAt: "2026-08-01T10:00:00.000Z" },
		{ baseUrl: "http://laptop:3010", label: "laptop:3010", lastConnectedAt: null },
	];

	it("offers what the host remembers", async () => {
		bridge.list.mockResolvedValue(saved);
		render(<ConnectServerScreen />);

		expect(await screen.findByRole("button", { name: "box:3010" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "laptop:3010" })).toBeInTheDocument();
	});

	it("fills the form from a saved server without connecting for the operator", async () => {
		bridge.list.mockResolvedValue(saved);
		bridge.readCredential.mockResolvedValue("hunter2");
		render(<ConnectServerScreen />);
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "box:3010" }));

		await waitFor(() =>
			expect((screen.getByLabelText("Server address") as HTMLInputElement).value).toBe("http://box:3010"),
		);
		expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("hunter2");
		// A saved server that has moved or changed its password would otherwise
		// fail with no visible cause between the click and the error.
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("forgets a server, and its password with it", async () => {
		bridge.list.mockResolvedValue(saved);
		bridge.remove.mockResolvedValue(saved.slice(1));
		render(<ConnectServerScreen />);
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "Forget box:3010" }));

		await waitFor(() => expect(bridge.remove).toHaveBeenCalledWith("http://box:3010"));
		await waitFor(() => expect(screen.queryByRole("button", { name: "box:3010" })).not.toBeInTheDocument());
	});

	it("shows no list at all on a host that remembers nothing", async () => {
		render(<ConnectServerScreen />);

		await waitFor(() => expect(useRemoteServersStore.getState().loaded).toBe(true));
		expect(screen.queryByText("Saved servers")).not.toBeInTheDocument();
		// Still perfectly usable — the operator types an address every launch.
		expect(screen.getByLabelText("Server address")).toBeInTheDocument();
	});

	it("stays usable when the host cannot read its own store", async () => {
		bridge.list.mockRejectedValue(new Error("keychain locked"));
		fetchMock.mockResolvedValue(daemonAnswer());
		render(<ConnectServerScreen />);

		await waitFor(() => expect(useRemoteServersStore.getState().failed).toBe(true));
		await fillAndSubmit("box:3010", "hunter2");

		await waitFor(() => expect(getServerTarget().baseUrl).toBe("http://box:3010"));
	});
});

describe("the reason the screen appeared", () => {
	it("starts by saying the password was refused when that is why", () => {
		render(<ConnectServerScreen initialAddress="http://box:3010" initialProblem={{ outcome: "rejected" }} />);

		expect(screen.getByText("The server rejected that password.")).toBeInTheDocument();
		expect((screen.getByLabelText("Server address") as HTMLInputElement).value).toBe("http://box:3010");
	});

	it("says nothing on a first launch, where nothing has failed", () => {
		render(<ConnectServerScreen initialAddress="http://box:3010" />);

		expect(screen.queryByText("The server rejected that password.")).not.toBeInTheDocument();
	});
});
