import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { aoBridge } from "../lib/bridge";
import { applyDaemonStatus, readDaemonStatus, remoteServerStatus, type DaemonStatus } from "../lib/daemon-status";
import { getServerTarget, subscribeServerTarget } from "../lib/server-target";
import { queryClient as defaultQueryClient } from "../lib/query-client";
import { createEventTransport } from "../lib/event-transport";

const STATUS_REFRESH_MS = 2_000;
const READY_STATUS_REFRESH_MS = 10_000;

export function useDaemonStatus(queryClient: QueryClient = defaultQueryClient) {
	const target = useSyncExternalStore(subscribeServerTarget, getServerTarget, getServerTarget);
	// Memoized on the target object, which the store keeps stable between
	// changes, so consumers holding this status do not see a new object on every
	// render of this hook.
	const remoteStatus = useMemo(() => remoteServerStatus(target), [target]);
	const isRemote = remoteStatus !== null;
	const [status, setStatus] = useState<DaemonStatus>({ state: "stopped" });
	const statusRef = useRef(status);

	useEffect(() => {
		let active = true;
		let stopTransport: () => void = () => undefined;
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		let statusVersion = 0;

		// The change stream is this client's link to whichever server it is
		// pointed at, local or not, and it rebinds itself when that changes, so
		// it is started before the branch below rather than inside either arm.
		void Promise.resolve().then(() => {
			if (active) stopTransport = createEventTransport(queryClient).connect();
		});

		// A client aimed at another machine has no local daemon to supervise.
		// Polling the supervisor would collect a "stopped" it will report
		// forever, for a daemon nobody asked it to start, and every read of that
		// answer would be a claim about the wrong computer. `remoteServerStatus`
		// answers for the server actually in use instead, and the connection
		// indicator beside its name reports the link dropping.
		if (isRemote) {
			return () => {
				active = false;
				stopTransport();
			};
		}

		const clearRefresh = () => {
			if (refreshTimer) {
				clearTimeout(refreshTimer);
				refreshTimer = undefined;
			}
		};

		const refreshStatus = () => {
			clearRefresh();
			const requestVersion = ++statusVersion;
			void readDaemonStatus()
				.then((nextStatus) => {
					if (active && requestVersion === statusVersion) applyStatus(nextStatus);
				})
				.catch(() => {
					// IPC unavailable (browser preview, broken preload): stay on the
					// last known status and keep the recovery loop alive.
				})
				.finally(() => {
					if (!active || requestVersion !== statusVersion) return;
					scheduleRefresh(statusRef.current.state === "ready" ? READY_STATUS_REFRESH_MS : STATUS_REFRESH_MS);
				});
		};

		const scheduleRefresh = (delayMs = STATUS_REFRESH_MS) => {
			if (refreshTimer || !active) return;
			refreshTimer = setTimeout(refreshStatus, delayMs);
		};

		const applyStatus = (nextStatus: DaemonStatus) => {
			// Only point REST at the new port; the workspace refetch is the event
			// transport's job (it invalidates, debounced, on every daemon status).
			statusRef.current = nextStatus;
			if (nextStatus.state === "ready" && nextStatus.port) {
				applyDaemonStatus(nextStatus);
				clearRefresh();
				scheduleRefresh(READY_STATUS_REFRESH_MS);
			} else {
				applyDaemonStatus(nextStatus);
				scheduleRefresh();
			}
			setStatus(nextStatus);
		};

		refreshStatus();
		const refreshOnFocus = () => {
			refreshStatus();
		};
		const refreshOnVisibility = () => {
			if (document.visibilityState === "visible") refreshOnFocus();
		};
		window.addEventListener("focus", refreshOnFocus);
		document.addEventListener("visibilitychange", refreshOnVisibility);

		const stopStatusListener = aoBridge.daemon.onStatus((nextStatus) => {
			statusVersion += 1;
			applyStatus(nextStatus);
		});

		return () => {
			active = false;
			clearRefresh();
			window.removeEventListener("focus", refreshOnFocus);
			document.removeEventListener("visibilitychange", refreshOnVisibility);
			stopTransport();
			stopStatusListener();
		};
	}, [isRemote, queryClient]);

	return remoteStatus ?? status;
}
