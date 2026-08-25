// One invariant, four hooks: with preview off, every hook that can answer from
// fixtures asks the daemon instead. Kept in one file because that is the shape
// of the thing being tested — the four used to branch on `VITE_NO_ELECTRON`,
// which a browser client sets for reasons that have nothing to do with whether
// a daemon exists, and a per-hook version of this would be four copies of the
// same three lines with no shared statement of what they are protecting.

import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { getMock, hasTrustedApiBaseUrlMock, getMigrationMock } = vi.hoisted(() => ({
	getMock: vi.fn(),
	hasTrustedApiBaseUrlMock: vi.fn(() => true),
	getMigrationMock: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
	apiClient: { GET: getMock },
	hasTrustedApiBaseUrl: hasTrustedApiBaseUrlMock,
}));

vi.mock("../lib/bridge", () => ({
	aoBridge: { appState: { getMigration: getMigrationMock } },
	hasElectronHost: true,
}));

import { useMigrationOffer } from "./useMigrationOffer";
import { useSessionScmSummary } from "./useSessionScmSummary";
import { useShellTerminals } from "./useShellTerminals";
import { useWorkspaceQuery } from "./useWorkspaceQuery";

function wrapper({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function respondWith(byPath: Record<string, unknown>) {
	getMock.mockImplementation(async (url: string) => {
		if (url in byPath) return byPath[url];
		throw new Error(`unexpected GET ${url}`);
	});
}

beforeEach(() => {
	getMock.mockReset();
	hasTrustedApiBaseUrlMock.mockReset().mockReturnValue(true);
	getMigrationMock.mockReset().mockResolvedValue({ status: "pending" });
});

describe("hooks with a fixture path, with preview off", () => {
	it("reads shell terminals from the daemon rather than the fixture list", async () => {
		respondWith({
			"/api/v1/shell-terminals": {
				data: {
					shellTerminals: [
						{
							handleId: "h-real",
							projectId: "p1",
							workingDir: "/tmp/real",
							title: "real shell",
							createdAt: "2026-01-01T00:00:00Z",
						},
					],
				},
			},
		});

		const { result } = renderHook(() => useShellTerminals(), { wrapper });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(getMock).toHaveBeenCalledWith("/api/v1/shell-terminals");
		expect(result.current.data).toEqual([
			{
				handleId: "h-real",
				projectId: "p1",
				sessionId: undefined,
				workingDir: "/tmp/real",
				title: "real shell",
				createdAt: "2026-01-01T00:00:00Z",
			},
		]);
	});

	it("reads the workspace from the daemon rather than the fixture board", async () => {
		respondWith({
			"/api/v1/projects": { data: { projects: [{ id: "p1", name: "real project", path: "/tmp/p1" }] } },
			"/api/v1/sessions": { data: { sessions: [] } },
		});

		const { result } = renderHook(() => useWorkspaceQuery(), { wrapper });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(getMock).toHaveBeenCalledWith("/api/v1/projects");
		expect(result.current.data?.map((project) => project.name)).toEqual(["real project"]);
	});

	it("reads a session's pull requests from the daemon rather than the fixture map", async () => {
		respondWith({ "/api/v1/sessions/{sessionId}/pr": { data: { prs: [{ url: "https://example.test/pr/1" }] } } });

		const { result } = renderHook(() => useSessionScmSummary("s1"), { wrapper });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(getMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/pr", {
			params: { path: { sessionId: "s1" } },
		});
		expect(result.current.data).toEqual([{ url: "https://example.test/pr/1" }]);
	});

	it("asks the daemon whether there is legacy data to migrate", async () => {
		respondWith({ "/api/v1/import": { data: { available: true, legacyRoot: "/tmp/legacy" } } });

		const { result } = renderHook(() => useMigrationOffer(), { wrapper });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(getMock).toHaveBeenCalledWith("/api/v1/import");
		expect(result.current.data).toMatchObject({ show: true, legacyRoot: "/tmp/legacy" });
	});
});
