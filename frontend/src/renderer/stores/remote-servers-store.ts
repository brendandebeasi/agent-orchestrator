import { create } from "zustand";
import { aoBridge } from "../lib/bridge";
import { sortSavedServers, type SavedServer } from "../../shared/remote-server";

/**
 * The operator's list of remote servers, as the renderer sees it.
 *
 * The renderer does not persist anything itself. It asks the host, and what the
 * host does with the request is the host's business: the desktop app writes the
 * list to disk and the password to the OS keychain, and a browser answers that
 * it remembers nothing (see the stub in lib/bridge.ts for why). That means this
 * store is the same code on both, and a client with no persistence just shows
 * an empty list and asks for the password every time — which is a coherent
 * experience, not a broken one.
 *
 * Errors are swallowed into a flag rather than thrown. A keychain that will not
 * open is a reason to make the operator retype a password; it is not a reason to
 * stop them connecting.
 */
type RemoteServersState = {
	servers: SavedServer[];
	loaded: boolean;
	/** True when the last read or write failed. Cleared by the next success. */
	failed: boolean;
	load: () => Promise<void>;
	/** Add or update an entry, storing its password when one is given. */
	save: (server: SavedServer, credential: string | null) => Promise<void>;
	/** Forget an entry and its password. */
	remove: (baseUrl: string) => Promise<void>;
	/** The stored password for a server, or null when none is held. */
	credentialFor: (baseUrl: string) => Promise<string | null>;
};

let pendingLoad: Promise<void> | undefined;

export const useRemoteServersStore = create<RemoteServersState>((set, get) => ({
	servers: [],
	loaded: false,
	failed: false,
	load: async () => {
		if (get().loaded) return;
		// Concurrent callers share one read: the connection screen and a settings
		// panel can both mount in the same tick.
		if (pendingLoad) return pendingLoad;
		pendingLoad = (async () => {
			try {
				set({ servers: sortSavedServers(await aoBridge.remoteServers.list()), loaded: true, failed: false });
			} catch {
				set({ servers: [], loaded: true, failed: true });
			}
		})();
		try {
			await pendingLoad;
		} finally {
			pendingLoad = undefined;
		}
	},
	save: async (server, credential) => {
		try {
			set({ servers: sortSavedServers(await aoBridge.remoteServers.save({ server, credential })), failed: false });
		} catch {
			set({ failed: true });
		}
	},
	remove: async (baseUrl) => {
		try {
			set({ servers: sortSavedServers(await aoBridge.remoteServers.remove(baseUrl)), failed: false });
		} catch {
			set({ failed: true });
		}
	},
	credentialFor: async (baseUrl) => {
		try {
			return await aoBridge.remoteServers.readCredential(baseUrl);
		} catch {
			set({ failed: true });
			return null;
		}
	},
}));

/** Reset between tests; zustand stores are module singletons. */
export function resetRemoteServersStoreForTest(): void {
	pendingLoad = undefined;
	useRemoteServersStore.setState({ servers: [], loaded: false, failed: false });
}
