import { defineConfig } from "vite";

// Forge's VitePlugin handles all main-process build configuration.
// Add overrides here only if needed (e.g. custom externals or aliases).
export default defineConfig({
	define: {
		// The main process writes the desktop client's content security policy,
		// which has to name the same telemetry origins the renderer bundle will
		// actually send to. The renderer reads that host from `import.meta.env`,
		// which vite resolves when the renderer is built; the main process has no
		// equivalent, and by the time a packaged app runs there is no environment
		// left to read — the value was chosen on the build machine. Inlining it
		// here from the same variable, in the same build, is what keeps the policy
		// and the client that has to satisfy it from disagreeing.
		//
		// Empty rather than absent when unset: `resolvePosthogHost` treats an empty
		// value as "use the default", which is exactly what the renderer does with
		// an unset `import.meta.env` entry, whereas a literal `undefined` here
		// would leave `process.env` referenced at runtime in the packaged main
		// bundle and resolve to something different on the user's machine.
		"process.env.VITE_AO_POSTHOG_HOST": JSON.stringify(process.env.VITE_AO_POSTHOG_HOST ?? ""),
	},
});
