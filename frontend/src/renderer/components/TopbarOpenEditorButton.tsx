import { ChevronDown, Code2, FolderOpen, SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { OpenTarget, OpenTargetId } from "../../shared/editor-handoff";
import { useEditorHandoffState, useOpenSessionTarget } from "../hooks/useEditorHandoff";
import { useHostCapability } from "../hooks/useHostCapability";
import { TopbarActionError, TopbarButton } from "./TopbarButton";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
	AndroidStudioIcon,
	CursorIcon,
	JetBrainsIcon,
	SublimeIcon,
	VSCodeIcon,
	VSCodiumIcon,
	WindsurfIcon,
	ZedIcon,
} from "./icons";

const editorIcons: Record<string, typeof VSCodeIcon> = {
	vscode: VSCodeIcon,
	"vscode-insiders": VSCodeIcon,
	vscodium: VSCodiumIcon,
	cursor: CursorIcon,
	windsurf: WindsurfIcon,
	zed: ZedIcon,
	sublime: SublimeIcon,
	"android-studio": AndroidStudioIcon,
	intellij: JetBrainsIcon,
	webstorm: JetBrainsIcon,
	pycharm: JetBrainsIcon,
	goland: JetBrainsIcon,
	phpstorm: JetBrainsIcon,
	rubymine: JetBrainsIcon,
	clion: JetBrainsIcon,
	rider: JetBrainsIcon,
	fleet: JetBrainsIcon,
};

const editorColors: Record<string, string> = {
	vscode: "#1F9CF0",
	"vscode-insiders": "#1F9CF0",
	vscodium: "#2F80ED",
	sublime: "#FF9800",
	"android-studio": "#3DDC84",
};

function TargetIcon({ target, className }: { target?: OpenTarget; className?: string }) {
	if (target?.kind === "file_manager") return <FolderOpen className={className} aria-hidden="true" />;
	if (target?.kind === "terminal") return <SquareTerminal className={className} aria-hidden="true" />;
	const Icon = (target && editorIcons[target.id]) || Code2;
	const color = target ? editorColors[target.id] : undefined;
	return <Icon className={className} style={color ? { color } : undefined} aria-hidden="true" />;
}

// Electron main owns the complete handoff: it resolves the loopback-only
// workspace path, launches the native target, and persists editor preference.
// This renderer receives only safe target metadata and availability status.
export function TopbarOpenEditorButton({
	sessionId,
	projectId,
	style,
}: {
	sessionId: string;
	projectId: string;
	style?: React.CSSProperties;
}) {
	const { t } = useTranslation();
	// Two capabilities, because the menu mixes two kinds of thing: launching an
	// editor or a terminal, and revealing the worktree in the platform file
	// manager. They travel together today — both are withdrawn by a browser host
	// and by a remote server — but they are separately declarable, so each kind
	// of target is filtered by its own answer rather than by the pair.
	const editorHandoff = useHostCapability("editorHandoff");
	const revealInFileManager = useHostCapability("revealInFileManager");
	const withdrawn = !editorHandoff.available && !revealInFileManager.available;
	const withdrawnReason = editorHandoff.reasonKey
		? t(editorHandoff.reasonKey, { server: editorHandoff.serverLabel })
		: null;

	const stateQuery = useEditorHandoffState(sessionId);
	const open = useOpenSessionTarget();
	const state = stateQuery.data;
	const allTargets = state?.targets ?? [];
	const targets = allTargets.filter((target) =>
		target.kind === "file_manager" ? revealInFileManager.available : editorHandoff.available,
	);
	const editors = targets.filter((target) => target.kind === "editor");
	const preferred = editors.find((target) => target.id === state?.preferredEditorId);
	const safeTargets = targets.filter((target) => target.kind !== "editor");
	const fileManagerName = safeTargets.find((target) => target.kind === "file_manager")?.name ?? t("editor.fileManager");
	const terminalName = safeTargets.find((target) => target.kind === "terminal")?.name ?? t("editor.terminal");
	const workspaceAvailable = state?.workspaceAvailable === true;
	// The query does not run when the capability is withdrawn, so it sits pending
	// forever rather than resolving. Treating that as "busy" would render a
	// control that looks like it is about to become usable, so the withdrawn case
	// is checked ahead of it and settles the disabled state on its own.
	const busy = stateQuery.isPending || open.isPending;
	const mainDisabled = withdrawn || busy || !workspaceAvailable || !preferred;
	const menuDisabled = withdrawn || busy || !workspaceAvailable || targets.length === 0;

	const launch = (targetId?: OpenTargetId) => {
		open.reset();
		open.mutate({ sessionId, projectId, ...(targetId ? { targetId } : {}) });
	};
	const launchError = open.error instanceof Error ? open.error.message : null;
	// A withdrawn capability is not an error and does not belong in the error
	// slot: nothing failed, and the topbar would carry a red banner for as long
	// as the operator stayed connected to that server. The reason rides on the
	// disabled control's tooltip instead, which is where someone who wonders why
	// it is greyed out will look.
	const guidance = withdrawn
		? null
		: !stateQuery.isPending && !workspaceAvailable
			? state?.unavailableReason ?? t("editor.workspaceUnavailable")
			: !stateQuery.isPending && editors.length === 0
				? t("editor.noEditorGuidance", { fileManager: fileManagerName, terminal: terminalName })
				: null;
	const mainLabel = open.isPending ? t("editor.opening") : preferred ? t("editor.open") : t("editor.chooseEditor");
	const mainTitle = withdrawnReason
		?? guidance
		?? (preferred ? t("editor.openWorkspaceInTitle", { name: preferred.name }) : t("editor.chooseEditorTitle"));

	return (
		<>
			{launchError || guidance ? (
				<TopbarActionError className="max-w-content-max truncate" title={launchError ?? guidance ?? undefined}>
					{launchError ?? guidance}
				</TopbarActionError>
			) : null}
			<div className="inline-flex items-center" style={style}>
				<TopbarButton
					aria-label={preferred ? t("editor.openInAria", { name: preferred.name }) : t("editor.chooseEditor")}
					data-priority="primary"
					disabled={mainDisabled}
					onClick={() => launch()}
					title={mainTitle}
					variant="splitMain"
				>
					<TargetIcon target={preferred} className="size-icon-lg" />
					<span data-compact-label>{mainLabel}</span>
				</TopbarButton>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<TopbarButton
							aria-label={t("editor.openOptionsAria")}
							disabled={menuDisabled}
							title={withdrawnReason ?? undefined}
							variant="splitTrigger"
						>
							<ChevronDown className="size-icon-sm" aria-hidden="true" />
						</TopbarButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-52">
						{safeTargets.map((target) => (
							<DropdownMenuItem key={target.id} onSelect={() => launch(target.id)}>
								<TargetIcon target={target} className="size-icon-sm" />
								{t("editor.openInTarget", { name: target.name })}
							</DropdownMenuItem>
						))}
						{safeTargets.length > 0 && editors.length > 0 ? <DropdownMenuSeparator /> : null}
						{editors.length > 0 ? <DropdownMenuLabel>{t("editor.openWith")}</DropdownMenuLabel> : null}
						{editors.map((editor) => (
							<DropdownMenuItem key={editor.id} onSelect={() => launch(editor.id)}>
								<TargetIcon target={editor} className="size-icon-sm" />
								{editor.name}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</>
	);
}
