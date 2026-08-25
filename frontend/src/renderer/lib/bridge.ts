import type { AoBridge } from "../../preload";
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

export const aoBridge: AoBridge =
	window.ao ??
	({
		app: {
			getVersion: async () => "0.0.0-preview",
			chooseDirectory: async () => null,
			openExternal: async (url: string) => {
				window.open(url, "_blank", "noopener,noreferrer");
			},
			scanImportFolder: async ({ path }) => ({ path, repos: [] }),
			checkAncestorRepo: async () => undefined,
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
			getState: async () => ({
				targets: [],
				preferredEditorId: "cursor",
				workspaceAvailable: false,
				unavailableReason: "Desktop app is required to open a workspace.",
			}),
			open: async () => {
				throw new Error("Desktop app is required to open a workspace.");
			},
		},
		telemetry: {
			getBootstrap: async () => null,
		},
		browser: {
			nativeCompositionEnabled: false,
			ensure: async (sessionId: string) => ({
				viewId: `preview:${sessionId}`,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			setBounds: () => undefined,
			setOverlayOpen: () => undefined,
			navigate: async ({ viewId, url }) => ({
				viewId,
				url,
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			clear: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			goBack: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			goForward: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			reload: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			stop: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			getTabs: async (viewId: string) => ({ viewId, activeTabId: "t1", tabs: [] }),
			selectTab: async ({ viewId, tabId }) => ({ viewId, activeTabId: tabId, tabs: [] }),
			closeTab: async ({ viewId }) => ({ viewId, activeTabId: "", tabs: [] }),
			openTab: async ({ viewId }) => ({ viewId, activeTabId: "", tabs: [] }),
			devtools: async ({ viewId, operation }) => ({
				viewId,
				open: operation !== "close",
				activeTabId: "",
			}),
			destroy: () => undefined,
			setAnnotationMode: async () => undefined,
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
		cloud: {
			getSession: async () => null,
			signIn: async () => undefined,
			signOut: async () => undefined,
			onSessionChanged: () => () => undefined,
		},
	} satisfies AoBridge);
