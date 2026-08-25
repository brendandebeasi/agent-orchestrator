import { describe, expect, it } from "vitest";
import {
	REMOTE_SESSION_TOKEN_KEY,
	REMOTE_SESSION_VERSION_KEY,
	readRemoteSession,
} from "./remote-session";

function storage(entries: Record<string, string>): Pick<Storage, "getItem"> {
	return { getItem: (key: string) => entries[key] ?? null };
}

describe("readRemoteSession", () => {
	it("reads the token and version the login page stored", () => {
		expect(
			readRemoteSession(
				storage({ [REMOTE_SESSION_TOKEN_KEY]: "hunter2", [REMOTE_SESSION_VERSION_KEY]: "1.4.2" }),
			),
		).toEqual({ token: "hunter2", appVersion: "1.4.2" });
	});

	it("reports an empty version rather than none, since a CLI daemon has one to report", () => {
		// The exchange returns "" when no app launched the daemon, and the login
		// page stores exactly that. It is a session; it just has no version.
		expect(readRemoteSession(storage({ [REMOTE_SESSION_TOKEN_KEY]: "hunter2" }))).toEqual({
			token: "hunter2",
			appVersion: "",
		});
	});

	it("finds nothing in a tab that never exchanged a password", () => {
		expect(readRemoteSession(storage({}))).toBeNull();
	});

	it("treats an empty token as no session, not as a credential worth presenting", () => {
		expect(readRemoteSession(storage({ [REMOTE_SESSION_TOKEN_KEY]: "" }))).toBeNull();
	});

	it("survives a storage that raises instead of answering", () => {
		// Safari's private mode and some enterprise policies do this. The recovery
		// is the same as for an absent session, so failing the launch to report it
		// would cost the operator a page and tell them nothing they can act on.
		const hostile: Pick<Storage, "getItem"> = {
			getItem: () => {
				throw new Error("access denied");
			},
		};

		expect(readRemoteSession(hostile)).toBeNull();
	});

	it("survives a host with no storage at all", () => {
		expect(readRemoteSession(null)).toBeNull();
		expect(readRemoteSession(undefined)).toBeNull();
	});
});
