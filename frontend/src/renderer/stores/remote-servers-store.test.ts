import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedServer } from "../../shared/remote-server";

const list = vi.fn();
const save = vi.fn();
const remove = vi.fn();
const readCredential = vi.fn();

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		remoteServers: {
			list: (...args: unknown[]) => list(...args),
			save: (...args: unknown[]) => save(...args),
			remove: (...args: unknown[]) => remove(...args),
			readCredential: (...args: unknown[]) => readCredential(...args),
		},
	},
}));

import { resetRemoteServersStoreForTest, useRemoteServersStore } from "./remote-servers-store";

const box: SavedServer = { baseUrl: "http://box:3010", label: "box", lastConnectedAt: "2026-08-01T00:00:00.000Z" };
const shed: SavedServer = { baseUrl: "http://shed:3010", label: "shed", lastConnectedAt: null };

/**
 * A host that keeps what it is given, the way the desktop app's main process
 * does. The store cannot see the keychain from here, so what is under test is
 * that it asks, keeps what comes back, and takes the host's word for the list
 * rather than editing its own copy.
 */
function hostThatRemembers(): void {
	const servers = new Map<string, SavedServer>();
	const credentials = new Map<string, string>();
	list.mockImplementation(async () => [...servers.values()]);
	save.mockImplementation(async ({ server, credential }: { server: SavedServer; credential: string | null }) => {
		servers.set(server.baseUrl, server);
		if (credential !== null) credentials.set(server.baseUrl, credential);
		return [...servers.values()];
	});
	remove.mockImplementation(async (baseUrl: string) => {
		servers.delete(baseUrl);
		credentials.delete(baseUrl);
		return [...servers.values()];
	});
	readCredential.mockImplementation(async (baseUrl: string) => credentials.get(baseUrl) ?? null);
}

/** A browser tab, which has nowhere to put any of this and says so. */
function hostThatRemembersNothing(): void {
	list.mockResolvedValue([]);
	save.mockResolvedValue([]);
	remove.mockResolvedValue([]);
	readCredential.mockResolvedValue(null);
}

beforeEach(() => {
	list.mockReset();
	save.mockReset();
	remove.mockReset();
	readCredential.mockReset();
	resetRemoteServersStoreForTest();
});

describe("on a host that can persist", () => {
	beforeEach(hostThatRemembers);

	it("shows the servers the host is holding", async () => {
		await useRemoteServersStore.getState().save(box, "hunter2");
		resetRemoteServersStoreForTest();

		await useRemoteServersStore.getState().load();

		expect(useRemoteServersStore.getState().servers).toEqual([box]);
	});

	it("hands back the password so the operator is not asked for it again", async () => {
		await useRemoteServersStore.getState().save(box, "hunter2");

		await expect(useRemoteServersStore.getState().credentialFor(box.baseUrl)).resolves.toBe("hunter2");
	});

	it("puts the server the operator actually uses first", async () => {
		await useRemoteServersStore.getState().save(shed, null);
		await useRemoteServersStore.getState().save(box, "hunter2");

		// The host returns insertion order; ordering is the store's job.
		expect(useRemoteServersStore.getState().servers.map((server) => server.baseUrl)).toEqual([
			box.baseUrl,
			shed.baseUrl,
		]);
	});

	it("takes the password with the server when the operator removes it", async () => {
		await useRemoteServersStore.getState().save(box, "hunter2");

		await useRemoteServersStore.getState().remove(box.baseUrl);

		expect(useRemoteServersStore.getState().servers).toEqual([]);
		await expect(useRemoteServersStore.getState().credentialFor(box.baseUrl)).resolves.toBeNull();
	});

	it("reads once when two screens mount in the same tick", async () => {
		const store = useRemoteServersStore.getState();

		await Promise.all([store.load(), store.load()]);

		expect(list).toHaveBeenCalledTimes(1);
	});

	it("reports a keychain that will not open without losing the list", async () => {
		readCredential.mockRejectedValue(new Error("keychain locked"));
		await useRemoteServersStore.getState().save(box, "hunter2");

		await expect(useRemoteServersStore.getState().credentialFor(box.baseUrl)).resolves.toBeNull();

		// A password the client cannot read means retyping it, not losing the
		// server it belongs to.
		expect(useRemoteServersStore.getState().failed).toBe(true);
		expect(useRemoteServersStore.getState().servers).toEqual([box]);
	});
});

describe("on a host that persists nothing", () => {
	beforeEach(hostThatRemembersNothing);

	it("stays empty and usable rather than treating it as a failure", async () => {
		await useRemoteServersStore.getState().load();

		expect(useRemoteServersStore.getState().loaded).toBe(true);
		expect(useRemoteServersStore.getState().failed).toBe(false);
		expect(useRemoteServersStore.getState().servers).toEqual([]);
	});

	it("accepts a save that the host quietly drops", async () => {
		// The browser client still calls save on a successful connection. Nothing
		// is kept, and the operator gets an empty list next launch — which is the
		// honest outcome, not an error to surface.
		await useRemoteServersStore.getState().save(box, "hunter2");

		expect(useRemoteServersStore.getState().servers).toEqual([]);
		expect(useRemoteServersStore.getState().failed).toBe(false);
		await expect(useRemoteServersStore.getState().credentialFor(box.baseUrl)).resolves.toBeNull();
	});
});
