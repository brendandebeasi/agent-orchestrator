import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	onStatusMock,
	removeStatusMock,
	getApiBaseUrlMock,
	hasTrustedApiBaseUrlMock,
	subscribeApiBaseUrlMock,
	unsubscribeBaseUrlMock,
} = vi.hoisted(() => ({
	onStatusMock: vi.fn(),
	removeStatusMock: vi.fn(),
	getApiBaseUrlMock: vi.fn(() => "http://127.0.0.1:3001"),
	hasTrustedApiBaseUrlMock: vi.fn(() => true),
	subscribeApiBaseUrlMock: vi.fn(),
	unsubscribeBaseUrlMock: vi.fn(),
}));

vi.mock("./bridge", () => ({
	aoBridge: {
		daemon: { onStatus: onStatusMock },
	},
}));

vi.mock("./api-client", () => ({
	getApiBaseUrl: getApiBaseUrlMock,
	hasTrustedApiBaseUrl: hasTrustedApiBaseUrlMock,
	subscribeApiBaseUrl: subscribeApiBaseUrlMock,
}));

import { createEventTransport } from "./event-transport";
import { getEventsConnectionState, setEventsConnectionState } from "./events-connection";
import { clearServerCredential, setRemoteServerTarget } from "./server-target";

type Attempt = { url: string; headers: Record<string, string>; signal: AbortSignal };

// One connection attempt's response body, which the test pushes CDC frames into
// and can close to simulate the daemon dropping the stream.
type Pushable = { push: (text: string) => void; end: () => void };

const attempts: Attempt[] = [];
const bodies: Pushable[] = [];

function pushableResponse(): Response {
	let controller: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	bodies.push({
		push: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
		end: () => controller.close(),
	});
	return new Response(body, { status: 200 });
}

function stubFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			attempts.push({
				url: String(input),
				headers: (init?.headers ?? {}) as Record<string, string>,
				signal: init?.signal as AbortSignal,
			});
			return pushableResponse();
		}),
	);
}

let invalidateQueries = vi.fn();

function fakeQueryClient() {
	invalidateQueries = vi.fn();
	return { invalidateQueries } as unknown as Parameters<typeof createEventTransport>[0];
}

/** Connect and let the first attempt reach `onOpen`. */
async function connect(queryClient = fakeQueryClient()): Promise<() => void> {
	const disconnect = createEventTransport(queryClient).connect();
	await vi.advanceTimersByTimeAsync(1);
	return disconnect;
}

/**
 * Connect, then flush and discard the refresh that every (re)open queues, so a
 * test can assert on what the next event alone invalidated.
 */
async function connectSettled(queryClient = fakeQueryClient()): Promise<() => void> {
	const disconnect = await connect(queryClient);
	await vi.advanceTimersByTimeAsync(200);
	invalidateQueries.mockClear();
	return disconnect;
}

function daemonStatusHandler(): () => void {
	return onStatusMock.mock.calls[0][0] as () => void;
}

beforeEach(() => {
	vi.useFakeTimers();
	attempts.length = 0;
	bodies.length = 0;
	onStatusMock.mockReset().mockReturnValue(removeStatusMock);
	removeStatusMock.mockReset();
	getApiBaseUrlMock.mockReset().mockReturnValue("http://127.0.0.1:3001");
	hasTrustedApiBaseUrlMock.mockReset().mockReturnValue(true);
	subscribeApiBaseUrlMock.mockReset().mockReturnValue(unsubscribeBaseUrlMock);
	unsubscribeBaseUrlMock.mockReset();
	setEventsConnectionState("idle");
	stubFetch();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	clearServerCredential();
});

describe("createEventTransport", () => {
	it("opens a single stream against the current base URL on connect", async () => {
		await connect();

		expect(attempts).toHaveLength(1);
		expect(attempts[0].url).toBe("http://127.0.0.1:3001/api/v1/events");
		expect(attempts[0].headers).toMatchObject({ Accept: "text/event-stream" });
	});

	it("sends the credential a remote daemon requires", async () => {
		setRemoteServerTarget({ baseUrl: "http://desk.local:3001", label: "desk.local", credential: "hunter2" });

		await connect();

		expect(attempts[0].headers).toMatchObject({ Authorization: "Bearer hunter2" });
	});

	it("does not reconnect when a daemon status keeps the same base URL", async () => {
		await connect();

		daemonStatusHandler()();
		await vi.advanceTimersByTimeAsync(1);

		expect(attempts).toHaveLength(1);
	});

	it("closes the old connection and reconnects when the base URL changes", async () => {
		await connect();

		getApiBaseUrlMock.mockReturnValue("http://127.0.0.1:3099");
		daemonStatusHandler()();
		await vi.advanceTimersByTimeAsync(1);

		expect(attempts[0].signal.aborted).toBe(true);
		expect(attempts).toHaveLength(2);
		expect(attempts[1].url).toBe("http://127.0.0.1:3099/api/v1/events");
	});

	it("closes the stream and skips reconnecting when the base URL is untrusted", async () => {
		await connect();

		hasTrustedApiBaseUrlMock.mockReturnValue(false);
		daemonStatusHandler()();
		await vi.advanceTimersByTimeAsync(1);

		expect(attempts[0].signal.aborted).toBe(true);
		expect(attempts).toHaveLength(1);
		expect(getEventsConnectionState()).toBe("disconnected");
	});

	it("debounces workspace and session invalidation after a status change", async () => {
		await connectSettled();

		daemonStatusHandler()();
		expect(invalidateQueries).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(200);

		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["workspaces"] });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-agent-switches"] });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-scm-summary"] });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-usage"] });
	});

	// A reconnect resumes via Last-Event-ID. When the event log has been truncated
	// or replaced, that cursor is ahead of head and the daemon starts the client at
	// head instead of replaying — correct, but it means no conversation CDC arrives
	// to invalidate an open chat. Nothing in the frames themselves reports that
	// clamp, so reopening must refresh conversations unconditionally.
	it("refreshes open conversations on reopen, not just workspaces", async () => {
		await connect();

		await vi.advanceTimersByTimeAsync(200);

		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["conversation"] });
	});

	it("invalidates only the named conversation for conversation CDC", async () => {
		await connectSettled();

		bodies[0].push(
			`event: session_updated\ndata: ${JSON.stringify({
				seq: 42,
				projectId: "proj-1",
				sessionId: "chat-1",
				type: "session_updated",
				payload: {
					id: "chat-1",
					sessionId: "chat-1",
					conversationId: "conv-1",
					activity: "active",
					isTerminated: false,
				},
				createdAt: "2026-08-04T15:15:14Z",
			})}\n\n`,
		);
		await vi.advanceTimersByTimeAsync(200);

		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["conversation", "chat-1"] });
		expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["workspaces"] });
		expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ["session-scm-summary"] });
	});

	it("invalidates the named interface transition status for transition CDC", async () => {
		await connectSettled();

		bodies[0].push(
			`event: session_updated\ndata: ${JSON.stringify({
				seq: 43,
				projectId: "proj-1",
				sessionId: "session-1",
				type: "session_updated",
				payload: {
					id: "session-1",
					interfaceTransitionId: "transition-1",
					interfaceTransitionPhase: "recovery_required",
				},
				createdAt: "2026-08-13T08:00:00Z",
			})}\n\n`,
		);
		await vi.advanceTimersByTimeAsync(200);

		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: ["session-interface-transition", "session-1"],
		});
	});

	it("ignores a named frame this client does not act on", async () => {
		await connectSettled();

		bodies[0].push('event: heartbeat\ndata: {"seq":1}\n\n');
		await vi.advanceTimersByTimeAsync(200);

		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("tears down the stream and the daemon listener on disconnect", async () => {
		const disconnect = await connect();

		disconnect();

		expect(attempts[0].signal.aborted).toBe(true);
		expect(removeStatusMock).toHaveBeenCalledTimes(1);
	});

	it("marks the stream connected on open and disconnected when it drops", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		await connect();
		expect(getEventsConnectionState()).toBe("connected");

		bodies[0].end();
		await vi.advanceTimersByTimeAsync(1);
		expect(getEventsConnectionState()).toBe("disconnected");

		await vi.advanceTimersByTimeAsync(1_100);
		expect(getEventsConnectionState()).toBe("connected");
	});

	it("reconnects after backoff when the daemon drops the stream", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		await connect();

		bodies[0].end();
		await vi.advanceTimersByTimeAsync(1);
		expect(attempts).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(900);
		expect(attempts).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(200);
		expect(attempts).toHaveLength(2);
		expect(attempts[1].url).toBe("http://127.0.0.1:3001/api/v1/events");
	});

	it("reconnects when the API base URL changes out-of-band", async () => {
		await connect();
		expect(subscribeApiBaseUrlMock).toHaveBeenCalledTimes(1);
		const onBaseUrlChange = subscribeApiBaseUrlMock.mock.calls[0][0] as () => void;

		getApiBaseUrlMock.mockReturnValue("http://127.0.0.1:4555");
		onBaseUrlChange();
		await vi.advanceTimersByTimeAsync(1);

		expect(attempts[0].signal.aborted).toBe(true);
		expect(attempts).toHaveLength(2);
		expect(attempts[1].url).toBe("http://127.0.0.1:4555/api/v1/events");
	});

	it("does not carry one server's dropped stream over to the next", async () => {
		// Restarting aborts the in-flight attempt, and the stream stays quiet about
		// an abort it caused itself, so a standing "disconnected" would survive the
		// move and have the UI report an outage on a machine it has not yet tried.
		await connect();
		const onBaseUrlChange = subscribeApiBaseUrlMock.mock.calls[0][0] as () => void;
		bodies[0].end();
		await vi.advanceTimersByTimeAsync(1);
		expect(getEventsConnectionState()).toBe("disconnected");

		getApiBaseUrlMock.mockReturnValue("http://box:3010");
		onBaseUrlChange();

		expect(getEventsConnectionState()).toBe("idle");

		await vi.advanceTimersByTimeAsync(1);
		expect(getEventsConnectionState()).toBe("connected");
		expect(attempts[attempts.length - 1].url).toBe("http://box:3010/api/v1/events");
	});

	it("resets the connection state and unsubscribes on disconnect", async () => {
		const disconnect = await connect();
		expect(getEventsConnectionState()).toBe("connected");

		disconnect();

		expect(getEventsConnectionState()).toBe("idle");
		expect(unsubscribeBaseUrlMock).toHaveBeenCalledTimes(1);
	});
});
