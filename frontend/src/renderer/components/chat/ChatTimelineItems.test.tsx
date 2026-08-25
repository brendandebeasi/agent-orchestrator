import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityRow, TurnOutcome } from "./ChatTimelineItems";

describe("TurnOutcome", () => {
	it("describes a recovered historical turn as imported without inferring its outcome", () => {
		render(<TurnOutcome state="recovered" />);
		expect(
			screen.getByText("Imported from Terminal UI — completion status unavailable"),
		).toBeInTheDocument();
		expect(screen.queryByText("Outcome unknown")).not.toBeInTheDocument();
		expect(screen.queryByText("Done")).not.toBeInTheDocument();
	});
});

describe("ActivityRow", () => {
	it("does not present a recovered historical activity as failed", () => {
		render(
			<ActivityRow
				activity={{
					kind: "activity",
					id: "activity-1",
					sequence: 1,
					revision: 0,
					createdAt: "2026-08-23T00:00:00Z",
					activityKind: "command",
					status: "recovered",
					summary: "Run tests",
				}}
			/>,
		);
		expect(screen.getByText("outcome unknown")).toBeInTheDocument();
		expect(screen.queryByText("failed")).not.toBeInTheDocument();
	});
});
