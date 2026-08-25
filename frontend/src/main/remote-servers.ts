/**
 * Remembering which servers the operator connects to, and their passwords.
 *
 * Two stores, deliberately, because the two halves have different consequences
 * if they leak and different consequences if they are lost. A server's address
 * and label are not secrets: they go in a plain JSON file, and keeping them
 * readable means an operator can see and edit what their client will try to
 * connect to. A connection password is a secret: it goes through `safeStorage`
 * and, on a machine where that is not really encryption, never touches disk at
 * all.
 *
 * Splitting them also decides what happens on a machine with no protected
 * storage: the operator keeps their list of servers and retypes one password
 * per launch. Storing both together — the shape `cloud-auth.ts` uses for a
 * rotating refresh token, where losing the whole store is the right answer —
 * would cost them the list too, for no gain.
 */

import { safeStorage } from "electron";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSavedServer, sortSavedServers, type SavedServer } from "../shared/remote-server";

export const REMOTE_SERVERS_FILE_NAME = "remote-servers.json";
export const REMOTE_CREDENTIALS_FILE_NAME = "remote-credentials.bin";

/** Credentials held for this process only, when disk is not safe to use. */
const memoryCredentials = new Map<string, Map<string, string>>();

let operationQueue: Promise<void> = Promise.resolve();

/**
 * Whether `safeStorage` on this machine is real encryption.
 *
 * Linux reports encryption as available even when the selected backend is
 * `basic_text`, which encrypts with a hardcoded password and is therefore
 * obfuscation rather than protection. The same check guards the cloud session
 * store; a connection password deserves it for the same reason.
 */
function protectedStorageAvailable(): boolean {
	if (!safeStorage.isEncryptionAvailable()) return false;
	if (process.platform !== "linux") return true;
	const backend = safeStorage.getSelectedStorageBackend();
	return backend !== "basic_text" && backend !== "unknown";
}

function serversPath(stateDir: string): string {
	return path.join(stateDir, REMOTE_SERVERS_FILE_NAME);
}

function credentialsPath(stateDir: string): string {
	return path.join(stateDir, REMOTE_CREDENTIALS_FILE_NAME);
}

/** Serialize every mutation so two IPC calls cannot interleave read and write. */
function runOperation<T>(operation: () => Promise<T>): Promise<T> {
	const queued = operationQueue.then(operation, operation);
	operationQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	return queued;
}

async function readServersUnlocked(stateDir: string): Promise<SavedServer[]> {
	let raw: string;
	try {
		raw = await readFile(serversPath(stateDir), "utf8");
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// A hand-edited file that no longer parses is not a reason to refuse to
		// start; the operator loses their list and can retype an address.
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	// Entries are filtered rather than the whole file rejected, so one bad row
	// does not discard the good ones.
	return sortSavedServers(parsed.filter(isSavedServer));
}

async function writeServersUnlocked(stateDir: string, servers: SavedServer[]): Promise<void> {
	await mkdir(stateDir, { recursive: true, mode: 0o750 });
	const file = serversPath(stateDir);
	const temporary = path.join(stateDir, `.remote-servers-${process.pid}-${Date.now()}.json`);
	await writeFile(temporary, `${JSON.stringify(servers, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, file);
}

async function readCredentialsUnlocked(stateDir: string): Promise<Map<string, string>> {
	const held = memoryCredentials.get(stateDir);
	if (held) return held;
	if (!protectedStorageAvailable()) {
		await rm(credentialsPath(stateDir), { force: true });
		return new Map();
	}
	try {
		const decrypted = safeStorage.decryptString(await readFile(credentialsPath(stateDir)));
		const parsed: unknown = JSON.parse(decrypted);
		if (typeof parsed !== "object" || parsed === null) return new Map();
		const entries = Object.entries(parsed as Record<string, unknown>).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		);
		return new Map(entries);
	} catch {
		// Unreadable means it was written by a different OS keychain identity or
		// corrupted. Either way it will never decrypt again, so remove it rather
		// than failing every read from here on.
		await rm(credentialsPath(stateDir), { force: true });
		return new Map();
	}
}

async function writeCredentialsUnlocked(stateDir: string, credentials: Map<string, string>): Promise<void> {
	if (!protectedStorageAvailable()) {
		// Never a plaintext fallback for a password. Holding it in memory keeps
		// the session working and loses it on quit, which is the correct trade.
		memoryCredentials.set(stateDir, credentials);
		await rm(credentialsPath(stateDir), { force: true });
		return;
	}
	memoryCredentials.delete(stateDir);
	await mkdir(stateDir, { recursive: true, mode: 0o750 });
	if (credentials.size === 0) {
		await rm(credentialsPath(stateDir), { force: true });
		return;
	}
	const payload = safeStorage.encryptString(JSON.stringify(Object.fromEntries(credentials)));
	const file = credentialsPath(stateDir);
	const temporary = path.join(stateDir, `.remote-credentials-${process.pid}-${Date.now()}.bin`);
	await writeFile(temporary, payload, { mode: 0o600 });
	await rename(temporary, file);
}

/** Every server the operator has saved, most recently connected first. */
export function listRemoteServers(stateDir: string): Promise<SavedServer[]> {
	return runOperation(() => readServersUnlocked(stateDir));
}

/**
 * Add or update a server, and store the password alongside it.
 *
 * The credential is written in the same operation as the entry so the two can
 * never disagree: an entry with no credential would prompt on next launch, and
 * a credential with no entry would be a password nothing can delete.
 *
 * A null credential means "nothing new to record", not "forget what you had".
 * Only removing the server forgets a password — an operator who unticks
 * "remember" on a later connection is saying not to store this attempt's
 * password, which is not the same as asking to delete the one already stored.
 */
export function saveRemoteServer(
	stateDir: string,
	input: { server: SavedServer; credential: string | null },
): Promise<SavedServer[]> {
	return runOperation(async () => {
		const servers = await readServersUnlocked(stateDir);
		const next = sortSavedServers([
			...servers.filter((server) => server.baseUrl !== input.server.baseUrl),
			input.server,
		]);
		await writeServersUnlocked(stateDir, next);
		if (input.credential !== null) {
			const credentials = await readCredentialsUnlocked(stateDir);
			credentials.set(input.server.baseUrl, input.credential);
			await writeCredentialsUnlocked(stateDir, credentials);
		}
		return next;
	});
}

/**
 * Forget a server and its password.
 *
 * This is what "sign out of this server" has to mean. Removing only the visible
 * entry would leave the password on disk with nothing left in the interface
 * that could ever delete it.
 */
export function removeRemoteServer(stateDir: string, baseUrl: string): Promise<SavedServer[]> {
	return runOperation(async () => {
		const servers = await readServersUnlocked(stateDir);
		const next = servers.filter((server) => server.baseUrl !== baseUrl);
		await writeServersUnlocked(stateDir, next);
		const credentials = await readCredentialsUnlocked(stateDir);
		if (credentials.delete(baseUrl)) await writeCredentialsUnlocked(stateDir, credentials);
		return next;
	});
}

/** The stored password for one server, or null when none is held. */
export function readRemoteCredential(stateDir: string, baseUrl: string): Promise<string | null> {
	return runOperation(async () => {
		const credentials = await readCredentialsUnlocked(stateDir);
		return credentials.get(baseUrl) ?? null;
	});
}

/**
 * Drop every in-memory credential for a state directory. Exists for tests,
 * which otherwise leak the unprotected-storage fallback between cases.
 */
export function resetRemoteCredentialMemoryForTest(): void {
	memoryCredentials.clear();
}
