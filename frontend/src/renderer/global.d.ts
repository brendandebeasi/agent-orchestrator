import type { AoBridge } from "../preload";

declare global {
	interface Window {
		ao?: AoBridge;
	}

	interface ImportMetaEnv {
		readonly VITE_AO_POSTHOG_KEY?: string;
		readonly VITE_AO_POSTHOG_HOST?: string;
		/** "1" serves fixtures instead of talking to a daemon — see lib/preview-mode.ts. */
		readonly VITE_AO_PREVIEW?: string;
		/** "1" builds the renderer for a browser host, with no Electron preload. */
		readonly VITE_NO_ELECTRON?: string;
		/** Fixed server address for builds that ship one; otherwise the client is aimed at runtime. */
		readonly VITE_AO_API_BASE_URL?: string;
	}
}

export {};
