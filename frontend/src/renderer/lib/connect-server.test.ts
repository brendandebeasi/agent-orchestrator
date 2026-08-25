import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	connectToServer,
	isConnectedToRemoteServer,
	normalizeServerAddress,
	probeServer,
	serverLabelFromAddress,
} from "./connect-server";
import { getServerConnection, resetServerConnectionForTest } from "./server-connection";
import { getServerCredential, getServerTarget, setLocalServerTarget } from "./server-target";

const DAEMON_BODY = { service: "agent-orchestrator-daemon", status: "ok", appVersion: "1.4.2" };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

function stubFetch(): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	setLocalServerTarget(null);
	resetServerConnectionForTest();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	setLocalServerTarget(null);
	resetServerConnectionForTest();
});

describe("normalizeServerAddress", () => {
	it("adds the scheme people leave off", () => {
		expect(normalizeServerAddress("192.168.1.9:3010")).toBe("http://192.168.1.9:3010");
		expect(normalizeServerAddress("my-box.tailnet.ts.net")).toBe("http://my-box.tailnet.ts.net");
	});

	it("keeps a scheme that was given, including https", () => {
		expect(normalizeServerAddress("https://ao.example.com")).toBe("https://ao.example.com");
		expect(normalizeServerAddress("HTTP://Box:3010")).toBe("http://box:3010");
	});

	it("drops a path, query, or fragment rather than rejecting the address", () => {
		// The usual way one appears is a paste out of a browser already on the
		// web client, which is a correct address with extra on the end.
		expect(normalizeServerAddress("http://box:3010/app/board?x=1#y")).toBe("http://box:3010");
	});

	it("trims surrounding whitespace", () => {
		expect(normalizeServerAddress("  box:3010\n")).toBe("http://box:3010");
	});

	it("rejects input that cannot be an origin", () => {
		expect(normalizeServerAddress("")).toBeNull();
		expect(normalizeServerAddress("   ")).toBeNull();
		expect(normalizeServerAddress("http://")).toBeNull();
		expect(normalizeServerAddress("::::")).toBeNull();
	});
});

describe("serverLabelFromAddress", () => {
	it("is the host, without the scheme", () => {
		expect(serverLabelFromAddress("http://box:3010")).toBe("box:3010");
		expect(serverLabelFromAddress("https://ao.example.com")).toBe("ao.example.com");
	});

	it("hands back whatever it was given when that is not a URL", () => {
		expect(serverLabelFromAddress("not a url")).toBe("not a url");
	});
});

describe("probeServer", () => {
	it("asks /healthz with the password as a bearer token", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(jsonResponse(DAEMON_BODY));

		await probeServer({ baseUrl: "http://box:3010", credential: "hunter2" });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://box:3010/healthz");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer hunter2");
		// A cached 200 from a daemon that has since stopped is the worst
		// possible answer to this question.
		expect(init.cache).toBe("no-store");
	});

	it("reports the version the daemon named", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(jsonResponse(DAEMON_BODY));

		await expect(probeServer({ baseUrl: "http://box:3010", credential: "hunter2" })).resolves.toEqual({
			outcome: "connected",
			appVersion: "1.4.2",
		});
	});

	it("connects with a null version when the daemon has none to report", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(jsonResponse({ service: "agent-orchestrator-daemon", status: "ok" }));

		await expect(probeServer({ baseUrl: "http://box:3010", credential: "hunter2" })).resolves.toEqual({
			outcome: "connected",
			appVersion: null,
		});
	});

	it("treats an empty version string as not said", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(jsonResponse({ ...DAEMON_BODY, appVersion: "" }));

		const probe = await probeServer({ baseUrl: "http://box:3010", credential: "hunter2" });
		expect(probe).toEqual({ outcome: "connected", appVersion: null });
	});

	it("separates a wrong password from an unreachable address", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(new Response("", { status: 401 }));

		await expect(probeServer({ baseUrl: "http://box:3010", credential: "wrong" })).resolves.toEqual({
			outcome: "rejected",
		});
	});

	it("treats 403 as a rejected password too", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(new Response("", { status: 403 }));

		const probe = await probeServer({ baseUrl: "http://box:3010", credential: "wrong" });
		expect(probe.outcome).toBe("rejected");
	});

	it("separates a lockout from a rejection, because waiting is the fix", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(new Response("", { status: 429 }));

		await expect(probeServer({ baseUrl: "http://box:3010", credential: "hunter2" })).resolves.toEqual({
			outcome: "lockedOut",
		});
	});

	it("calls a non-daemon answer what it is rather than unreachable", async () => {
		const fetchMock = stubFetch();
		// A router admin page on a reused port answers, so the address is not
		// wrong in the way "unreachable" implies.
		fetchMock.mockResolvedValue(new Response("<html>Router</html>", { status: 200 }));

		await expect(probeServer({ baseUrl: "http://box:3010", credential: "hunter2" })).resolves.toEqual({
			outcome: "notADaemon",
		});
	});

	it("rejects JSON from some other service", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(jsonResponse({ service: "grafana", status: "ok" }));

		const probe = await probeServer({ baseUrl: "http://box:3010", credential: "hunter2" });
		expect(probe.outcome).toBe("notADaemon");
	});

	it("rejects a 5xx as not a daemon behaving like one", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(new Response("", { status: 502 }));

		const probe = await probeServer({ baseUrl: "http://box:3010", credential: "hunter2" });
		expect(probe.outcome).toBe("notADaemon");
	});

	it("reports unreachable when the request never produced a response", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

		await expect(probeServer({ baseUrl: "http://box:3010", credential: "hunter2" })).resolves.toEqual({
			outcome: "unreachable",
			detail: "Failed to fetch",
		});
	});

	it("names a caller cancellation as cancelled, not as a timeout", async () => {
		const fetchMock = stubFetch();
		const controller = new AbortController();
		fetchMock.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				}),
		);

		const probe = probeServer({
			baseUrl: "http://box:3010",
			credential: "hunter2",
			signal: controller.signal,
		});
		controller.abort();

		await expect(probe).resolves.toEqual({ outcome: "unreachable", detail: "cancelled" });
	});

	it("gives up on a server that accepts the connection and never answers", async () => {
		vi.useFakeTimers();
		const fetchMock = stubFetch();
		fetchMock.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				}),
		);

		const probe = probeServer({ baseUrl: "http://box:3010", credential: "hunter2" });
		await vi.advanceTimersByTimeAsync(10_000);

		await expect(probe).resolves.toEqual({ outcome: "unreachable", detail: "timeout" });
	});
});

describe("connectToServer", () => {
	it("points the client at a server that answered, and records its version", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(jsonResponse(DAEMON_BODY));

		const probe = await connectToServer({ baseUrl: "http://box:3010", credential: "hunter2" });

		expect(probe.outcome).toBe("connected");
		expect(getServerTarget()).toMatchObject({
			kind: "remote",
			baseUrl: "http://box:3010",
			label: "box:3010",
			requiresAuth: true,
		});
		expect(getServerCredential()).toBe("hunter2");
		expect(getServerConnection().versions).toEqual({
			status: "unknown",
			client: null,
			server: "1.4.2",
		});
	});

	it("prefers a caller-supplied label over the host", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(jsonResponse(DAEMON_BODY));

		await connectToServer({ baseUrl: "http://box:3010", credential: "hunter2", label: "Closet server" });

		expect(getServerTarget().label).toBe("Closet server");
	});

	it("leaves the client where it was when the password is wrong", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValueOnce(jsonResponse(DAEMON_BODY));
		await connectToServer({ baseUrl: "http://box:3010", credential: "hunter2" });

		fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
		const probe = await connectToServer({ baseUrl: "http://other:3010", credential: "wrong" });

		// An operator who mistypes while connected must not lose the connection
		// they had.
		expect(probe.outcome).toBe("rejected");
		expect(getServerTarget().baseUrl).toBe("http://box:3010");
		expect(getServerCredential()).toBe("hunter2");
	});

	it("does not leave the previous server's version attached to a new one", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValueOnce(jsonResponse(DAEMON_BODY));
		await connectToServer({ baseUrl: "http://box:3010", credential: "hunter2" });

		fetchMock.mockResolvedValueOnce(jsonResponse({ ...DAEMON_BODY, appVersion: undefined }));
		await connectToServer({ baseUrl: "http://other:3010", credential: "hunter2" });

		expect(getServerConnection().versions.server).toBeNull();
	});
});

describe("isConnectedToRemoteServer", () => {
	it("is false for the daemon on this computer", () => {
		setLocalServerTarget("http://127.0.0.1:3001");
		expect(isConnectedToRemoteServer()).toBe(false);
	});

	it("is true once a remote server has been reached", async () => {
		const fetchMock = stubFetch();
		fetchMock.mockResolvedValue(jsonResponse(DAEMON_BODY));

		await connectToServer({ baseUrl: "http://box:3010", credential: "hunter2" });

		expect(isConnectedToRemoteServer()).toBe(true);
	});
});
