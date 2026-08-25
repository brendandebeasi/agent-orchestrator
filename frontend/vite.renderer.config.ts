// defineConfig comes from vitest/config (a superset of vite's) so the `test`
// block typechecks; vitest itself must be pointed at this file explicitly
// (package.json test script) because it only auto-discovers vite.config.*.
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import { fileURLToPath, URL } from "node:url";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { posthogOrigins, rendererContentSecurityPolicy } from "./src/shared/content-security-policy";
import { resolvePosthogHost } from "./src/shared/posthog-config";

// Set by `npm run build:web`: emit the bundle a daemon serves to a browser
// rather than the one Electron loads from its own protocol. The two differ in
// where their assets live and in what their content security policy has to
// permit, and nothing else.
const WEB_BUILD = process.env.AO_BUILD_TARGET === "web";

const POSTHOG_ORIGINS = posthogOrigins(resolvePosthogHost(process.env));

// A browser client is served by the daemon it talks to, so its own origin is
// the whole answer and a policy baked into the HTML is exactly right.
//
// The desktop client gets no meta tag at all. Its daemon may be on another
// machine at an address that is not known when this bundle is built, so its
// policy is written per launch by the main process and delivered as a response
// header from the protocol handler that serves this HTML. A meta tag here would
// be intersected with that header and the narrower one would win, which is to
// say the feature would not work.
const injectCspMeta: Plugin = {
	name: "inject-csp-meta",
	apply: "build",
	transformIndexHtml() {
		if (!WEB_BUILD) return [];
		return [
			{
				tag: "meta",
				attrs: {
					"http-equiv": "Content-Security-Policy",
					content: rendererContentSecurityPolicy({
						daemon: { kind: "sameOrigin" },
						telemetry: POSTHOG_ORIGINS,
					}),
				},
				injectTo: "head-prepend",
			},
		];
	},
};

const productUiReactBoundary: Plugin = {
	name: "product-ui-react-boundary",
	enforce: "pre",
	async resolveId(source, importer) {
		if (!importer?.includes("/packages/product-ui/")) {
			return null;
		}
		const remap =
			source === "react" ||
			source.startsWith("react/") ||
			source === "react-dom" ||
			source.startsWith("react-dom/") ||
			source === "motion" ||
			source.startsWith("motion/");
		if (!remap) {
			return null;
		}
		return this.resolve(
			source,
			fileURLToPath(new URL("./src/renderer/main.tsx", import.meta.url)),
			{ skipSelf: true },
		);
	},
};

export default defineConfig({
	// The daemon serves the browser client under /app/, keeping its own API and
	// mux routes at the root, so the bundle cannot reference its assets from the
	// root the way the desktop bundle does. Relative rather than a hard-coded
	// "/app/" because it costs nothing here: the client uses hash history, so
	// the document URL is always the directory itself and never a deep path that
	// relative URLs would resolve against wrongly. In exchange the bundle works
	// under whatever prefix it is mounted at, including behind a reverse proxy
	// that adds one.
	base: WEB_BUILD ? "./" : "/",
	// Written straight into the directory the daemon embeds from, so producing
	// the bundle and embedding it are one step rather than a build plus a copy
	// nobody remembers to run. The directory ignores everything but its own
	// markers, so no build output is ever committed.
	build: WEB_BUILD ? { outDir: "../backend/internal/httpd/webclient", emptyOutDir: false } : {},
	// "@/" → the renderer root (src/renderer), the shadcn/ui import convention.
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src/renderer", import.meta.url)),
			"@aoagents/product-ui": fileURLToPath(
				new URL("../packages/product-ui/src/index.ts", import.meta.url),
			),
			// The alias above resolves product-ui to its source, so that package's
			// own imports resolve from packages/product-ui/ — which only has a
			// node_modules if `npm ci` was run there too. CI does that; a
			// frontend-only install does not, and the failure mode is quiet: every
			// test importing product-ui dies at transform time with "failed to
			// resolve clsx", which reads as pre-existing breakage rather than a
			// missing install. Point both runtime deps at the frontend copies so
			// one install is enough.
			clsx: fileURLToPath(new URL("./node_modules/clsx", import.meta.url)),
			"tailwind-merge": fileURLToPath(
				new URL("./node_modules/tailwind-merge", import.meta.url),
			),
		},
	},
	// Dev proxy for the browser build (VITE_NO_ELECTRON=1) — forwards /api and
	// /mux to the daemon so the renderer runs against a real daemon from a plain
	// browser with no Electron shell. Same-origin by design: the renderer aims
	// itself at the page origin, so nothing here needs a CORS story.
	server: {
		proxy: {
			"/api": {
				target: process.env.AO_DEV_API_TARGET ?? "http://127.0.0.1:3001",
				changeOrigin: false,
			},
			"/mux": {
				target: process.env.AO_DEV_API_TARGET ?? "http://127.0.0.1:3001",
				changeOrigin: false,
				ws: true,
			},
		},
	},
	plugins: [
		TanStackRouterVite({
			routesDirectory: "./src/renderer/routes",
			generatedRouteTree: "./src/renderer/routeTree.gen.ts",
			target: "react",
			autoCodeSplitting: true,
		}),
		productUiReactBoundary,
		react(),
		tailwindcss(),
		injectCspMeta,
	],
	test: {
		environment: "jsdom",
		testTimeout: 20_000,
		// Anchor node_modules at any depth: a bare "node_modules/**" replaces
		// vitest's default "**/node_modules/**" and only matches the root, so the
		// tracked src/landing preview app's nested node_modules would otherwise
		// have its vendored third-party test suites collected and run.
		exclude: ["**/node_modules/**", "dist/**", "dist-electron/**", "e2e/**"],
		globals: true,
		setupFiles: "./src/renderer/test/setup.ts",
	},
});
