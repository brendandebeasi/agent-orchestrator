import { Loader2, Server, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useServerConnection } from "../hooks/useServerConnection";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * Which server this client is talking to, and whether it is still talking.
 *
 * Only remote targets get a row. When the daemon is on this computer there is
 * nothing to disambiguate — a permanent "This computer" chip would be noise in
 * every window that has never been pointed anywhere else — and a local daemon
 * that is genuinely down already raises the startup banner. The moment a client
 * can be aimed elsewhere, though, "which machine am I looking at" stops being
 * obvious from the window, and the answer has to be on screen.
 *
 * It is deliberately not a button. Changing servers means tearing down every
 * query and socket in the app, which is the connect screen's job, not a
 * one-click action sitting under the cursor next to Settings.
 */

/** The status line, or null when nothing about the link is worth saying. */
function useConnectionSummary(): {
	label: string;
	detail: string | null;
	reconnecting: boolean;
	mismatch: { client: string; server: string } | null;
} | null {
	const { t } = useTranslation();
	const connection = useServerConnection();
	if (connection.kind !== "remote") return null;

	const reconnecting = connection.state === "reconnecting";
	// "unknown" is the gap before the first event frame arrives. Saying nothing
	// during it is right: the link is not known to be broken, and a spinner on
	// every launch would train operators to ignore the one that matters.
	const detail = reconnecting ? t("shell.serverReconnecting") : null;
	const mismatch =
		connection.versions.status === "mismatch"
			? { client: connection.versions.client ?? "", server: connection.versions.server ?? "" }
			: null;

	return { label: connection.label, detail, reconnecting, mismatch };
}

/** Expanded-sidebar form: server name, link state, and any version warning. */
export function ServerConnectionRow({ tabIndex }: { tabIndex: number }) {
	const { t } = useTranslation();
	const summary = useConnectionSummary();
	if (!summary) return null;

	return (
		<div
			className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-sm"
			data-state={summary.reconnecting ? "reconnecting" : "connected"}
			data-testid="server-connection"
		>
			<div className="flex items-center gap-2.5 text-muted-foreground [&_svg]:size-icon-md [&_svg]:shrink-0">
				{summary.reconnecting ? (
					<Loader2 aria-hidden="true" className="animate-spin" />
				) : (
					<Server aria-hidden="true" />
				)}
				<span className="min-w-0 flex-1 truncate font-medium tracking-tight" title={summary.label}>
					{summary.label}
				</span>
			</div>
			{/* Announced rather than merely drawn: an operator who has scrolled away
			    from the sidebar still needs to know the link dropped. */}
			<span aria-live="polite" className="sr-only" role="status" tabIndex={-1}>
				{summary.detail ?? t("shell.serverConnected", { server: summary.label })}
			</span>
			{summary.detail ? (
				<span className="pl-[26px] text-xs text-passive">{summary.detail}</span>
			) : null}
			{summary.mismatch ? (
				<span
					className="flex items-start gap-1.5 pl-[26px] text-xs text-warning"
					data-testid="server-version-mismatch"
					tabIndex={tabIndex}
					title={t("shell.serverVersionMismatchHint")}
				>
					<TriangleAlert aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
					<span>{t("shell.serverVersionMismatch", summary.mismatch)}</span>
				</span>
			) : null}
		</div>
	);
}

/** Collapsed icon-rail form: the same facts, moved into a tooltip. */
export function ServerConnectionRail({ tabIndex }: { tabIndex: number }) {
	const { t } = useTranslation();
	const summary = useConnectionSummary();
	if (!summary) return null;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					aria-label={
						summary.detail
							? `${summary.label} — ${summary.detail}`
							: t("shell.serverConnected", { server: summary.label })
					}
					className="grid size-control-board place-items-center rounded-lg text-muted-foreground [&_svg]:size-icon-base"
					data-testid="server-connection-rail"
					role="img"
					tabIndex={tabIndex}
				>
					{summary.reconnecting ? (
						<Loader2 aria-hidden="true" className="animate-spin" />
					) : summary.mismatch ? (
						<TriangleAlert aria-hidden="true" className="text-warning" />
					) : (
						<Server aria-hidden="true" />
					)}
				</span>
			</TooltipTrigger>
			<TooltipContent side="right">
				<span className="flex flex-col gap-0.5">
					<span>{summary.label}</span>
					{summary.detail ? <span className="text-passive">{summary.detail}</span> : null}
					{summary.mismatch ? <span>{t("shell.serverVersionMismatch", summary.mismatch)}</span> : null}
				</span>
			</TooltipContent>
		</Tooltip>
	);
}
