import { useTranslation } from "react-i18next";
import { hasElectronHost } from "../../lib/bridge";
import { useServerConnection } from "../../hooks/useServerConnection";
import { useUiStore } from "../../stores/ui-store";
import { Button } from "../ui/button";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

/**
 * Which computer this client is talking to, and the way to change it.
 *
 * Until this existed, remote mode had no door: the connection screen only
 * appeared to a client that was *already* pointed at a server and had lost its
 * password, which meant the only way to get pointed at one in the first place
 * was the `AO_REMOTE_SERVER` environment variable. That is a fine escape hatch
 * and a poor front entrance.
 *
 * It is a row and not a page because the answer is one line and the action is
 * one button; the screen it opens is where the actual work happens.
 */
export function ServerSettingsSection() {
	const { t } = useTranslation();
	const connection = useServerConnection();
	const setServerPickerOpen = useUiStore((state) => state.setServerPickerOpen);

	// A browser tab is served by its server, so "which server" is the address in
	// its own URL bar and changing it means visiting a different one. There is
	// nothing here for it to set.
	if (!hasElectronHost) return null;

	return (
		<SettingsSection title={t("settings.server")} grouped>
			<div className="flex w-full flex-col">
				<SettingsRow className="rounded-none" label={t("settings.server.label")}>
					<div className="flex min-w-0 items-center gap-2">
						<span className="settings-row-value min-w-0 truncate" title={connection.label}>
							{connection.label}
						</span>
						<Button onClick={() => setServerPickerOpen(true)} size="sm" type="button" variant="secondary">
							{t("settings.server.change")}
						</Button>
					</div>
				</SettingsRow>
				<p className="px-3 pt-0 pb-4 text-xs leading-relaxed text-muted-foreground">
					{t("settings.server.hint")}
				</p>
			</div>
		</SettingsSection>
	);
}
