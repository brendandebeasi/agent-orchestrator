import type { QueryClient } from "@tanstack/react-query";
import { aoBridge } from "./bridge";
import { getApiBaseUrl, hasTrustedApiBaseUrl, subscribeApiBaseUrl } from "./api-client";
import { serverAuthHeaders } from "./server-target";
import { openEventStream } from "./sse";
import { setEventsConnectionState } from "./events-connection";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { sessionScmSummaryQueryKey } from "../hooks/useSessionScmSummary";
import { conversationQueryKey, conversationQueryRoot } from "../hooks/useConversation";
import { agentSwitchesQueryRoot } from "../hooks/useAgentSwitches";
import { sessionUsageQueryRoot } from "../hooks/useSessionUsageSummaries";

export type EventTransport = {
	connect: () => () => void;
};

const INVALIDATE_DEBOUNCE_MS = 150;

// CDC event types the daemon pushes over the SSE stream (see
// backend/internal/cdc/event.go). The SSE writer tags each frame with
// `event: <type>`. Every one of these can change the project/session list the
// sidebar renders, so they all trigger a (debounced) workspace refetch; a named
// type not in this set is one this client does not act on.
const CDC_EVENT_TYPES = new Set([
	"session_created",
	"session_updated",
	"pr_created",
	"pr_updated",
	"pr_check_recorded",
	"pr_session_changed",
	"pr_review_thread_added",
	"pr_review_thread_resolved",
	"review_run_created",
	"review_run_updated",
]);

/**
 * Wires live server state into the TanStack Query cache. Two sources feed it:
 *   - daemon lifecycle over Electron IPC (coming up/down changes session availability)
 *   - the backend CDC stream over SSE (project/session/PR changes)
 * Both invalidate the ["workspaces"] query so the UI refetches. Invalidations are
 * debounced because a single user action can emit a burst of CDC events.
 */
export function createEventTransport(queryClient: QueryClient): EventTransport {
	return {
		connect() {
			let debounce: ReturnType<typeof setTimeout> | undefined;
			const pendingConversationSessions = new Set<string>();
			const pendingInterfaceTransitionSessions = new Set<string>();
			let workspaceInvalidationPending = false;
			let allConversationsInvalidationPending = false;
			const refreshWorkspaces = (data?: string) => {
				let conversationOnly = false;
				if (data === undefined) {
					// A lifecycle refresh -- reconnect, daemon status change, base-URL change --
					// carries no event, so we cannot know which conversations moved. Normally the
					// replay that follows tells us, but when the event log has been truncated the
					// daemon starts us at head and no CDC arrives at all. The stream does not read
					// the header reporting that clamp, so refresh every conversation instead of
					// leaving an open chat frozen on its pre-gap snapshot.
					allConversationsInvalidationPending = true;
				}
				if (data !== undefined) {
					try {
						const decoded = JSON.parse(data) as {
							sessionId?: unknown;
							payload?: unknown;
						};
						// The SSE endpoint sends the complete durable CDC event. Routing
						// fields such as sessionId live on that envelope, while trigger-built
						// details such as conversationId live inside its payload. Do not
						// mistake the payload for the entire event: doing so refreshes the
						// sidebar but leaves a Chat timeline frozen on its pre-turn snapshot.
						const payload =
							typeof decoded.payload === "object" && decoded.payload !== null
								? (decoded.payload as {
										conversationId?: unknown;
										interfaceTransitionId?: unknown;
								  })
								: undefined;
						if (
							typeof decoded.sessionId === "string" &&
							decoded.sessionId &&
							typeof payload?.interfaceTransitionId === "string" &&
							payload.interfaceTransitionId
						) {
							pendingInterfaceTransitionSessions.add(decoded.sessionId);
						}
						if (
							typeof decoded.sessionId === "string" &&
							decoded.sessionId &&
							typeof payload?.conversationId === "string" &&
							payload.conversationId
						) {
							pendingConversationSessions.add(decoded.sessionId);
							conversationOnly = true;
						}
					} catch {
						// A malformed CDC payload still invalidates workspaces; it simply
						// cannot target a conversation cache precisely.
					}
				}
				if (!conversationOnly) workspaceInvalidationPending = true;
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(() => {
					if (allConversationsInvalidationPending) {
						void queryClient.invalidateQueries({ queryKey: conversationQueryRoot });
						allConversationsInvalidationPending = false;
					}
					if (workspaceInvalidationPending) {
						void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
						void queryClient.invalidateQueries({ queryKey: agentSwitchesQueryRoot });
						void queryClient.invalidateQueries({ queryKey: sessionScmSummaryQueryKey() });
						void queryClient.invalidateQueries({ queryKey: sessionUsageQueryRoot });
						workspaceInvalidationPending = false;
					}
					for (const sessionId of pendingConversationSessions) {
						void queryClient.invalidateQueries({ queryKey: conversationQueryKey(sessionId) });
					}
					pendingConversationSessions.clear();
					for (const sessionId of pendingInterfaceTransitionSessions) {
						void queryClient.invalidateQueries({
							queryKey: ["session-interface-transition", sessionId],
						});
					}
					pendingInterfaceTransitionSessions.clear();
				}, INVALIDATE_DEBOUNCE_MS);
			};

			// The base URL the stream is currently bound to, or undefined while no
			// server is trusted.
			const currentBaseUrl = () => (hasTrustedApiBaseUrl() ? getApiBaseUrl() : undefined);
			let boundBaseUrl = currentBaseUrl();

			const stream = openEventStream({
				url: () => {
					const baseUrl = currentBaseUrl();
					return baseUrl === undefined ? null : `${baseUrl.replace(/\/+$/, "")}/api/v1/events`;
				},
				headers: serverAuthHeaders,
				onOpen: () => {
					setEventsConnectionState("connected");
					// Events emitted during the gap were lost; refetch once on (re)open.
					refreshWorkspaces();
				},
				onDisconnect: () => {
					// The stream retries on its own; surface the gap so the UI does not
					// present a frozen snapshot as live.
					setEventsConnectionState("disconnected");
				},
				onEvent: (event) => {
					if (event.type !== "message" && !CDC_EVENT_TYPES.has(event.type)) return;
					refreshWorkspaces(event.data);
				},
			});

			const rebind = () => {
				boundBaseUrl = currentBaseUrl();
				// Whatever the old server's stream was doing says nothing about the new
				// one. Restarting aborts the current attempt, and an abort is our own
				// doing, so the stream will not report a disconnect on its way out —
				// which would otherwise leave a stale "disconnected" standing and have
				// the UI complain that it is reconnecting to a server it has not yet
				// tried. Reset to idle and let the next open or failure speak for the
				// server we actually moved to.
				setEventsConnectionState("idle");
				stream.restart();
			};

			const removeDaemonListener = aoBridge.daemon.onStatus(() => {
				// A status event that leaves the daemon where it was does not disturb a
				// working stream; one that moves it rebinds without waiting out backoff.
				if (currentBaseUrl() !== boundBaseUrl) rebind();
				refreshWorkspaces();
			});
			// The target store notifies only on a real change — a different port, a
			// different machine, a credential that was accepted or rejected — and any
			// of those leaves the open stream bound to the wrong thing.
			const removeBaseUrlListener = subscribeApiBaseUrl(rebind);

			return () => {
				if (debounce) clearTimeout(debounce);
				removeDaemonListener();
				removeBaseUrlListener();
				stream.close();
				setEventsConnectionState("idle");
			};
		},
	};
}
