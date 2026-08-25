/**
 * Server-sent events over `fetch`.
 *
 * `EventSource` cannot carry a header, so the only way to authenticate one is
 * to put the credential in the URL, where it lands in every proxy log and
 * browser history between here and the daemon. A daemon reached over the
 * network needs the credential on every request, so the streams move to
 * `fetch`, which can carry it, and this module supplies what `EventSource` gave
 * for free: frame parsing, reconnection, and resume from the last seen id.
 */

/** One dispatched event. `type` is "message" when the frame named none. */
export type SseEvent = { type: string; data: string; lastEventId: string };

type Sink = (event: SseEvent) => void;

/**
 * Incremental parser for the event-stream format (WHATWG HTML 9.2.6). Feed it
 * chunks as they arrive; a frame is dispatched on each blank line.
 */
export function createSseParser(dispatch: Sink): { push: (chunk: string) => void } {
	let pending = "";
	let eventType = "";
	let data = "";
	let dataSeen = false;
	let lastEventId = "";

	const flush = () => {
		if (!dataSeen) {
			// A frame with no data field is a no-op that still resets the type,
			// which is how a bare `id:` keep-alive is meant to behave.
			eventType = "";
			return;
		}
		dispatch({ type: eventType || "message", data: data.replace(/\n$/, ""), lastEventId });
		eventType = "";
		data = "";
		dataSeen = false;
	};

	const line = (raw: string) => {
		if (raw === "") {
			flush();
			return;
		}
		// Comment frames, which is what the daemon's keep-alive heartbeat is.
		if (raw.startsWith(":")) return;
		const colon = raw.indexOf(":");
		const field = colon === -1 ? raw : raw.slice(0, colon);
		let value = colon === -1 ? "" : raw.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		switch (field) {
			case "event":
				eventType = value;
				break;
			case "data":
				data += `${value}\n`;
				dataSeen = true;
				break;
			case "id":
				// A NUL in the id is required to be ignored rather than stored.
				if (!value.includes("\0")) lastEventId = value;
				break;
			default:
				// `retry` and anything else: the daemon's backoff is not negotiable
				// from the server side here, and unknown fields are ignored by spec.
				break;
		}
	};

	return {
		push(chunk: string) {
			pending += chunk;
			// Split on CRLF, LF, or CR, keeping any partial trailing line buffered.
			const lines = pending.split(/\r\n|\n|\r/);
			pending = lines.pop() ?? "";
			for (const raw of lines) line(raw);
		},
	};
}

export type EventStream = {
	/** Abort the current attempt and connect again now. */
	restart: () => void;
	/** Stop for good: aborts the current attempt and cancels any pending retry. */
	close: () => void;
};

export type EventStreamOptions = {
	/**
	 * The stream URL, read per attempt. `null` means there is nothing to connect
	 * to yet, which leaves the stream closed until the next `restart`.
	 */
	url: () => string | null;
	/** Headers for each attempt, read per attempt so a changed credential is used. */
	headers?: () => Record<string, string>;
	onOpen?: () => void;
	onEvent: Sink;
	/** Called once per transition from connected (or connecting) to not. */
	onDisconnect?: () => void;
	fetchImpl?: typeof fetch;
	/** Backoff, given the number of consecutive failures so far (0 for the first). */
	retryDelayMs?: (failures: number) => number;
};

const RETRY_LADDER_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function defaultRetryDelayMs(failures: number): number {
	const base = RETRY_LADDER_MS[Math.min(failures, RETRY_LADDER_MS.length - 1)];
	// Spread the reconnects: a client holds several streams against one daemon
	// and they all drop together when it restarts, so an unjittered ladder has
	// them retrying in lockstep for as long as it stays down.
	return base * (0.8 + Math.random() * 0.4);
}

/**
 * Open a reconnecting event stream. Returns immediately; the first attempt runs
 * on its own.
 */
export function openEventStream(options: EventStreamOptions): EventStream {
	const doFetch = options.fetchImpl ?? globalThis.fetch;
	const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
	let controller: AbortController | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let failures = 0;
	let lastEventId = "";
	let closed = false;

	const cancelRetry = () => {
		if (retryTimer === undefined) return;
		clearTimeout(retryTimer);
		retryTimer = undefined;
	};

	const scheduleRetry = () => {
		if (closed || retryTimer !== undefined) return;
		const delay = retryDelayMs(failures);
		failures += 1;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			void attempt();
		}, delay);
	};

	const attempt = async (): Promise<void> => {
		if (closed) return;
		const url = options.url();
		if (url === null) {
			// Nothing to connect to. Not a failure, so no backoff is accrued; the
			// caller restarts us when a server becomes known.
			options.onDisconnect?.();
			return;
		}

		const abort = new AbortController();
		controller = abort;
		const headers: Record<string, string> = {
			Accept: "text/event-stream",
			...(options.headers?.() ?? {}),
		};
		// Resume where the last connection stopped. The daemon reads this as the
		// same cursor as `?after=`, which keeps the sequence out of the URL.
		if (lastEventId !== "") headers["Last-Event-ID"] = lastEventId;

		try {
			const response = await doFetch(url, { headers, signal: abort.signal, cache: "no-store" });
			if (!response.ok || response.body === null) {
				// A non-2xx is the daemon answering, so it is worth backing off on:
				// 401 until the credential is replaced, 503 until it is ready.
				throw new Error(`event stream refused with ${response.status}`);
			}
			failures = 0;
			options.onOpen?.();

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			const parser = createSseParser((event) => {
				if (event.lastEventId !== "") lastEventId = event.lastEventId;
				options.onEvent(event);
			});
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				parser.push(decoder.decode(value, { stream: true }));
			}
			// The daemon closed the stream, or the connection dropped cleanly.
			if (!abort.signal.aborted) {
				options.onDisconnect?.();
				scheduleRetry();
			}
		} catch {
			// An abort is our own doing (close or restart), not a failure.
			if (abort.signal.aborted) return;
			options.onDisconnect?.();
			scheduleRetry();
		} finally {
			if (controller === abort) controller = undefined;
		}
	};

	void attempt();

	return {
		restart() {
			if (closed) return;
			cancelRetry();
			failures = 0;
			controller?.abort();
			void attempt();
		},
		close() {
			closed = true;
			cancelRetry();
			controller?.abort();
		},
	};
}
