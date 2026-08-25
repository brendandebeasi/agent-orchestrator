import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_HOST_CAPABILITIES } from "../../shared/host-capabilities";
import { setLocalServerTarget, setRemoteServerTarget } from "../lib/server-target";
import CloneRepositoryDialog, {
	type CloneRepositoryDetails,
	type CloneRepositorySelection,
	joinCloneDestination,
	repositoryNameFromGitUrl,
} from "./CloneRepositoryDialog";

const chooseDirectory = vi.hoisted(() => vi.fn());

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		capabilities: { ...ALL_HOST_CAPABILITIES },
		app: { chooseDirectory },
	},
}));

describe("clone repository input", () => {
	it.each([
		["https://github.com/acme/web-app.git", "web-app"],
		["ssh://git@github.com/acme/web-app.git", "web-app"],
		["git@github.com:acme/web-app.git", "web-app"],
		["file:///tmp/web-app", "web-app"],
		["file:///tmp/my%20repo.git", "my repo"],
		["https://github.com/acme/nested%2Frepo.git", "repo"],
		["file:///tmp/literal%252Frepo.git", "literal%2Frepo"],
	])("derives the checkout name from %s", (remoteUrl, expected) => {
		expect(repositoryNameFromGitUrl(remoteUrl)).toBe(expected);
	});

	it.each([
		"repository-without-a-scheme",
		"--upload-pack=malicious",
		"https://user:secret@example.com/acme/repo.git",
		"https://example.com/acme/repo.git?access_token=secret",
		"ssh://git:secret@example.com/acme/repo.git",
		"https://github.com/acme/two words.git",
		"file:///tmp/bad%ZZ.git",
	])("rejects unsafe or incomplete URL %s", (remoteUrl) => {
		expect(repositoryNameFromGitUrl(remoteUrl)).toBeNull();
	});

	it("joins POSIX and Windows destinations", () => {
		expect(joinCloneDestination("/Users/me/Code/", "web-app")).toBe("/Users/me/Code/web-app");
		expect(joinCloneDestination("C:\\Code\\", "web-app")).toBe("C:\\Code\\web-app");
	});
});

// The dialog keeps no destination state of its own — it reports changes upward
// and re-renders from the value it is handed. This harness closes that loop so
// typing behaves the way it does inside CreateProjectFlow.
function Harness({ onContinue = () => {} }: { onContinue?: (selection: CloneRepositorySelection) => void }) {
	const [value, setValue] = useState<CloneRepositoryDetails>({ destinationParent: "", remoteUrl: "" });
	return (
		<CloneRepositoryDialog
			disabled={false}
			error={null}
			open
			value={value}
			onBack={() => {}}
			onChange={setValue}
			onClose={() => {}}
			onContinue={onContinue}
		/>
	);
}

describe("clone destination against a remote server", () => {
	beforeEach(() => {
		chooseDirectory.mockReset();
	});

	it("offers the native picker and keeps the field read-only when the server is this computer", () => {
		setLocalServerTarget("http://127.0.0.1:3001");
		render(<Harness />);

		expect(screen.getByRole("button", { name: "Choose" })).toBeInTheDocument();
		expect(screen.getByLabelText("Clone into")).toHaveAttribute("readonly");
		expect(screen.queryByText(/Type an absolute path/)).not.toBeInTheDocument();
	});

	it("withdraws the picker and takes a typed path when the server is elsewhere", async () => {
		const user = userEvent.setup();
		setRemoteServerTarget({ baseUrl: "https://build-box:7420", label: "build-box", credential: "pw" });
		const onContinue = vi.fn();
		render(<Harness onContinue={onContinue} />);

		// The native dialog can only show this disk, so it is gone rather than
		// present-and-wrong.
		expect(screen.queryByRole("button", { name: "Choose" })).not.toBeInTheDocument();
		const destination = screen.getByLabelText("Clone into");
		expect(destination).not.toHaveAttribute("readonly");
		expect(
			screen.getByText("This folder is on build-box. Type an absolute path; the server will tell you if it is not there."),
		).toBeInTheDocument();

		await user.type(screen.getByLabelText("Repository URL"), "https://github.com/acme/web-app.git");
		await user.type(destination, "/srv/code");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		expect(onContinue).toHaveBeenCalledWith({
			destinationParent: "/srv/code",
			remoteUrl: "https://github.com/acme/web-app.git",
			targetPath: "/srv/code/web-app",
		});
		expect(chooseDirectory).not.toHaveBeenCalled();
	});

	it("still requires a destination when the picker is withdrawn", async () => {
		const user = userEvent.setup();
		setRemoteServerTarget({ baseUrl: "https://build-box:7420", label: "build-box", credential: "pw" });
		const onContinue = vi.fn();
		render(<Harness onContinue={onContinue} />);

		await user.type(screen.getByLabelText("Repository URL"), "https://github.com/acme/web-app.git");
		await user.click(screen.getByRole("button", { name: "Continue" }));

		expect(onContinue).not.toHaveBeenCalled();
		expect(screen.getByRole("alert")).toHaveTextContent("Choose a destination folder.");
	});
});
