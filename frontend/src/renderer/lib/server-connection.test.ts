import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEventsConnectionState } from "./events-connection";
import {
	getServerConnection,
	resetServerConnectionForTest,
	setClientVersion,
	setServerVersion,
	subscribeServerConnection,
} from "./server-connection";
import { clearServerCredential, setLocalServerTarget, setRemoteServerTarget } from "./server-target";

beforeEach(() => {
	setLocalServerTarget(null);
	setEventsConnectionState("idle");
	resetServerConnectionForTest();
});

afterEach(() => {
	setLocalServerTarget(null);
	setEventsConnectionState("idle");
	resetServerConnectionForTest();
});

describe("server connection state", () => {
	it("has no link when no server is trusted yet", () => {
		expect(getServerConnection()).toMatchObject({ kind: "local", baseUrl: null, state: "none" });
	});

	it("is unknown, not broken, between choosing a server and the stream opening", () => {
		// Reporting a problem during the gap would make every launch look like
		// an outage.
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "x" });
		expect(getServerConnection().state).toBe("unknown");
	});

	it("is connected once the change stream is open", () => {
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "x" });
		setEventsConnectionState("connected");
		expect(getServerConnection().state).toBe("connected");
	});

	it("reports reconnecting when the stream drops", () => {
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "x" });
		setEventsConnectionState("connected");
		setEventsConnectionState("disconnected");

		expect(getServerConnection()).toMatchObject({
			kind: "remote",
			label: "box:3010",
			state: "reconnecting",
		});
	});

	it("does not claim to be reconnecting to a server it has left", () => {
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "x" });
		setEventsConnectionState("disconnected");
		setLocalServerTarget(null);

		// A dropped stream against a server we are no longer pointed at is not a
		// connection anyone is trying to make.
		expect(getServerConnection().state).toBe("none");
	});

	it("carries the server label so the indicator names a specific machine", () => {
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "Closet server", credential: "x" });
		expect(getServerConnection().label).toBe("Closet server");
	});

	it("notifies subscribers when the link changes", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeServerConnection(listener);

		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "x" });
		expect(listener).toHaveBeenCalled();

		unsubscribe();
		listener.mockClear();
		setEventsConnectionState("connected");
		expect(listener).not.toHaveBeenCalled();
	});

	it("hands back the same snapshot object when nothing changed", () => {
		// useSyncExternalStore compares by identity; a fresh object every read
		// is an infinite render loop.
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "x" });
		const first = getServerConnection();
		setEventsConnectionState("idle");
		expect(getServerConnection()).toBe(first);
	});
});

describe("asking the operator for a password", () => {
	it("wants nothing from a daemon that authenticates nothing", () => {
		setLocalServerTarget("http://127.0.0.1:3001");
		expect(getServerConnection().credentialPrompt).toBeNull();
	});

	it("wants nothing while the password we hold is still good", () => {
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "x" });
		expect(getServerConnection().credentialPrompt).toBeNull();
	});

	it("asks for a correction once the server has refused one", () => {
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "wrong" });
		clearServerCredential();

		expect(getServerConnection().credentialPrompt).toBe("rejected");
		// The address is not the mistake, so it stays for the prompt to fill in.
		expect(getServerConnection().baseUrl).toBe("http://box:3010");
	});

	it("stops asking once a password is accepted", () => {
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "wrong" });
		clearServerCredential();
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "right" });

		expect(getServerConnection().credentialPrompt).toBeNull();
	});

	it("does not carry one server's rejection to the next server", () => {
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "wrong" });
		clearServerCredential();
		setRemoteServerTarget({ baseUrl: "http://other:3010", label: "other:3010", credential: "x" });
		clearServerCredential();
		setRemoteServerTarget({ baseUrl: "http://other:3010", label: "other:3010", credential: "x" });

		expect(getServerConnection().credentialPrompt).toBeNull();
	});

	it("notifies subscribers when the password stops being good", () => {
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "wrong" });
		const listener = vi.fn();
		const unsubscribe = subscribeServerConnection(listener);

		clearServerCredential();

		expect(listener).toHaveBeenCalled();
		unsubscribe();
	});
});

describe("version handshake", () => {
	it("says nothing until both sides have reported", () => {
		setServerVersion("1.4.2");
		expect(getServerConnection().versions).toEqual({ status: "unknown", client: null, server: "1.4.2" });
	});

	it("reports a mismatch with both versions", () => {
		setClientVersion("1.4.2");
		setServerVersion("1.3.9");

		expect(getServerConnection().versions).toEqual({
			status: "mismatch",
			client: "1.4.2",
			server: "1.3.9",
		});
	});

	it("reports a match when the two halves came from the same release", () => {
		setClientVersion("1.4.2");
		setServerVersion("1.4.2");
		expect(getServerConnection().versions.status).toBe("match");
	});

	it("forgets the server version when the client is pointed somewhere else", () => {
		setClientVersion("1.4.2");
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "x" });
		setServerVersion("1.3.9");
		expect(getServerConnection().versions.status).toBe("mismatch");

		setRemoteServerTarget({ baseUrl: "http://other:3010", label: "other:3010", credential: "x" });

		// The version we held belonged to the machine we left; warning about it
		// against a different one is a warning about nothing.
		expect(getServerConnection().versions).toEqual({
			status: "unknown",
			client: "1.4.2",
			server: null,
		});
	});

	it("keeps the server version across a stream drop and recovery", () => {
		setClientVersion("1.4.2");
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "x" });
		setServerVersion("1.3.9");

		setEventsConnectionState("connected");
		setEventsConnectionState("disconnected");
		setEventsConnectionState("connected");

		// The server did not change, so the handshake answer still holds.
		expect(getServerConnection().versions.status).toBe("mismatch");
	});
});
