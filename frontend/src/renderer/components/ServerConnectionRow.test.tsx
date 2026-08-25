import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setEventsConnectionState } from "../lib/events-connection";
import { resetServerConnectionForTest, setClientVersion, setServerVersion } from "../lib/server-connection";
import { setLocalServerTarget, setRemoteServerTarget } from "../lib/server-target";
import { createTerminalMux, createTerminalMuxPool } from "../lib/terminal-mux";
import { ServerConnectionRail, ServerConnectionRow } from "./ServerConnectionRow";
import { TooltipProvider } from "./ui/tooltip";

beforeEach(() => {
	setLocalServerTarget(null);
	setEventsConnectionState("idle");
	resetServerConnectionForTest();
});

afterEach(() => {
	setLocalServerTarget(null);
	setEventsConnectionState("idle");
	resetServerConnectionForTest();
});

/** Point the client at a remote server with the change stream already open. */
function connectedToBox(): void {
	act(() => {
		setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "x" });
		setEventsConnectionState("connected");
	});
}

function renderRail() {
	return render(
		<TooltipProvider>
			<ServerConnectionRail tabIndex={0} />
		</TooltipProvider>,
	);
}

describe("naming the server the client is talking to", () => {
	it("says nothing when the daemon is on this computer", () => {
		act(() => setLocalServerTarget("http://127.0.0.1:3001"));
		render(<ServerConnectionRow tabIndex={0} />);

		// A permanent "This computer" chip would be noise in every window that
		// has never been pointed anywhere else.
		expect(screen.queryByTestId("server-connection")).not.toBeInTheDocument();
	});

	it("names the machine once the client is aimed at one", () => {
		connectedToBox();
		render(<ServerConnectionRow tabIndex={0} />);

		expect(screen.getByTestId("server-connection")).toHaveTextContent("box:3010");
	});

	it("announces the connection for an operator who cannot see the sidebar", () => {
		connectedToBox();
		render(<ServerConnectionRow tabIndex={0} />);

		expect(screen.getByRole("status")).toHaveTextContent("Connected to box:3010");
	});

	it("carries the same facts into the collapsed rail", () => {
		connectedToBox();
		renderRail();

		expect(screen.getByTestId("server-connection-rail")).toHaveAccessibleName("Connected to box:3010");
	});
});

describe("when the link to the server drops", () => {
	it("says it is reconnecting rather than leaving the name looking live", () => {
		connectedToBox();
		render(<ServerConnectionRow tabIndex={0} />);

		act(() => setEventsConnectionState("disconnected"));

		expect(screen.getByTestId("server-connection")).toHaveAttribute("data-state", "reconnecting");
		expect(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
	});

	it("stops saying so once the stream comes back", () => {
		connectedToBox();
		render(<ServerConnectionRow tabIndex={0} />);
		act(() => setEventsConnectionState("disconnected"));

		act(() => setEventsConnectionState("connected"));

		expect(screen.getByTestId("server-connection")).toHaveAttribute("data-state", "connected");
	});

	it("says nothing during the gap before the first stream opens", () => {
		// Reporting a problem here would make every launch look like an outage.
		act(() => setRemoteServerTarget({ baseUrl: "http://box:3010", label: "box:3010", credential: "x" }));
		render(<ServerConnectionRow tabIndex={0} />);

		expect(screen.getByTestId("server-connection")).toHaveAttribute("data-state", "connected");
		expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
	});

	it("follows the operator to a new server instead of reporting the old one", () => {
		connectedToBox();
		render(<ServerConnectionRow tabIndex={0} />);
		act(() => setEventsConnectionState("disconnected"));

		// Moving is the event transport's cue to drop the old server's verdict and
		// go back to idle — see the matching case in event-transport.test.ts — so
		// what reaches the row is a new name with nothing yet known about it.
		act(() => {
			setRemoteServerTarget({ baseUrl: "http://other:3010", label: "other:3010", credential: "x" });
			setEventsConnectionState("idle");
		});

		expect(screen.getByTestId("server-connection")).toHaveTextContent("other:3010");
		expect(screen.queryByText("Reconnecting…")).not.toBeInTheDocument();
	});

	it("shows the drop in the collapsed rail too", () => {
		connectedToBox();
		renderRail();

		act(() => setEventsConnectionState("disconnected"));

		expect(screen.getByTestId("server-connection-rail")).toHaveAccessibleName("box:3010 — Reconnecting…");
	});
});

describe("a dropped terminal socket", () => {
	/** Enough of a WebSocket to open one and drop it. */
	class FakeSocket {
		static OPEN = 1;
		static instances: FakeSocket[] = [];
		readyState = 0;
		private listeners: Record<string, ((ev: unknown) => void)[]> = {};
		constructor(
			public url: string,
			public protocols: string | string[] = [],
		) {
			FakeSocket.instances.push(this);
		}
		addEventListener(type: string, cb: (ev: unknown) => void) {
			(this.listeners[type] ??= []).push(cb);
		}
		send() {}
		close() {}
		emitOpen() {
			this.readyState = FakeSocket.OPEN;
			this.listeners.open?.forEach((cb) => cb({}));
		}
		emitClose() {
			this.listeners.close?.forEach((cb) => cb({}));
		}
	}

	afterEach(() => {
		FakeSocket.instances = [];
	});

	it("is reported to the terminal that owns it and not to the sidebar", () => {
		connectedToBox();
		render(<ServerConnectionRow tabIndex={0} />);
		const pool = createTerminalMuxPool(() =>
			createTerminalMux("ws://box:3010/mux", FakeSocket as unknown as typeof WebSocket),
		);
		const lease = pool.acquire();
		const states: string[] = [];
		lease.onConnectionChange((state) => states.push(state));

		act(() => {
			FakeSocket.instances[0].emitOpen();
			FakeSocket.instances[0].emitClose();
		});

		// The pane that was reading it says so itself, and reattaches.
		expect(states).toEqual(["open", "closed"]);
		// The sidebar does not, because the mux is not the client's sentinel: it
		// exists only while a terminal is open, so a client with no pane showing
		// would have nothing to report a healthy link with. The change stream is
		// the connection every client holds, and it is what the row reads.
		expect(screen.getByTestId("server-connection")).toHaveAttribute("data-state", "connected");
		expect(screen.getByRole("status")).toHaveTextContent("Connected to box:3010");
		lease.dispose();
		pool.dispose();
	});
});

describe("a client and a server built from different releases", () => {
	it("names both versions rather than saying they differ", () => {
		connectedToBox();
		act(() => {
			setClientVersion("1.4.2");
			setServerVersion("1.3.9");
		});
		render(<ServerConnectionRow tabIndex={0} />);

		expect(screen.getByTestId("server-version-mismatch")).toHaveTextContent("Client 1.4.2 · server 1.3.9");
	});

	it("does not block anything: the server is still named and still connected", () => {
		connectedToBox();
		act(() => {
			setClientVersion("1.4.2");
			setServerVersion("1.3.9");
		});
		render(<ServerConnectionRow tabIndex={0} />);

		expect(screen.getByTestId("server-connection")).toHaveAttribute("data-state", "connected");
		expect(screen.getByTestId("server-connection")).toHaveTextContent("box:3010");
	});

	it("says nothing when the two halves match", () => {
		connectedToBox();
		act(() => {
			setClientVersion("1.4.2");
			setServerVersion("1.4.2");
		});
		render(<ServerConnectionRow tabIndex={0} />);

		expect(screen.queryByTestId("server-version-mismatch")).not.toBeInTheDocument();
	});

	it("says nothing when the server did not report a version", () => {
		// A daemon started from the CLI has no app version to give, which is
		// "cannot tell" and not "mismatched".
		connectedToBox();
		act(() => {
			setClientVersion("1.4.2");
			setServerVersion(null);
		});
		render(<ServerConnectionRow tabIndex={0} />);

		expect(screen.queryByTestId("server-version-mismatch")).not.toBeInTheDocument();
	});

	it("carries the warning into the collapsed rail", () => {
		connectedToBox();
		act(() => {
			setClientVersion("1.4.2");
			setServerVersion("1.3.9");
		});
		renderRail();

		expect(screen.getByTestId("server-connection-rail")).toBeInTheDocument();
	});
});
