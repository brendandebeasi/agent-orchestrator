import type { QueryClient } from "@tanstack/react-query";
import { getApiBaseUrl, hasTrustedApiBaseUrl, subscribeApiBaseUrl } from "./api-client";
import { serverAuthHeaders } from "./server-target";
import { type EventStream, openEventStream } from "./sse";

const INVALIDATE_DEBOUNCE_MS = 150;
const DEGRADED_AFTER_FAILURES = 3;

export type WorkspaceFileConnectionState = "connecting" | "connected" | "degraded";

type WorkspaceStream = {
	refs: number;
	disposed: boolean;
	failures: number;
	source?: EventStream;
	sourceBaseUrl?: string;
	debounce?: ReturnType<typeof setTimeout>;
	disconnectBaseUrl: () => void;
	ensureConnected: () => void;
	dispose: () => void;
};

const streams = new Map<string, WorkspaceStream>();
const connectionStates = new Map<string, WorkspaceFileConnectionState>();
const connectionStateListeners = new Map<string, Set<() => void>>();

export function getWorkspaceFileConnectionState(sessionId: string): WorkspaceFileConnectionState {
	return connectionStates.get(sessionId) ?? "connecting";
}

export function subscribeWorkspaceFileConnectionState(sessionId: string, listener: () => void): () => void {
	let listeners = connectionStateListeners.get(sessionId);
	if (!listeners) {
		listeners = new Set();
		connectionStateListeners.set(sessionId, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners?.delete(listener);
		if (listeners?.size === 0) connectionStateListeners.delete(sessionId);
		if (!streams.has(sessionId) && !connectionStateListeners.has(sessionId)) connectionStates.delete(sessionId);
	};
}

function setWorkspaceFileConnectionState(sessionId: string, next: WorkspaceFileConnectionState): void {
	if (connectionStates.get(sessionId) === next) return;
	connectionStates.set(sessionId, next);
	connectionStateListeners.get(sessionId)?.forEach((listener) => listener());
}

// Shares one daemon watcher between the rail and maximized copies of a Files
// view. The daemon sends only invalidation edges; Git status and visible diffs
// are then refetched through the existing typed queries.
export function subscribeWorkspaceFileChanges(sessionId: string, queryClient: QueryClient): () => void {
	let stream = streams.get(sessionId);
	if (!stream) {
		stream = createWorkspaceStream(sessionId, queryClient);
		streams.set(sessionId, stream);
	}
	stream.refs += 1;

	return () => {
		const current = streams.get(sessionId);
		if (!current) return;
		current.refs -= 1;
		if (current.refs > 0) return;
		current.dispose();
		streams.delete(sessionId);
		if (!connectionStateListeners.has(sessionId)) connectionStates.delete(sessionId);
	};
}

function createWorkspaceStream(sessionId: string, queryClient: QueryClient): WorkspaceStream {
	const stream = {} as WorkspaceStream;
	const invalidate = () => {
		if (stream.debounce) clearTimeout(stream.debounce);
		stream.debounce = setTimeout(() => {
			void queryClient.invalidateQueries({ queryKey: ["session-workspace-files", sessionId] });
			void queryClient.invalidateQueries({ queryKey: ["session-workspace-file", sessionId] });
		}, INVALIDATE_DEBOUNCE_MS);
	};
	stream.refs = 0;
	stream.disposed = false;
	stream.failures = 0;
	setWorkspaceFileConnectionState(sessionId, "connecting");

	stream.ensureConnected = () => {
		if (stream.disposed) return;
		const baseUrl = hasTrustedApiBaseUrl() ? getApiBaseUrl() : undefined;
		if (!stream.source) {
			stream.sourceBaseUrl = baseUrl;
			stream.source = openEventStream({
				url: () => {
					// Read afresh on every attempt rather than closing over a base
					// URL: a retry that fires after the daemon moved should follow it
					// instead of hammering the address it used to answer on.
					if (!hasTrustedApiBaseUrl()) return null;
					const base = getApiBaseUrl().replace(/\/+$/, "");
					return `${base}/api/v1/sessions/${encodeURIComponent(sessionId)}/workspace/events`;
				},
				headers: serverAuthHeaders,
				onOpen: () => {
					if (stream.disposed) return;
					stream.failures = 0;
					setWorkspaceFileConnectionState(sessionId, "connected");
					// The watcher only reports edges, so whatever changed while we
					// were away is invisible to us. Refetch once on connect.
					invalidate();
				},
				onEvent: (event) => {
					if (stream.disposed) return;
					if (event.type === "workspace_changed") invalidate();
				},
				onDisconnect: () => {
					if (stream.disposed) return;
					if (!hasTrustedApiBaseUrl()) {
						// There was no daemon to reach, so this says nothing about the
						// health of the watcher. Stay "connecting" and wait for the
						// base URL subscription to restart us.
						setWorkspaceFileConnectionState(sessionId, "connecting");
						return;
					}
					stream.failures += 1;
					const degraded = stream.failures >= DEGRADED_AFTER_FAILURES;
					setWorkspaceFileConnectionState(sessionId, degraded ? "degraded" : "connecting");
				},
			});
			return;
		}
		if (stream.sourceBaseUrl === baseUrl) return;
		// The daemon moved. Failures counted against the old address say nothing
		// about the new one, so the badge starts over rather than opening degraded.
		stream.sourceBaseUrl = baseUrl;
		stream.failures = 0;
		setWorkspaceFileConnectionState(sessionId, "connecting");
		stream.source.restart();
	};

	stream.disconnectBaseUrl = subscribeApiBaseUrl(stream.ensureConnected);
	stream.dispose = () => {
		stream.disposed = true;
		if (stream.debounce) clearTimeout(stream.debounce);
		stream.disconnectBaseUrl();
		stream.source?.close();
		stream.source = undefined;
	};
	stream.ensureConnected();
	return stream;
}
