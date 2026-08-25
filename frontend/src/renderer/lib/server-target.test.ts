import { afterEach, describe, expect, it, vi } from "vitest";
import {
	LOCAL_SERVER_LABEL,
	clearServerCredential,
	getServerCredential,
	getServerTarget,
	serverIsLocal,
	setLocalServerTarget,
	setRemoteServerTarget,
	subscribeServerTarget,
} from "./server-target";

afterEach(() => {
	setLocalServerTarget("http://127.0.0.1:3001");
});

describe("server target", () => {
	it("starts untrusted, with no server and no credential", () => {
		setLocalServerTarget(null);

		expect(getServerTarget()).toEqual({ baseUrl: null, kind: "local", label: LOCAL_SERVER_LABEL, requiresAuth: false });
		expect(getServerCredential()).toBeNull();
	});

	it("strips trailing slashes so the base URL concatenates predictably", () => {
		setLocalServerTarget("http://127.0.0.1:3037//");

		expect(getServerTarget().baseUrl).toBe("http://127.0.0.1:3037");
	});

	it("carries a label and a credential for a remote target", () => {
		setRemoteServerTarget({ baseUrl: "http://desk.local:3001/", label: "Desk", credential: "hunter2" });

		expect(getServerTarget()).toEqual({ baseUrl: "http://desk.local:3001", kind: "remote", label: "Desk", requiresAuth: true });
		expect(getServerCredential()).toBe("hunter2");
	});

	it("withholds the credential from a server that authenticates nothing", () => {
		// Not a matter of whether one is held: the local daemon listens on
		// loopback and asks for nothing, so sending it a password would be
		// spending a credential on a server with no use for it.
		setRemoteServerTarget({ baseUrl: "http://desk.local:3001", label: "Desk", credential: "hunter2" });
		setLocalServerTarget("http://127.0.0.1:3001");

		expect(getServerCredential()).toBeNull();
	});

	it("notifies subscribers on every change and stops after unsubscribe", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeServerTarget(listener);

		setLocalServerTarget("http://127.0.0.1:3037");
		setRemoteServerTarget({ baseUrl: "http://desk.local:3001", label: "Desk", credential: "hunter2" });
		expect(listener).toHaveBeenCalledTimes(2);

		unsubscribe();
		setLocalServerTarget("http://127.0.0.1:3001");
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("stays quiet when the target is set to what it already is", () => {
		setLocalServerTarget("http://127.0.0.1:3037");
		const listener = vi.fn();
		subscribeServerTarget(listener);

		setLocalServerTarget("http://127.0.0.1:3037");

		expect(listener).not.toHaveBeenCalled();
	});

	it("drops the credential on clear but keeps the address", () => {
		// What a 401 means: the address is right and the password is not. Keeping
		// the target is what lets the operator be asked for a password rather
		// than for an address they already gave.
		setRemoteServerTarget({ baseUrl: "http://desk.local:3001", label: "Desk", credential: "hunter2" });
		const listener = vi.fn();
		subscribeServerTarget(listener);

		clearServerCredential();

		expect(getServerCredential()).toBeNull();
		expect(getServerTarget()).toEqual({ baseUrl: "http://desk.local:3001", kind: "remote", label: "Desk", requiresAuth: true });
		expect(listener).toHaveBeenCalledTimes(1);

		clearServerCredential();
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("reports where the server's filesystem is, which is not the same question as how it authenticates", () => {
		setLocalServerTarget("http://127.0.0.1:3001");
		expect(serverIsLocal()).toBe(true);

		setRemoteServerTarget({ baseUrl: "http://desk.local:3001", label: "Desk", credential: "hunter2" });
		expect(serverIsLocal()).toBe(false);

		// Losing the credential does not bring the files back to this disk. The
		// capability gate reads `kind` rather than anything about authentication
		// for exactly that reason: one describes how the server checks who is
		// asking, the other where its filesystem is.
		clearServerCredential();
		expect(getServerCredential()).toBeNull();
		expect(serverIsLocal()).toBe(false);
	});
});
