import { afterEach, describe, expect, it, vi } from "vitest";
import type { AoBridge } from "../../preload";
import { type HostCapabilityName, NO_HOST_CAPABILITIES } from "../../shared/host-capabilities";

/**
 * Load `bridge.ts` with no Electron preload behind the window.
 *
 * The module resolves `window.ao ?? stub` once at import time, and the shared
 * test setup installs a desktop double on `window.ao` for every other suite.
 * These cases are about the other branch, so the double comes off and the
 * module registry is reset to force a fresh evaluation.
 */
async function loadBrowserBridge() {
	const host = window.ao;
	// Deleted rather than set to undefined: the `??` in bridge.ts treats the two
	// the same, but the property staying visible on the window would leave other
	// probes disagreeing about whether a host is there.
	delete (window as { ao?: AoBridge }).ao;
	vi.resetModules();
	try {
		return (await import("./bridge")).aoBridge;
	} finally {
		window.ao = host;
	}
}

/**
 * Which parts of the bridge each host capability speaks for.
 *
 * Only these are the subject of this suite. The rest of the stub answers
 * questions a browser can genuinely answer — the clipboard through
 * `navigator.clipboard`, UI settings from the shared defaults, updates as idle
 * because a web page does not update itself — and those answers are truthful,
 * not placeholders. What is claimed here is narrower and is the whole point of
 * the capability flags: if the host says it cannot do a thing, the methods
 * behind that thing must say so too, at the call site that forgot to check,
 * rather than resolving to a plausible nothing three screens earlier.
 *
 * The lists are namespace prefixes and exact paths rather than an enumeration
 * of today's methods on purpose. Adding `browser.somethingNew` with a
 * nothing-stub fails this suite until it either throws or is written into the
 * exceptions below with a reason.
 */
const CAPABILITY_SURFACE: Record<HostCapabilityName, { exact?: string[]; prefix?: string[] }> = {
	browserPanel: { prefix: ["browser."] },
	directoryPicker: {
		exact: ["app.chooseDirectory", "app.scanImportFolder", "app.checkAncestorRepo"],
	},
	// Both of these are served by the same pair of methods: revealing a folder
	// is the `file-manager` target of the editor handoff, not a method of its
	// own. They are separate capabilities because a host can plausibly have one
	// without the other, but the surface they guard is shared.
	editorHandoff: { prefix: ["editorHandoff."] },
	revealInFileManager: { prefix: ["editorHandoff."] },
};

/**
 * Capability-owned members that stay non-throwing, and why.
 *
 * Both reasons are about *when* the renderer reaches them. A value read to
 * choose a render path has to yield a value, and a subscription registered in a
 * mount effect runs before the component knows whether it will ever have a view
 * — throwing there would take out the panel on mount to prevent nothing, since
 * a listener that is never called and a listener that was never registered look
 * identical to the caller.
 */
const NOT_THROWING = new Set(["browser.nativeCompositionEnabled"]);
const isSubscription = (path: string) => /\.on[A-Z]/.test(path);

/** Collect every leaf of the stub as a dotted path. */
function leafPaths(value: unknown, prefix = ""): string[] {
	if (value === null || typeof value !== "object") return prefix ? [prefix] : [];
	return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

function surfaceOf(capability: HostCapabilityName, all: string[]) {
	const { exact = [], prefix = [] } = CAPABILITY_SURFACE[capability];
	return all.filter((path) => exact.includes(path) || prefix.some((p) => path.startsWith(p)));
}

function at(bridge: AoBridge, path: string) {
	return path.split(".").reduce<any>((node, key) => node[key], bridge);
}

afterEach(() => {
	vi.resetModules();
});

describe("the bridge stub in a browser tab", () => {
	it("reports every host capability off", async () => {
		const bridge = await loadBrowserBridge();
		expect(bridge.capabilities).toEqual(NO_HOST_CAPABILITIES);
	});

	it.each(Object.keys(NO_HOST_CAPABILITIES) as HostCapabilityName[])(
		"throws from everything behind %s rather than resolving to nothing",
		async (capability) => {
			const bridge = await loadBrowserBridge();
			expect(bridge.capabilities[capability]).toBe(false);

			const guarded = surfaceOf(capability, leafPaths(bridge)).filter(
				(path) => !NOT_THROWING.has(path) && !isSubscription(path),
			);
			// Without this the assertions below pass by iterating nothing, which
			// is exactly how a renamed namespace would slip through.
			expect(guarded.length, `no methods matched ${capability}`).toBeGreaterThan(0);

			const answered: string[] = [];
			for (const path of guarded) {
				try {
					// Sync throwers throw on call; async ones reject, and awaiting
					// turns that into the same throw.
					await at(bridge, path)();
					answered.push(path);
				} catch (err) {
					expect(err, path).toBeInstanceOf(Error);
					// The message has to name the method, because the stack it comes
					// from is the stub's, not the caller's.
					expect((err as Error).message, path).toContain(path);
					expect((err as Error).message, path).toContain("This is a bug");
				}
			}
			expect(answered, "these still resolve to a plausible nothing").toEqual([]);
		},
	);

	it("keeps the browser view's subscriptions and its composition flag harmless", async () => {
		const bridge = await loadBrowserBridge();
		const subscriptions = leafPaths(bridge).filter((path) => path.startsWith("browser.") && isSubscription(path));
		expect(subscriptions.length).toBeGreaterThan(0);

		expect(bridge.browser.nativeCompositionEnabled).toBe(false);
		for (const path of subscriptions) {
			const unsubscribe = at(bridge, path)(() => undefined);
			expect(typeof unsubscribe, path).toBe("function");
			expect(() => unsubscribe(), path).not.toThrow();
		}
	});

	it("says plainly that it remembers no servers instead of failing the ask", async () => {
		// A browser tab has nowhere safe to keep a password, and it does not need
		// one: the session cookie the daemon set is what survives a reload. So the
		// remoteServers surface is not capability-gated like the rest — it has a
		// true answer to give, and callers get an empty list rather than an error
		// they would each have to handle.
		const bridge = await loadBrowserBridge();

		await expect(bridge.remoteServers.list()).resolves.toEqual([]);
		await expect(
			bridge.remoteServers.save({
				server: { baseUrl: "http://box:3010", label: "box:3010", lastConnectedAt: "2026-08-01T00:00:00.000Z" },
				credential: "hunter2",
			}),
		).resolves.toEqual([]);
		await expect(bridge.remoteServers.readCredential("http://box:3010")).resolves.toBeNull();
		await expect(bridge.remoteServers.remove("http://box:3010")).resolves.toEqual([]);
	});

	it("still answers the questions a browser can answer for itself", async () => {
		const bridge = await loadBrowserBridge();

		await expect(bridge.app.getVersion()).resolves.toBe("0.0.0-preview");

		const open = vi.spyOn(window, "open").mockReturnValue(null);
		await bridge.app.openExternal("https://example.com");
		expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
		open.mockRestore();
	});
});
