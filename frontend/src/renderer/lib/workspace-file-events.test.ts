import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getApiBaseUrlMock, hasTrustedApiBaseUrlMock, subscribeApiBaseUrlMock, unsubscribeBaseUrlMock } = vi.hoisted(
	() => ({
		getApiBaseUrlMock: vi.fn(() => "http://127.0.0.1:3001"),
		hasTrustedApiBaseUrlMock: vi.fn(() => true),
		subscribeApiBaseUrlMock: vi.fn(),
		unsubscribeBaseUrlMock: vi.fn(),
	}),
);

vi.mock("./api-client", () => ({
	getApiBaseUrl: getApiBaseUrlMock,
	hasTrustedApiBaseUrl: hasTrustedApiBaseUrlMock,
	subscribeApiBaseUrl: subscribeApiBaseUrlMock,
}));

import { clearServerCredential, setRemoteServerTarget } from "./server-target";
import { getWorkspaceFileConnectionState, subscribeWorkspaceFileChanges } from "./workspace-file-events";

let baseUrlListener: (() => void) | undefined;

// A response body the test pushes into, so a watcher connection can be held
// open and dropped on demand.
function pushableBody() {
	let controller: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	return {
		body,
		push(text: string) {
			controller.enqueue(new TextEncoder().encode(text));
		},
		end() {
			controller.close();
		},
	};
}

type Attempt = { url: string; headers: Record<string, string>; signal: AbortSignal };

const attempts: Attempt[] = [];

/** Answers every connection attempt with a body the test can push frames into. */
function stubFetch(respond: (attempt: number) => Response | Promise<Response>) {
	const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const index = attempts.length;
		attempts.push({
			url: String(input),
			headers: (init?.headers ?? {}) as Record<string, string>,
			signal: init?.signal as AbortSignal,
		});
		return respond(index);
	});
	vi.stubGlobal("fetch", impl);
	return impl;
}

function fakeQueryClient() {
	return { invalidateQueries: vi.fn() } as unknown as Parameters<typeof subscribeWorkspaceFileChanges>[1];
}

beforeEach(() => {
	attempts.length = 0;
	baseUrlListener = undefined;
	getApiBaseUrlMock.mockReset().mockReturnValue("http://127.0.0.1:3001");
	hasTrustedApiBaseUrlMock.mockReset().mockReturnValue(true);
	subscribeApiBaseUrlMock.mockReset().mockImplementation((listener: () => void) => {
		baseUrlListener = listener;
		return unsubscribeBaseUrlMock;
	});
	unsubscribeBaseUrlMock.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	clearServerCredential();
});

describe("subscribeWorkspaceFileChanges", () => {
	it("shares one daemon stream until the final Files view unmounts", async () => {
		const pushable = pushableBody();
		stubFetch(() => new Response(pushable.body, { status: 200 }));

		const queryClient = fakeQueryClient();
		const unsubscribeRail = subscribeWorkspaceFileChanges("session/a", queryClient);
		const unsubscribeMaximized = subscribeWorkspaceFileChanges("session/a", queryClient);
		await vi.waitFor(() => expect(attempts).toHaveLength(1));

		expect(attempts[0].url).toBe("http://127.0.0.1:3001/api/v1/sessions/session%2Fa/workspace/events");

		unsubscribeRail();
		expect(attempts[0].signal.aborted).toBe(false);
		unsubscribeMaximized();
		expect(attempts[0].signal.aborted).toBe(true);
		expect(unsubscribeBaseUrlMock).toHaveBeenCalledTimes(1);
	});

	it("sends the credential a remote daemon requires", async () => {
		setRemoteServerTarget({ baseUrl: "http://desk.local:3001", label: "desk.local", credential: "hunter2" });
		const pushable = pushableBody();
		stubFetch(() => new Response(pushable.body, { status: 200 }));

		const unsubscribe = subscribeWorkspaceFileChanges("sess-auth", fakeQueryClient());
		await vi.waitFor(() => expect(attempts).toHaveLength(1));

		expect(attempts[0].headers).toMatchObject({
			Accept: "text/event-stream",
			Authorization: "Bearer hunter2",
		});
		unsubscribe();
	});

	it("coalesces filesystem events and invalidates the list plus visible details", async () => {
		vi.useFakeTimers();
		const pushable = pushableBody();
		stubFetch(() => new Response(pushable.body, { status: 200 }));

		const queryClient = fakeQueryClient();
		const unsubscribe = subscribeWorkspaceFileChanges("sess-1", queryClient);
		await vi.advanceTimersByTimeAsync(1);

		pushable.push("event: workspace_changed\ndata: {}\n\n");
		pushable.push("event: workspace_changed\ndata: {}\n\n");
		await vi.advanceTimersByTimeAsync(1);
		expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(150);

		expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-workspace-files", "sess-1"] });
		expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["session-workspace-file", "sess-1"] });
		unsubscribe();
	});

	it("keeps one retry pending when another connect trigger arrives", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		stubFetch(() => Promise.reject(new Error("connection refused")));

		const unsubscribe = subscribeWorkspaceFileChanges("sess-retry", fakeQueryClient());
		await vi.advanceTimersByTimeAsync(1);
		expect(attempts).toHaveLength(1);

		// The base URL did not move, so the notification must not collapse the
		// pending backoff into an immediate reconnect.
		baseUrlListener?.();
		await vi.advanceTimersByTimeAsync(1);
		expect(attempts).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(999);
		expect(attempts).toHaveLength(2);
		unsubscribe();
	});

	it("reports degraded after three failed connections and recovers when one opens", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const pushable = pushableBody();
		stubFetch((attempt) =>
			attempt < 3 ? Promise.reject(new Error("connection refused")) : new Response(pushable.body, { status: 200 }),
		);

		const unsubscribe = subscribeWorkspaceFileChanges("sess-degraded", fakeQueryClient());
		await vi.advanceTimersByTimeAsync(1);
		expect(getWorkspaceFileConnectionState("sess-degraded")).toBe("connecting");

		await vi.advanceTimersByTimeAsync(1_000);
		expect(getWorkspaceFileConnectionState("sess-degraded")).toBe("connecting");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(getWorkspaceFileConnectionState("sess-degraded")).toBe("degraded");

		await vi.advanceTimersByTimeAsync(5_000);
		expect(getWorkspaceFileConnectionState("sess-degraded")).toBe("connected");
		unsubscribe();
	});

	it("stays connecting rather than degrading while no daemon address is known", async () => {
		hasTrustedApiBaseUrlMock.mockReturnValue(false);
		const impl = stubFetch(() => new Response(pushableBody().body, { status: 200 }));

		const unsubscribe = subscribeWorkspaceFileChanges("sess-untrusted", fakeQueryClient());
		await vi.waitFor(() => expect(getWorkspaceFileConnectionState("sess-untrusted")).toBe("connecting"));

		expect(impl).not.toHaveBeenCalled();
		unsubscribe();
	});

	it("follows the daemon to a new address without waiting out the backoff", async () => {
		const first = pushableBody();
		const second = pushableBody();
		stubFetch((attempt) => new Response(attempt === 0 ? first.body : second.body, { status: 200 }));

		const unsubscribe = subscribeWorkspaceFileChanges("sess-moved", fakeQueryClient());
		await vi.waitFor(() => expect(attempts).toHaveLength(1));

		getApiBaseUrlMock.mockReturnValue("http://desk.local:3001");
		baseUrlListener?.();
		await vi.waitFor(() => expect(attempts).toHaveLength(2));

		expect(attempts[0].signal.aborted).toBe(true);
		expect(attempts[1].url).toBe("http://desk.local:3001/api/v1/sessions/sess-moved/workspace/events");
		unsubscribe();
	});
});
