import type { AoBridge } from "../../preload";
import { NO_HOST_CAPABILITIES } from "../../shared/host-capabilities";
import { coerceUiSettings, DEFAULT_UI_SETTINGS } from "../../shared/ui-locale";
import { isPreviewMode } from "./preview-mode";
export type { FeatureBuild } from "../../main/feature-builds";

/**
 * Whether an Electron preload is behind this window.
 *
 * The distinction the renderer actually cares about is not "browser or app" but
 * "is there a supervisor" — something that spawned the daemon, knows its port,
 * and can be asked to restart it. Everything the fallback below stubs out is
 * downstream of that one fact.
 */
export const hasElectronHost = typeof window !== "undefined" && Boolean(window.ao);

/**
 * The stub's answer for anything that needs a host and has none.
 *
 * Returning a plausible nothing — `null`, an empty scan, an idle nav state — is
 * what let these methods be called from a browser for as long as they were: the
 * caller got something shaped right back, drew a blank result, and no one found
 * out that the feature had quietly stopped existing. Every one of these now has
 * a capability guarding its call site, so arriving here is not a browser doing
 * something reasonable, it is a guard that is missing. Say so where it happens
 * rather than three screens later.
 */
function unavailable(method: string): never {
	throw new Error(
		`${method} needs the desktop app on the same computer as the daemon. This is a bug: its call site should have checked the host capability first.`,
	);
}

export const aoBridge: AoBridge =
	window.ao ??
	({
		// A browser tab has no editor to launch, no file manager to reveal into,
		// no native directory dialog, and no embedded browser view. Reporting
		// them off is what lets the rest of this stub stop pretending: the
		// methods behind these throw (see below) rather than resolving to a
		// plausible-looking nothing, because every one of their call sites is
		// gated on the capability and reaching one anyway is a gating bug worth
		// hearing about.
		capabilities: { ...NO_HOST_CAPABILITIES },
		// A page served over HTTP was not launched with arguments, so there is
		// nothing to read a remote address out of. It also does not need one:
		// the daemon it talks to is the one that served it, which the bootstrap
		// works out from the page's own origin.
		remoteServer: null,
		app: {
			getVersion: async () => "0.0.0-preview",
			chooseDirectory: async () => unavailable("app.chooseDirectory"),
			openExternal: async (url: string) => {
				window.open(url, "_blank", "noopener,noreferrer");
			},
			scanImportFolder: async () => unavailable("app.scanImportFolder"),
			checkAncestorRepo: async () => unavailable("app.checkAncestorRepo"),
			getPathForFile: () => "",
			onOpenFolderPath: () => () => undefined,
			onNewSessionShortcut: () => () => undefined,
			onKeyboardShortcutsHelp: () => () => undefined,
			onNewShellTerminalShortcut: () => () => undefined,
			onCloseShellTerminalShortcut: () => () => undefined,
			setCloseShellTerminalShortcutEnabled: () => undefined,
			onOpenSettingsShortcut: () => () => undefined,
			onPreviousSessionShortcut: () => () => undefined,
			onNextSessionShortcut: () => () => undefined,
			onPreviousTabShortcut: () => () => undefined,
			onNextTabShortcut: () => () => undefined,
			onFocusTerminalShortcut: () => () => undefined,
		},
		terminal: {
			saveDroppedFile: async () => "",
			setFocused: () => undefined,
			onFontSizeShortcut: () => () => undefined,
		},
		window: {
			isMaximized: async () => false,
			onMaximized: () => () => undefined,
			isFullScreen: async () => false,
			onFullScreen: () => () => undefined,
		},
		theme: {
			set: async () => undefined,
		},
		menu: {
			action: async () => undefined,
			notifyShellFocus: () => undefined,
		},
		clipboard: {
			writeText: async (text: string) => {
				if (navigator.clipboard?.writeText) {
					await navigator.clipboard.writeText(text);
				}
			},
			readText: async () => (navigator.clipboard?.readText ? navigator.clipboard.readText() : ""),
		},
		daemon: {
			// A browser has no supervisor to ask, so there are only two honest
			// answers. In preview there is no daemon at all and saying so is the
			// accurate one. Otherwise the daemon is a server that was already
			// running before this page loaded and will keep running after it
			// closes: nothing here started it, nothing here can restart it, and
			// its health is not something this stub can observe. It reports the
			// only state that does not misrepresent that; whether the server is
			// actually answering shows up where it is actually known, in the
			// requests the client makes to it.
			getStatus: async () =>
				isPreviewMode()
					? { state: "stopped", message: "Electron preload is not available in browser preview." }
					: { state: "ready" },
			start: async () => ({ state: "starting" }),
			stop: async () => ({ state: "stopped" }),
			restart: async () => ({ state: "starting" }),
			onStatus: () => () => undefined,
		},
		editorHandoff: {
			getState: async () => unavailable("editorHandoff.getState"),
			open: async () => unavailable("editorHandoff.open"),
		},
		telemetry: {
			getBootstrap: async () => null,
		},
		browser: {
			// Reported off rather than stubbed off: the panel reads this to decide
			// whether to composite a native view or draw a static preview, and it
			// has to get an answer, not an exception, to make that choice.
			nativeCompositionEnabled: false,
			ensure: async () => unavailable("browser.ensure"),
			setBounds: () => unavailable("browser.setBounds"),
			setOverlayOpen: () => unavailable("browser.setOverlayOpen"),
			navigate: async () => unavailable("browser.navigate"),
			clear: async () => unavailable("browser.clear"),
			goBack: async () => unavailable("browser.goBack"),
			goForward: async () => unavailable("browser.goForward"),
			reload: async () => unavailable("browser.reload"),
			stop: async () => unavailable("browser.stop"),
			getTabs: async () => unavailable("browser.getTabs"),
			selectTab: async () => unavailable("browser.selectTab"),
			closeTab: async () => unavailable("browser.closeTab"),
			openTab: async () => unavailable("browser.openTab"),
			devtools: async () => unavailable("browser.devtools"),
			destroy: () => unavailable("browser.destroy"),
			setAnnotationMode: async () => unavailable("browser.setAnnotationMode"),
			// Subscriptions stay harmless no-ops. A listener that is never called
			// costs nothing and unsubscribes cleanly, and every one of these is
			// registered unconditionally in an effect that runs before the panel
			// knows whether it will ever have a view — throwing here would take out
			// the component on mount to prevent nothing.
			onNavState: () => () => undefined,
			onTabsState: () => () => undefined,
			onAgentActivity: () => () => undefined,
			onDevToolsState: () => () => undefined,
			onAnnotationSubmit: () => () => undefined,
			onAnnotationCancel: () => () => undefined,
		},
		notifications: {
			show: async () => undefined,
			setBadge: async () => undefined,
			devBounce: async () => undefined,
			onClick: () => () => undefined,
		},
		tray: {
			setAttentionState: () => undefined,
			onOpenSession: () => () => undefined,
		},
		appState: {
			getMigration: async () => ({ status: "pending" }),
			setMigration: async () => undefined,
		},
		updateSettings: {
			get: async () => ({ enabled: false, channel: "latest", nightlyAck: false, feature: null }),
			set: async () => undefined,
		},
		uiSettings: {
			get: async () => ({ ...DEFAULT_UI_SETTINGS }),
			set: async (settings) => coerceUiSettings({ ...DEFAULT_UI_SETTINGS, ...settings }),
		},
		keybindings: {
			get: async () => ({}),
			set: async (overrides) => overrides,
			setRecording: async () => undefined,
		},
		updates: {
			getStatus: async () => ({ state: "idle" }),
			check: async () => undefined,
			returnHome: async () => undefined,
			download: async () => undefined,
			install: async () => undefined,
			onStatus: () => () => undefined,
			onTelemetry: () => () => undefined,
		},
		featureBuilds: {
			list: async () => [],
			getActive: async () => null,
		},
		// A browser deliberately remembers nothing here. The server it talks to
		// is the one that served it, so there is no address to save, and its
		// credential already survives a reload as an HttpOnly cookie the page
		// cannot read. Copying that password into localStorage so this list
		// could be non-empty would hand it to any script on the origin and undo
		// the one property that made the cookie safe.
		remoteServers: {
			list: async () => [],
			save: async () => [],
			remove: async () => [],
			readCredential: async () => null,
		},
		// A browser has no next launch to configure. Its server is whichever one
		// served the page, and it changes by visiting a different address, so
		// there is no setting here to read or write.
		remoteMode: {
			get: async () => null,
			set: async () => ({ server: null, relaunching: false, overriddenByEnv: false }),
		},
		cloud: {
			getSession: async () => null,
			signIn: async () => undefined,
			signOut: async () => undefined,
			onSessionChanged: () => () => undefined,
		},
	} satisfies AoBridge);
