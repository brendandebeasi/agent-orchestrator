import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_HOST_CAPABILITIES } from "../../shared/host-capabilities";
import { setLocalServerTarget, setRemoteServerTarget } from "../lib/server-target";
import { CreateProjectFlow, type CloneProjectInput, type CreateProjectInput } from "./CreateProjectFlow";

const bridgeMocks = vi.hoisted(() => ({
	checkAncestorRepo: vi.fn(),
	chooseDirectory: vi.fn(),
	scanImportFolder: vi.fn(),
}));

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		// These cases are all about the native-picker path, so the double declares
		// the desktop host that has one. The path taken when it is withdrawn has
		// its own describe block below, which flips this through the server target.
		capabilities: { ...ALL_HOST_CAPABILITIES },
		app: {
			checkAncestorRepo: bridgeMocks.checkAncestorRepo,
			chooseDirectory: bridgeMocks.chooseDirectory,
			scanImportFolder: bridgeMocks.scanImportFolder,
		},
	},
}));

// Probe stand-in: the real sheet needs a QueryClientProvider + agent catalog to
// render. These tests only care which path/kind CreateProjectFlow hands it and
// whether it's open, so a thin stub keeps the suite fast and focused.
vi.mock("./CreateProjectAgentSheet", () => ({
	CreateProjectAgentSheet: ({
		kind,
		open,
		path,
	}: {
		kind: string;
		open: boolean;
		path: string | null;
	}) => (open ? <div data-kind={kind} data-path={path ?? ""} data-testid="agent-sheet" /> : null),
}));

// Probe stand-in: the real dialog needs its own form state and validation.
// These tests only care whether the clone flow is on screen and that the
// droppedPath guard leaves it alone, so a thin stub keeps the suite focused.
vi.mock("./CloneRepositoryDialog", () => ({
	default: ({ open }: { open: boolean }) => (open ? <div data-testid="clone-dialog" /> : null),
}));

function okScan(path: string) {
	return {
		path,
		repos: [
			{
				branch: "main",
				hasRemote: true,
				name: "proj",
				path,
				relativePath: ".",
				remote: "git@github.com:example/proj.git",
				status: "ok" as const,
			},
		],
	};
}

const noop = {
	onCloneProject: async (_input: CloneProjectInput) => undefined,
	onCreateProject: async (_input: CreateProjectInput) => undefined,
	onInitializeProject: async (_path: string) => undefined,
};

beforeEach(() => {
	bridgeMocks.checkAncestorRepo.mockReset().mockResolvedValue(undefined);
	bridgeMocks.chooseDirectory.mockReset();
	bridgeMocks.scanImportFolder.mockReset().mockImplementation(async ({ path }: { path: string }) => okScan(path));
	setLocalServerTarget("http://127.0.0.1:3001");
});

describe("CreateProjectFlow droppedPath", () => {
	it("does not open on mount", () => {
		render(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} />);
		expect(screen.queryByRole("button", { name: "Add a workspace folder" })).not.toBeInTheDocument();
	});

	it("opens the mode picker without invoking the native folder chooser", async () => {
		const { rerender } = render(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} />);

		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/proj" }} />);

		expect(await screen.findByRole("button", { name: "Open local repository" })).toBeInTheDocument();
		expect(bridgeMocks.chooseDirectory).not.toHaveBeenCalled();
	});

	it("uses the dropped path for preflight and opens the agent sheet, skipping the native dialog", async () => {
		const user = userEvent.setup();
		const { rerender } = render(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} />);
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/proj" }} />);

		await user.click(await screen.findByRole("button", { name: "Open local repository" }));

		await waitFor(() =>
			expect(bridgeMocks.scanImportFolder).toHaveBeenCalledWith({ mode: "project", path: "/dropped/proj" }),
		);
		expect(bridgeMocks.chooseDirectory).not.toHaveBeenCalled();
		const sheet = await screen.findByTestId("agent-sheet");
		expect(sheet).toHaveAttribute("data-path", "/dropped/proj");
		expect(sheet).toHaveAttribute("data-kind", "single_repo");
	});

	it("does not let a stale dropped path leak into the next manual New Project click", async () => {
		const user = userEvent.setup();
		bridgeMocks.chooseDirectory.mockResolvedValue("/manually/chosen");
		const { rerender } = render(
			<CreateProjectFlow mode="choose" {...noop} droppedPath={null} openSignal={0} />,
		);

		// Drop a folder, then dismiss the mode picker without picking a kind.
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/proj" }} openSignal={0} />);
		await user.click(await screen.findByRole("button", { name: "Close new project dialog" }));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Open local repository" })).not.toBeInTheDocument());

		// A manual "New Project" (⌘N-style openSignal bump) must fall back to the
		// native dialog, not silently reuse the dismissed drop's path.
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/proj" }} openSignal={1} />);
		await user.click(await screen.findByRole("button", { name: "Open local repository" }));

		await waitFor(() => expect(bridgeMocks.chooseDirectory).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(bridgeMocks.scanImportFolder).toHaveBeenCalledWith({ mode: "project", path: "/manually/chosen" }),
		);
	});

	it("ignores a drop while the agent sheet is already open", async () => {
		const user = userEvent.setup();
		const { rerender } = render(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} />);
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/first" }} />);
		await user.click(await screen.findByRole("button", { name: "Open local repository" }));
		const sheet = await screen.findByTestId("agent-sheet");
		expect(sheet).toHaveAttribute("data-path", "/dropped/first");

		// A second, different folder is dropped while the agent sheet is open.
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 2, path: "/dropped/second" }} />);

		expect(screen.getByTestId("agent-sheet")).toHaveAttribute("data-path", "/dropped/first");
		expect(screen.queryByRole("button", { name: "Open local repository" })).not.toBeInTheDocument();
	});

	it("ignores a drop while the clone-from-Git dialog is open", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<CreateProjectFlow mode="choose" {...noop} droppedPath={null} openSignal={0} />,
		);

		// Open the mode picker manually and switch to the clone flow.
		rerender(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} openSignal={1} />);
		await user.click(await screen.findByRole("button", { name: "Clone from Git" }));
		expect(await screen.findByTestId("clone-dialog")).toBeInTheDocument();

		// A folder is dropped while the clone dialog is on screen.
		rerender(
			<CreateProjectFlow mode="choose" {...noop} droppedPath={{ nonce: 1, path: "/dropped/proj" }} openSignal={1} />,
		);

		expect(screen.getByTestId("clone-dialog")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Open local repository" })).not.toBeInTheDocument();
		expect(bridgeMocks.chooseDirectory).not.toHaveBeenCalled();
	});
});

describe("CreateProjectFlow against a remote server", () => {
	// The flow only opens when openSignal *changes*, so every case here mounts
	// closed and then bumps the signal, exactly as the real ⌘N path does.
	function openFlow(props: Partial<ComponentProps<typeof CreateProjectFlow>> = {}) {
		const { rerender } = render(
			<CreateProjectFlow mode="choose" {...noop} {...props} droppedPath={null} openSignal={0} />,
		);
		rerender(<CreateProjectFlow mode="choose" {...noop} {...props} droppedPath={null} openSignal={1} />);
	}

	beforeEach(() => {
		setRemoteServerTarget({ baseUrl: "https://build-box:7420", label: "build-box", credential: "pw" });
	});

	it("asks for a path instead of opening a dialog that would show the wrong disk", async () => {
		const user = userEvent.setup();
		openFlow();

		await user.click(await screen.findByRole("button", { name: "Open local repository" }));

		expect(await screen.findByLabelText("Folder path on build-box")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Choose a project folder" })).not.toBeInTheDocument();
		expect(bridgeMocks.chooseDirectory).not.toHaveBeenCalled();
	});

	it("carries the typed path to the agent sheet without scanning this computer", async () => {
		const user = userEvent.setup();
		openFlow();
		await user.click(await screen.findByRole("button", { name: "Open local repository" }));

		await user.type(await screen.findByLabelText("Folder path on build-box"), "/srv/code/web-app");
		await user.click(screen.getByRole("button", { name: "Use this folder" }));

		const sheet = await screen.findByTestId("agent-sheet");
		expect(sheet).toHaveAttribute("data-path", "/srv/code/web-app");
		expect(sheet).toHaveAttribute("data-kind", "single_repo");
		// The scan and the ancestor check both read this machine's filesystem, and
		// this machine is not where the project is. Handing the path straight to
		// the daemon trades the pre-import preview for an answer about the right
		// disk; the daemon is the only thing that can validate it now.
		expect(bridgeMocks.scanImportFolder).not.toHaveBeenCalled();
		expect(bridgeMocks.checkAncestorRepo).not.toHaveBeenCalled();
	});

	it("keeps the workspace kind and its own hint when the workspace source is chosen", async () => {
		const user = userEvent.setup();
		openFlow();

		await user.click(await screen.findByRole("button", { name: "Add a workspace folder" }));

		expect(await screen.findByLabelText("Folder path on build-box")).toBeInTheDocument();
		expect(
			screen.getByText("Type the absolute path of the folder that holds your repositories, as the server sees it."),
		).toBeInTheDocument();
		expect(bridgeMocks.checkAncestorRepo).not.toHaveBeenCalled();
	});

	it("will not submit an empty path", async () => {
		const user = userEvent.setup();
		openFlow();
		await user.click(await screen.findByRole("button", { name: "Open local repository" }));

		await screen.findByLabelText("Folder path on build-box");
		expect(screen.getByRole("button", { name: "Use this folder" })).toBeDisabled();

		// Whitespace is not a path either; the daemon would reject it with a worse
		// message than simply leaving the button off.
		await user.type(screen.getByLabelText("Folder path on build-box"), "   ");
		expect(screen.getByRole("button", { name: "Use this folder" })).toBeDisabled();
		expect(screen.queryByTestId("agent-sheet")).not.toBeInTheDocument();
	});

	it("asks for a path from the empty-state picker too, without touching this disk", async () => {
		const user = userEvent.setup();
		render(<CreateProjectFlow mode="choose" {...noop} droppedPath={null} embedded />);

		await user.click(await screen.findByRole("button", { name: "Open local repository" }));

		expect(await screen.findByLabelText("Folder path on build-box")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Choose a project folder" })).not.toBeInTheDocument();
		expect(bridgeMocks.chooseDirectory).not.toHaveBeenCalled();
	});
});
