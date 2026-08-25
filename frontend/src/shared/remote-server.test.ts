import { describe, expect, it } from "vitest";
import { normalizeServerAddress, remoteServerFromArgv, serverLabelFromAddress } from "./remote-server";

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

describe("reading remote mode out of process arguments", () => {
	it("is absent for a normal launch", () => {
		expect(remoteServerFromArgv(["/path/to/electron", "."])).toBeNull();
	});

	it("finds the address the supervisor passed", () => {
		expect(remoteServerFromArgv(["electron", "--ao-remote-server=http://box:3010"])).toBe("http://box:3010");
	});

	it("ignores an address someone appended by hand that cannot be one", () => {
		// The supervisor only ever writes a normalized address, so anything else
		// arrived some other way, and starting locally beats sending every
		// request to a mangled origin.
		expect(remoteServerFromArgv(["electron", "--ao-remote-server=::::"])).toBeNull();
		expect(remoteServerFromArgv(["electron", "--ao-remote-server="])).toBeNull();
	});
});
