import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	encryptionAvailable: true,
	selectedStorageBackend: "gnome_libsecret",
	// A reversible stand-in for the OS keychain: the tests care that the bytes
	// on disk are not the password, not about the cipher.
	decryptString: vi.fn((value: Buffer) => Buffer.from(value.toString("utf8"), "base64").toString("utf8")),
	encryptString: vi.fn((value: string) => Buffer.from(Buffer.from(value, "utf8").toString("base64"), "utf8")),
}));

vi.mock("electron", () => ({
	safeStorage: {
		decryptString: mocks.decryptString,
		encryptString: mocks.encryptString,
		getSelectedStorageBackend: () => mocks.selectedStorageBackend,
		isEncryptionAvailable: () => mocks.encryptionAvailable,
	},
}));

import {
	listRemoteServers,
	readRemoteCredential,
	REMOTE_CREDENTIALS_FILE_NAME,
	REMOTE_SERVERS_FILE_NAME,
	removeRemoteServer,
	resetRemoteCredentialMemoryForTest,
	saveRemoteServer,
} from "./remote-servers";
import type { SavedServer } from "../shared/remote-server";

function server(baseUrl: string, lastConnectedAt: string, label = baseUrl): SavedServer {
	return { baseUrl, label, lastConnectedAt };
}

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

let stateDir: string;

beforeEach(async () => {
	vi.clearAllMocks();
	mocks.encryptionAvailable = true;
	mocks.selectedStorageBackend = "gnome_libsecret";
	resetRemoteCredentialMemoryForTest();
	stateDir = await mkdtemp(path.join(os.tmpdir(), "ao-remote-servers-"));
});

afterEach(async () => {
	resetRemoteCredentialMemoryForTest();
	await rm(stateDir, { recursive: true, force: true });
});

describe("the saved server list", () => {
	it("is empty before anything has been saved", async () => {
		await expect(listRemoteServers(stateDir)).resolves.toEqual([]);
	});

	it("keeps an address and its label, and reads them back", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-05T10:00:00.000Z", "Closet server"),
			credential: "hunter2",
		});

		await expect(listRemoteServers(stateDir)).resolves.toEqual([
			{ baseUrl: "http://box:3010", label: "Closet server", lastConnectedAt: "2026-01-05T10:00:00.000Z" },
		]);
	});

	it("lists the most recently connected server first", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://old:3010", "2026-01-01T00:00:00.000Z"),
			credential: null,
		});
		await saveRemoteServer(stateDir, {
			server: server("http://new:3010", "2026-02-01T00:00:00.000Z"),
			credential: null,
		});

		const servers = await listRemoteServers(stateDir);
		expect(servers.map((entry) => entry.baseUrl)).toEqual(["http://new:3010", "http://old:3010"]);
	});

	it("updates an existing entry rather than adding a second one", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-01T00:00:00.000Z", "Old name"),
			credential: null,
		});
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-02-01T00:00:00.000Z", "New name"),
			credential: null,
		});

		await expect(listRemoteServers(stateDir)).resolves.toEqual([
			{ baseUrl: "http://box:3010", label: "New name", lastConnectedAt: "2026-02-01T00:00:00.000Z" },
		]);
	});

	it("stays readable on disk so an operator can see what the client will try", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-05T10:00:00.000Z"),
			credential: "hunter2",
		});

		const raw = await readFile(path.join(stateDir, REMOTE_SERVERS_FILE_NAME), "utf8");
		expect(JSON.parse(raw)).toEqual([
			{ baseUrl: "http://box:3010", label: "http://box:3010", lastConnectedAt: "2026-01-05T10:00:00.000Z" },
		]);
		// The address file is not a secret, but it must not become one by
		// accident either.
		expect(raw).not.toContain("hunter2");
	});

	it("survives a hand-edited file that no longer parses", async () => {
		await writeFile(path.join(stateDir, REMOTE_SERVERS_FILE_NAME), "{ not json", "utf8");
		// Losing the list costs an operator one retyped address; refusing to
		// start costs them the application.
		await expect(listRemoteServers(stateDir)).resolves.toEqual([]);
	});

	it("drops one malformed row rather than the whole list", async () => {
		await writeFile(
			path.join(stateDir, REMOTE_SERVERS_FILE_NAME),
			JSON.stringify([
				{ baseUrl: "http://good:3010", label: "good", lastConnectedAt: "2026-01-01T00:00:00.000Z" },
				{ label: "no address" },
				"not an object",
			]),
			"utf8",
		);

		const servers = await listRemoteServers(stateDir);
		expect(servers.map((entry) => entry.baseUrl)).toEqual(["http://good:3010"]);
	});
});

describe("connection passwords", () => {
	it("reads back the password saved with a server", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-05T10:00:00.000Z"),
			credential: "hunter2",
		});

		await expect(readRemoteCredential(stateDir, "http://box:3010")).resolves.toBe("hunter2");
	});

	it("holds nothing for a server saved without one", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-05T10:00:00.000Z"),
			credential: null,
		});

		await expect(readRemoteCredential(stateDir, "http://box:3010")).resolves.toBeNull();
	});

	it("keeps each server's password apart", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://a:3010", "2026-01-01T00:00:00.000Z"),
			credential: "aaa",
		});
		await saveRemoteServer(stateDir, {
			server: server("http://b:3010", "2026-01-02T00:00:00.000Z"),
			credential: "bbb",
		});

		await expect(readRemoteCredential(stateDir, "http://a:3010")).resolves.toBe("aaa");
		await expect(readRemoteCredential(stateDir, "http://b:3010")).resolves.toBe("bbb");
	});

	it("never writes a password to disk in the clear", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-05T10:00:00.000Z"),
			credential: "hunter2",
		});

		const bytes = await readFile(path.join(stateDir, REMOTE_CREDENTIALS_FILE_NAME));
		expect(bytes.toString("utf8")).not.toContain("hunter2");
		expect(mocks.encryptString).toHaveBeenCalledWith(expect.stringContaining("hunter2"));
	});

	it("replaces the password when a server is saved again", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-01T00:00:00.000Z"),
			credential: "old",
		});
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-02T00:00:00.000Z"),
			credential: "new",
		});

		await expect(readRemoteCredential(stateDir, "http://box:3010")).resolves.toBe("new");
	});

	it("leaves the stored password alone when a server is saved without one", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-01T00:00:00.000Z"),
			credential: "hunter2",
		});
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-02T00:00:00.000Z"),
			credential: null,
		});

		// Null means "nothing new to record", not "forget what you had". Only
		// removing the server forgets a password.
		await expect(readRemoteCredential(stateDir, "http://box:3010")).resolves.toBe("hunter2");
	});

	it("recovers from a credential file that will never decrypt again", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-05T10:00:00.000Z"),
			credential: "hunter2",
		});
		mocks.decryptString.mockImplementationOnce(() => {
			throw new Error("wrong keychain identity");
		});

		await expect(readRemoteCredential(stateDir, "http://box:3010")).resolves.toBeNull();
		// Removed rather than left in place, so the next read is not the same
		// failure forever.
		expect(await exists(path.join(stateDir, REMOTE_CREDENTIALS_FILE_NAME))).toBe(false);
		// The list of servers is a separate file and is not collateral.
		await expect(listRemoteServers(stateDir)).resolves.toHaveLength(1);
	});
});

describe("forgetting a server", () => {
	it("removes the entry and its password together", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-05T10:00:00.000Z"),
			credential: "hunter2",
		});

		await expect(removeRemoteServer(stateDir, "http://box:3010")).resolves.toEqual([]);
		// Leaving the password behind would put it beyond the reach of anything
		// in the interface that could delete it.
		await expect(readRemoteCredential(stateDir, "http://box:3010")).resolves.toBeNull();
	});

	it("leaves other servers and their passwords alone", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://a:3010", "2026-01-01T00:00:00.000Z"),
			credential: "aaa",
		});
		await saveRemoteServer(stateDir, {
			server: server("http://b:3010", "2026-01-02T00:00:00.000Z"),
			credential: "bbb",
		});

		await removeRemoteServer(stateDir, "http://a:3010");

		await expect(listRemoteServers(stateDir)).resolves.toHaveLength(1);
		await expect(readRemoteCredential(stateDir, "http://b:3010")).resolves.toBe("bbb");
	});

	it("is quiet about a server that was never saved", async () => {
		await expect(removeRemoteServer(stateDir, "http://nothing:3010")).resolves.toEqual([]);
	});
});

describe("a machine with no protected storage", () => {
	beforeEach(() => {
		mocks.encryptionAvailable = false;
	});

	it("keeps the server list, which is not a secret", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-05T10:00:00.000Z"),
			credential: "hunter2",
		});

		await expect(listRemoteServers(stateDir)).resolves.toHaveLength(1);
	});

	it("holds the password for this process only, and writes no file", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-05T10:00:00.000Z"),
			credential: "hunter2",
		});

		await expect(readRemoteCredential(stateDir, "http://box:3010")).resolves.toBe("hunter2");
		expect(await exists(path.join(stateDir, REMOTE_CREDENTIALS_FILE_NAME))).toBe(false);
		expect(mocks.encryptString).not.toHaveBeenCalled();
	});

	it("loses the password on restart, and only the password", async () => {
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-05T10:00:00.000Z"),
			credential: "hunter2",
		});

		resetRemoteCredentialMemoryForTest();

		await expect(readRemoteCredential(stateDir, "http://box:3010")).resolves.toBeNull();
		await expect(listRemoteServers(stateDir)).resolves.toHaveLength(1);
	});

	it("treats Linux basic_text as no protection at all", async () => {
		// It encrypts with a hardcoded password, which is obfuscation.
		mocks.encryptionAvailable = true;
		mocks.selectedStorageBackend = "basic_text";
		const platform = process.platform;
		Object.defineProperty(process, "platform", { value: "linux", configurable: true });
		try {
			await saveRemoteServer(stateDir, {
				server: server("http://box:3010", "2026-01-05T10:00:00.000Z"),
				credential: "hunter2",
			});
			expect(mocks.encryptString).not.toHaveBeenCalled();
			expect(await exists(path.join(stateDir, REMOTE_CREDENTIALS_FILE_NAME))).toBe(false);
		} finally {
			Object.defineProperty(process, "platform", { value: platform, configurable: true });
		}
	});

	it("deletes a credential file left from when storage was protected", async () => {
		mocks.encryptionAvailable = true;
		await saveRemoteServer(stateDir, {
			server: server("http://box:3010", "2026-01-05T10:00:00.000Z"),
			credential: "hunter2",
		});
		expect(await exists(path.join(stateDir, REMOTE_CREDENTIALS_FILE_NAME))).toBe(true);

		mocks.encryptionAvailable = false;
		resetRemoteCredentialMemoryForTest();
		await readRemoteCredential(stateDir, "http://box:3010");

		expect(await exists(path.join(stateDir, REMOTE_CREDENTIALS_FILE_NAME))).toBe(false);
	});
});

describe("concurrent writes", () => {
	it("does not lose a server when two saves overlap", async () => {
		await Promise.all([
			saveRemoteServer(stateDir, {
				server: server("http://a:3010", "2026-01-01T00:00:00.000Z"),
				credential: "aaa",
			}),
			saveRemoteServer(stateDir, {
				server: server("http://b:3010", "2026-01-02T00:00:00.000Z"),
				credential: "bbb",
			}),
		]);

		const servers = await listRemoteServers(stateDir);
		expect(servers.map((entry) => entry.baseUrl).sort()).toEqual(["http://a:3010", "http://b:3010"]);
		await expect(readRemoteCredential(stateDir, "http://a:3010")).resolves.toBe("aaa");
		await expect(readRemoteCredential(stateDir, "http://b:3010")).resolves.toBe("bbb");
	});
});
