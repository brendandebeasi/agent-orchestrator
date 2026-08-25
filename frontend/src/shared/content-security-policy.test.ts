import { describe, expect, it } from "vitest";
import { posthogOrigins, rendererContentSecurityPolicy } from "./content-security-policy";

/** The value of one directive, so a test can assert on it without the rest. */
function directive(policy: string, name: string): string {
	const found = policy.split("; ").find((entry) => entry === name || entry.startsWith(`${name} `));
	if (found === undefined) throw new Error(`policy has no ${name} directive: ${policy}`);
	return found;
}

describe("what every page is allowed to do", () => {
	const everyHost = [
		{ label: "a desktop launch running its own daemon", daemon: { kind: "loopback" } as const },
		{ label: "a browser client", daemon: { kind: "sameOrigin" } as const },
		{ label: "a desktop launch attached to a server", daemon: { kind: "remote", baseUrl: "http://box:3010" } as const },
	];

	it.each(everyHost)("runs only its own scripts on $label", ({ daemon }) => {
		// The directive that does the real work. Widening where the client may
		// send data is a considered trade for a client whose job is to talk to a
		// server the operator names; letting someone else's script run is not.
		expect(directive(rendererContentSecurityPolicy({ daemon }), "script-src")).toBe("script-src 'self'");
	});

	it.each(everyHost)("closes the usual ways around script-src on $label", ({ daemon }) => {
		const policy = rendererContentSecurityPolicy({ daemon });
		expect(directive(policy, "default-src")).toBe("default-src 'self'");
		expect(directive(policy, "object-src")).toBe("object-src 'none'");
		expect(directive(policy, "base-uri")).toBe("base-uri 'self'");
		expect(directive(policy, "frame-src")).toBe("frame-src 'none'");
	});
});

describe("a desktop launch running its own daemon", () => {
	const policy = rendererContentSecurityPolicy({ daemon: { kind: "loopback" } });

	it("may reach a daemon on any loopback port, because the port is not known until one starts", () => {
		expect(directive(policy, "connect-src")).toBe("connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*");
	});

	it("may not reach anything off this machine", () => {
		// Named hosts only. A scheme-wide source (`http:`, `https:`) would be the
		// easy way to make remote mode work everywhere and would permit every
		// server on the internet to a client that talks to exactly one.
		const sources = directive(policy, "connect-src").split(" ").slice(1);
		expect(sources.filter((source) => /^\w+:$/.test(source))).toEqual([]);
		expect(sources.every((source) => source === "'self'" || source.includes("127.0.0.1"))).toBe(true);
	});
});

describe("a desktop launch attached to a server elsewhere", () => {
	it("may reach that server over both HTTP and WebSocket", () => {
		// CSP counts ws://host and http://host as different sources even though
		// they are one server, so a policy naming only the first blocks every
		// terminal stream while the session list loads fine — which reads as a
		// terminal bug rather than a policy one.
		const policy = rendererContentSecurityPolicy({ daemon: { kind: "remote", baseUrl: "http://box:3010" } });

		expect(directive(policy, "connect-src")).toContain("http://box:3010");
		expect(directive(policy, "connect-src")).toContain("ws://box:3010");
	});

	it("uses the encrypted schemes for a server reached over HTTPS", () => {
		const policy = rendererContentSecurityPolicy({
			daemon: { kind: "remote", baseUrl: "https://box.example.com" },
		});

		expect(directive(policy, "connect-src")).toContain("https://box.example.com");
		expect(directive(policy, "connect-src")).toContain("wss://box.example.com");
	});

	it("may still reach loopback, which is where the rest of this client's parts are", () => {
		const policy = rendererContentSecurityPolicy({ daemon: { kind: "remote", baseUrl: "http://box:3010" } });

		expect(directive(policy, "connect-src")).toContain("http://127.0.0.1:*");
	});

	it("may load the server's images, which come from the same origin as its API", () => {
		const policy = rendererContentSecurityPolicy({ daemon: { kind: "remote", baseUrl: "http://box:3010" } });

		expect(directive(policy, "img-src")).toContain("http://box:3010");
		// A WebSocket origin in img-src would be meaningless.
		expect(directive(policy, "img-src")).not.toContain("ws://");
	});

	it("permits nothing extra when the address is not one, rather than permitting everything", () => {
		const policy = rendererContentSecurityPolicy({ daemon: { kind: "remote", baseUrl: "not a url" } });

		expect(directive(policy, "connect-src")).toBe("connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*");
	});
});

describe("a browser client", () => {
	const policy = rendererContentSecurityPolicy({ daemon: { kind: "sameOrigin" } });

	it("needs nothing beyond its own origin, which is the daemon that served it", () => {
		expect(directive(policy, "connect-src")).toBe("connect-src 'self'");
		expect(directive(policy, "img-src")).toBe("img-src 'self' data:");
	});

	it("is not handed this computer's loopback, which is not its daemon and may not be anything", () => {
		expect(directive(policy, "connect-src")).not.toContain("127.0.0.1");
	});
});

describe("telemetry origins", () => {
	it("are permitted where the caller names them", () => {
		const policy = rendererContentSecurityPolicy({
			daemon: { kind: "loopback" },
			telemetry: ["https://us.i.posthog.com"],
		});

		expect(directive(policy, "connect-src")).toContain("https://us.i.posthog.com");
	});

	it("include the sibling host PostHog Cloud fetches remote config from", () => {
		expect(posthogOrigins("https://us.i.posthog.com")).toEqual([
			"https://us.i.posthog.com",
			"https://us-assets.i.posthog.com",
		]);
	});

	it("are a single origin for a self-hosted instance, which serves everything from one", () => {
		expect(posthogOrigins("https://telemetry.example.com")).toEqual(["https://telemetry.example.com"]);
	});

	it("are none at all when telemetry has no host, rather than a broken entry", () => {
		expect(posthogOrigins("")).toEqual([]);
		expect(posthogOrigins("   ")).toEqual([]);
		expect(posthogOrigins("not a url")).toEqual([]);
	});
});
