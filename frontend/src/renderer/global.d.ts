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
		/**
		 * "1" builds the bundle a daemon serves at `/app/`, which reaches its
		 * daemon over the network listener and must present the credential its
		 * login page obtained. Set only by `npm run build:web`; `npm run dev:web`
		 * is also a browser build but proxies to a loopback daemon that wants no
		 * credential, and nothing at runtime tells the two apart.
		 */
		readonly VITE_AO_WEB_CLIENT?: string;
		/** Fixed server address for builds that ship one; otherwise the client is aimed at runtime. */
		readonly VITE_AO_API_BASE_URL?: string;
	}
}

export {};
