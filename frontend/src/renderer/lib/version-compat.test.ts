import { describe, expect, it } from "vitest";
import { compareVersions } from "./version-compat";

describe("compareVersions", () => {
	it("reports a match when both sides say the same thing", () => {
		expect(compareVersions("1.4.2", "1.4.2")).toEqual({
			status: "match",
			client: "1.4.2",
			server: "1.4.2",
		});
	});

	it("reports a mismatch with both versions, so the operator knows which to update", () => {
		expect(compareVersions("1.4.2", "1.3.9")).toEqual({
			status: "mismatch",
			client: "1.4.2",
			server: "1.3.9",
		});
	});

	it("does not treat a newer server as a special case", () => {
		// The direction of the drift is not something this client can act on
		// differently: it cannot update the server, and it cannot update itself
		// on the server's say-so. Both directions are the same report.
		expect(compareVersions("1.3.9", "1.4.2").status).toBe("mismatch");
	});

	it("compares exactly rather than by semver range", () => {
		// A build-metadata suffix is a different build. Deciding it was close
		// enough would mean claiming a compatibility range nothing measured.
		expect(compareVersions("1.4.2", "1.4.2+dev").status).toBe("mismatch");
		expect(compareVersions("1.4.2", "1.4.2-rc.1").status).toBe("mismatch");
	});

	it("is unknown, not mismatched, when the server did not say", () => {
		// A daemon started by hand reports no version. Warning about a mismatch
		// there would be a warning about something nobody measured.
		expect(compareVersions("1.4.2", null)).toEqual({
			status: "unknown",
			client: "1.4.2",
			server: null,
		});
	});

	it("is unknown when the client does not know its own version", () => {
		expect(compareVersions(null, "1.4.2")).toEqual({
			status: "unknown",
			client: null,
			server: "1.4.2",
		});
	});

	it("treats an empty or blank version as not said", () => {
		expect(compareVersions("1.4.2", "").status).toBe("unknown");
		expect(compareVersions("1.4.2", "   ").status).toBe("unknown");
	});

	it("ignores surrounding whitespace rather than calling it a mismatch", () => {
		expect(compareVersions("1.4.2", " 1.4.2\n").status).toBe("match");
	});
});
