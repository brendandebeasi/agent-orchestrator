import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { hostCapability, useHostCapability } from "./useHostCapability";
import { setLocalServerTarget, setRemoteServerTarget } from "../lib/server-target";
import { HOST_CAPABILITY_NAMES } from "../../shared/host-capabilities";

// Restore the default target so a case that connects somewhere else does not
// leak a remote target into the next one — the store is a module singleton.
afterEach(() => {
	setLocalServerTarget(null);
});

describe("hostCapability", () => {
	it("reports a capability the host declares against a local server as available", () => {
		setLocalServerTarget("http://127.0.0.1:3001");
		expect(hostCapability("editorHandoff")).toEqual({
			available: true,
			reasonKey: null,
			serverLabel: "This computer",
		});
	});

	it("withdraws every host-bound capability once the server is on another machine", () => {
		setRemoteServerTarget({ baseUrl: "http://10.0.0.4:3001", label: "workshop", credential: "pw" });
		for (const name of HOST_CAPABILITY_NAMES) {
			expect(hostCapability(name)).toEqual({
				available: false,
				reasonKey: "hostCapability.needsLocalServer",
				serverLabel: "workshop",
			});
		}
	});

	it("blames the host, not the server, when the host declares nothing", async () => {
		// The browser stub is the host shape that declares nothing, so load the
		// module graph with `window.ao` absent rather than hand-editing the bridge.
		const realAo = window.ao;
		delete window.ao;
		try {
			const { vi } = await import("vitest");
			vi.resetModules();
			const capability = await import("./useHostCapability");
			const store = await import("../lib/server-target");
			store.setLocalServerTarget("http://127.0.0.1:3001");
			expect(capability.hostCapability("browserPanel")).toMatchObject({
				available: false,
				reasonKey: "hostCapability.needsDesktopApp",
			});
			vi.resetModules();
		} finally {
			window.ao = realAo;
		}
	});
});

describe("useHostCapability", () => {
	it("re-renders when the operator connects to another server", () => {
		setLocalServerTarget("http://127.0.0.1:3001");
		const { result } = renderHook(() => useHostCapability("directoryPicker"));
		expect(result.current.available).toBe(true);

		act(() => {
			setRemoteServerTarget({ baseUrl: "http://10.0.0.4:3001", label: "workshop", credential: "pw" });
		});
		expect(result.current.available).toBe(false);
		expect(result.current.reasonKey).toBe("hostCapability.needsLocalServer");
	});

	it("returns a stable object across renders so the store does not loop", () => {
		setLocalServerTarget("http://127.0.0.1:3001");
		const { result, rerender } = renderHook(() => useHostCapability("editorHandoff"));
		const first = result.current;
		rerender();
		expect(result.current).toBe(first);
	});
});

// ---------------------------------------------------------------------------
// The gating guard.
//
// The capability model is only worth anything if every call site agrees on what
// it means, and the cheapest way for that to stop being true is for one module
// to read `capabilities` directly and skip the server-locality half of the
// question. That failure is silent — the feature works locally and misbehaves
// only against a remote server — so it is caught here instead.
// ---------------------------------------------------------------------------

const OWNER = path.join("hooks", "useHostCapability.ts");
const CAPABILITY_READ = /\bcapabilities\s*(\[|\.)/;

function sourceFiles(root: string, prefix = ""): { relative: string; source: string }[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const relative = path.join(prefix, entry.name);
		const absolute = path.join(root, entry.name);
		if (entry.isDirectory()) return sourceFiles(absolute, relative);
		if (!/\.tsx?$/.test(entry.name)) return [];
		return [{ relative, source: readFileSync(absolute, "utf8") }];
	});
}

describe("capability gating is not bypassed", () => {
	it("reads aoBridge.capabilities from the hook module and nowhere else", () => {
		const offenders = sourceFiles(path.resolve(process.cwd(), "src/renderer"))
			.filter(({ relative }) => relative !== OWNER)
			.filter(({ relative }) => !relative.endsWith(".test.ts") && !relative.endsWith(".test.tsx"))
			.filter(({ source }) => CAPABILITY_READ.test(source))
			.map(({ relative }) => relative);
		expect(offenders).toEqual([]);
	});

	it("flags a deliberate violation, so the guard above is not vacuous", () => {
		expect(CAPABILITY_READ.test('if (aoBridge.capabilities.editorHandoff) open();')).toBe(true);
		expect(CAPABILITY_READ.test('const on = window.ao?.capabilities["browserPanel"];')).toBe(true);
		// And does not fire on the words appearing in prose or in an import.
		expect(CAPABILITY_READ.test("// what the host capabilities are for")).toBe(false);
		expect(CAPABILITY_READ.test('import { HOST_CAPABILITY_NAMES } from "../../shared/host-capabilities";')).toBe(false);
	});
});
