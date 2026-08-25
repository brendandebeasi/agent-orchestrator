import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerConnectionForTest } from "../../lib/server-connection";
import { setLocalServerTarget, setRemoteServerTarget } from "../../lib/server-target";
import { useUiStore } from "../../stores/ui-store";
import { ServerSettingsSection } from "./ServerSettingsSection";

/**
 * `hasElectronHost` is read at module scope by the component, so the browser
 * case needs a separate module registry rather than a mutable flag: the value
 * is captured the moment the component module is first evaluated.
 */
vi.mock("../../lib/bridge", () => ({ aoBridge: {}, hasElectronHost: true }));

beforeEach(() => {
	setLocalServerTarget("http://127.0.0.1:3001");
	resetServerConnectionForTest();
	useUiStore.getState().setServerPickerOpen(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the server row in settings", () => {
	it("names the computer this client is talking to, so the operator can tell without guessing from the window", () => {
		render(<ServerSettingsSection />);

		expect(screen.getByRole("heading", { name: "Server" })).toBeInTheDocument();
		expect(screen.getByText("Talking to")).toBeInTheDocument();
		expect(screen.getByText("This computer")).toBeInTheDocument();
	});

	it("names the remote server when there is one, because 'connected' is not an answer to which machine", async () => {
		render(<ServerSettingsSection />);

		await act(async () => {
			setRemoteServerTarget({ baseUrl: "http://studio.local:3001", label: "studio.local:3001", credential: "hunter2" });
		});

		expect(screen.getByText("studio.local:3001")).toBeInTheDocument();
	});

	it("opens the connection screen, which is the entry point remote mode did not otherwise have outside AO_REMOTE_SERVER", async () => {
		render(<ServerSettingsSection />);

		await userEvent.click(screen.getByRole("button", { name: "Change…" }));

		expect(useUiStore.getState().isServerPickerOpen).toBe(true);
	});

	it("warns that changing servers restarts the app, since a relaunch mid-session is otherwise indistinguishable from a crash", () => {
		render(<ServerSettingsSection />);

		expect(screen.getByText(/restarts this app/i)).toBeInTheDocument();
	});
});

describe("the server row in a browser tab", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.doMock("../../lib/bridge", () => ({ aoBridge: {}, hasElectronHost: false }));
	});

	it("renders nothing, because a tab's server is the address that served it and cannot be changed from inside", async () => {
		const { ServerSettingsSection: BrowserSection } = await import("./ServerSettingsSection");

		const { container } = render(<BrowserSection />);

		expect(container).toBeEmptyDOMElement();
	});
});
