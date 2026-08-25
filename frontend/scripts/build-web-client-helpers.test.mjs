// @vitest-environment node
import { describe, expect, it } from "vitest";
import { rootRelativeAssetReferences, staleBundleEntries } from "./build-web-client-helpers.mjs";

describe("staleBundleEntries", () => {
	it("keeps the two files a clean checkout needs and removes the rest", () => {
		// .gitkeep is load-bearing: webclient_webui.go embeds this directory, and
		// go:embed refuses to compile against one that is not there. Deleting it as
		// part of a build would break the next checkout rather than this one, which
		// is the kind of breakage nobody traces back to a build script.
		expect(
			staleBundleEntries([".gitignore", ".gitkeep", "index.html", "assets", "favicon.ico"]),
		).toEqual(["index.html", "assets", "favicon.ico"]);
	});

	it("removes the previous build's hashed assets rather than adding to them", () => {
		expect(staleBundleEntries(["assets", ".gitkeep"])).toEqual(["assets"]);
	});

	it("finds nothing to remove in a directory that has never been built into", () => {
		expect(staleBundleEntries([".gitignore", ".gitkeep"])).toEqual([]);
	});
});

describe("rootRelativeAssetReferences", () => {
	it("reports a script the browser would fetch from the daemon's API root", () => {
		// The failure this exists to catch: the bundle builds, the daemon serves
		// /app/index.html, and the page asks for /assets/index-abc.js — a path the
		// daemon routes nowhere near the client. The symptom is a blank page and a
		// MIME-type error, neither of which points at a build option.
		expect(rootRelativeAssetReferences('<script type="module" src="/assets/index-abc.js"></script>')).toEqual([
			"/assets/index-abc.js",
		]);
	});

	it("reports a stylesheet the same way, since a page can lose its styling alone", () => {
		expect(rootRelativeAssetReferences('<link rel="stylesheet" href="/assets/index-abc.css">')).toEqual([
			"/assets/index-abc.css",
		]);
	});

	it("accepts the document-relative references a correctly based build emits", () => {
		expect(
			rootRelativeAssetReferences(
				'<script type="module" src="./assets/index-abc.js"></script><link rel="stylesheet" href="./assets/index-abc.css">',
			),
		).toEqual([]);
	});

	it("leaves absolute and protocol-relative URLs alone, which are a policy question and not this one", () => {
		expect(
			rootRelativeAssetReferences('<img src="https://example.com/logo.png"><script src="//cdn.example.com/x.js">'),
		).toEqual([]);
	});

	it("reports every offender, so one build tells the whole story", () => {
		expect(
			rootRelativeAssetReferences('<link href="/a.css"><script src="/b.js"></script><link href="./c.css">'),
		).toEqual(["/a.css", "/b.js"]);
	});
});
