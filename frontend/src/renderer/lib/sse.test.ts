import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseParser, openEventStream, type SseEvent } from "./sse";

function collect(chunks: string[]): SseEvent[] {
	const seen: SseEvent[] = [];
	const parser = createSseParser((event) => seen.push(event));
	for (const chunk of chunks) parser.push(chunk);
	return seen;
}

describe("createSseParser", () => {
	it("dispatches a frame on the blank line, defaulting the type to message", () => {
		expect(collect(["data: hello\n\n"])).toEqual([{ type: "message", data: "hello", lastEventId: "" }]);
	});

	it("dispatches by event name", () => {
		expect(collect(["event: session_updated\ndata: {}\n\n"])).toEqual([
			{ type: "session_updated", data: "{}", lastEventId: "" },
		]);
	});

	it("joins repeated data fields with newlines and drops only the trailing one", () => {
		expect(collect(["data: one\ndata: two\ndata:\n\n"])).toEqual([
			{ type: "message", data: "one\ntwo\n", lastEventId: "" },
		]);
	});

	it("ignores comment heartbeats", () => {
		expect(collect([": keep-alive\n\n", ":\n\n"])).toEqual([]);
	});

	it("carries the last id forward across frames that omit one", () => {
		expect(collect(["id: 7\ndata: a\n\n", "data: b\n\n"])).toEqual([
			{ type: "message", data: "a", lastEventId: "7" },
			{ type: "message", data: "b", lastEventId: "7" },
		]);
	});

	it("reassembles frames split across chunk boundaries", () => {
		// A network read can end anywhere, including mid-field-name.
		expect(collect(["ev", "ent: pr_up", "dated\nda", "ta: {\"id\":1}\n", "\n"])).toEqual([
			{ type: "pr_updated", data: '{"id":1}', lastEventId: "" },
		]);
	});

	it("strips exactly one space after the colon and tolerates CRLF", () => {
		expect(collect(["data:  padded\r\n\r\n"])).toEqual([{ type: "message", data: " padded", lastEventId: "" }]);
	});

	it("does not dispatch a frame that carried no data", () => {
		expect(collect(["event: named\n\n", "data: real\n\n"])).toEqual([
			{ type: "message", data: "real", lastEventId: "" },
		]);
	});
});

// A readable stream the test pushes into, so a connection can be held open and
// dropped on demand.
function pushableBody() {
	let controller: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	return {
		body: stream,
		push(text: string) {
			controller.enqueue(new TextEncoder().encode(text));
		},
		end() {
			controller.close();
		},
	};
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
	vi.useRealTimers();
});

describe("openEventStream", () => {
	it("reports open, dispatches events, and sends the credential header", async () => {
		const pushable = pushableBody();
		const seenHeaders: Record<string, string>[] = [];
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			seenHeaders.push(init?.headers as Record<string, string>);
			return new Response(pushable.body, { status: 200 });
		}) as unknown as typeof fetch;

		const events: SseEvent[] = [];
		const onOpen = vi.fn();
		const stream = openEventStream({
			url: () => "http://desk.local:3001/api/v1/events",
			headers: () => ({ Authorization: "Bearer hunter2" }),
			onOpen,
			onEvent: (event) => events.push(event),
			fetchImpl,
		});
		await flush();

		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(seenHeaders[0]).toMatchObject({ Accept: "text/event-stream", Authorization: "Bearer hunter2" });

		pushable.push("id: 4\nevent: session_updated\ndata: {}\n\n");
		await flush();

		expect(events).toEqual([{ type: "session_updated", data: "{}", lastEventId: "4" }]);
		stream.close();
	});

	it("resumes from the last id it saw when the stream drops", async () => {
		vi.useFakeTimers();
		const bodies = [pushableBody(), pushableBody()];
		const seenHeaders: Record<string, string>[] = [];
		let attempt = 0;
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			seenHeaders.push(init?.headers as Record<string, string>);
			return new Response(bodies[attempt++].body, { status: 200 });
		}) as unknown as typeof fetch;

		const onDisconnect = vi.fn();
		const stream = openEventStream({
			url: () => "http://desk.local:3001/api/v1/events",
			onDisconnect,
			onEvent: () => {},
			fetchImpl,
			retryDelayMs: () => 10,
		});
		await vi.advanceTimersByTimeAsync(1);

		bodies[0].push("id: 12\ndata: {}\n\n");
		await vi.advanceTimersByTimeAsync(1);
		bodies[0].end();
		await vi.advanceTimersByTimeAsync(1);

		expect(onDisconnect).toHaveBeenCalledTimes(1);
		expect(seenHeaders).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(20);

		expect(seenHeaders).toHaveLength(2);
		expect(seenHeaders[1]["Last-Event-ID"]).toBe("12");
		stream.close();
	});

	it("backs off over repeated failures rather than spinning", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn(async () => {
			throw new Error("connection refused");
		}) as unknown as typeof fetch;

		const stream = openEventStream({
			url: () => "http://desk.local:3001/api/v1/events",
			onEvent: () => {},
			fetchImpl,
			retryDelayMs: (failures) => (failures === 0 ? 10 : 100),
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(10);
		expect(fetchImpl).toHaveBeenCalledTimes(2);

		// Second failure moves to the longer delay, so the first one is not enough.
		await vi.advanceTimersByTimeAsync(10);
		expect(fetchImpl).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(90);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		stream.close();
	});

	it("treats a refusal from the daemon as a drop, not as an open stream", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn(async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
		const onOpen = vi.fn();
		const onDisconnect = vi.fn();

		const stream = openEventStream({
			url: () => "http://desk.local:3001/api/v1/events",
			onOpen,
			onDisconnect,
			onEvent: () => {},
			fetchImpl,
			retryDelayMs: () => 10,
		});
		await vi.advanceTimersByTimeAsync(1);

		expect(onOpen).not.toHaveBeenCalled();
		expect(onDisconnect).toHaveBeenCalledTimes(1);
		stream.close();
	});

	it("stays closed with no retry scheduled while no server is known", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
		const onDisconnect = vi.fn();

		const stream = openEventStream({ url: () => null, onDisconnect, onEvent: () => {}, fetchImpl });
		await vi.advanceTimersByTimeAsync(60_000);

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(onDisconnect).toHaveBeenCalledTimes(1);
		stream.close();
	});

	it("reconnects immediately on restart, without waiting out the backoff", async () => {
		vi.useFakeTimers();
		let url = "http://127.0.0.1:3001/api/v1/events";
		const seenUrls: string[] = [];
		const fetchImpl = vi.fn(async (target: string | URL | Request) => {
			seenUrls.push(String(target));
			throw new Error("connection refused");
		}) as unknown as typeof fetch;

		const stream = openEventStream({
			url: () => url,
			onEvent: () => {},
			fetchImpl,
			retryDelayMs: () => 60_000,
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(seenUrls).toEqual(["http://127.0.0.1:3001/api/v1/events"]);

		url = "http://desk.local:3001/api/v1/events";
		stream.restart();
		await vi.advanceTimersByTimeAsync(1);

		expect(seenUrls).toEqual([
			"http://127.0.0.1:3001/api/v1/events",
			"http://desk.local:3001/api/v1/events",
		]);
		stream.close();
	});

	it("stops reconnecting once closed", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn(async () => {
			throw new Error("connection refused");
		}) as unknown as typeof fetch;

		const stream = openEventStream({
			url: () => "http://desk.local:3001/api/v1/events",
			onEvent: () => {},
			fetchImpl,
			retryDelayMs: () => 10,
		});
		await vi.advanceTimersByTimeAsync(1);
		stream.close();

		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
