import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../lib/api-client";
import { aoBridge } from "../lib/bridge";
import type { MigrationState } from "../../main/app-state";
import { isPreviewMode } from "../lib/preview-mode";

export const migrationOfferQueryKey = ["migration-offer"] as const;

export interface MigrationOffer {
	show: boolean;
	legacyRoot: string;
	migration: MigrationState;
}

// fetchMigrationOffer combines the app marker (decision) with the daemon's
// availability (is there legacy data). A terminal marker (completed/declined)
// short-circuits before any daemon call. A 501/unreachable daemon resolves to
// "no offer", never an error.
async function fetchMigrationOffer(): Promise<MigrationOffer> {
	const migration = await aoBridge.appState.getMigration();
	if (migration.status === "completed" || migration.status === "declined") {
		return { show: false, legacyRoot: "", migration };
	}
	const { data, error } = await apiClient.GET("/api/v1/import");
	const legacyRoot = data?.legacyRoot ?? "";
	if (error || !data?.available) return { show: false, legacyRoot, migration };
	return { show: true, legacyRoot, migration };
}

export function useMigrationOffer() {
	return useQuery({
		queryKey: migrationOfferQueryKey,
		queryFn: fetchMigrationOffer,
		enabled: !isPreviewMode(),
		retry: 1,
		throwOnError: false,
	});
}
