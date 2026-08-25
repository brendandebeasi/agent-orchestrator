import { useSyncExternalStore } from "react";
import { getServerConnection, subscribeServerConnection, type ServerConnection } from "../lib/server-connection";

/**
 * The client's link to its server: which one, how the link is doing, and
 * whether the two halves were built from the same release.
 *
 * See lib/server-connection.ts for why this is one answer rather than the two
 * separate facts it is derived from.
 */
export function useServerConnection(): ServerConnection {
	return useSyncExternalStore(subscribeServerConnection, getServerConnection, getServerConnection);
}
