import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "e2e",
	use: {
		baseURL: "http://127.0.0.1:5173",
	},
	webServer: {
		// dev:web:preview serves the renderer alone against fixtures — no Electron
		// child to launch and no daemon to run, which is what the browser-based
		// e2e suite drives. Plain dev:web is the same renderer pointed at a real
		// daemon; it is for working on the app, not for these tests, which assert
		// against the fixed session list in lib/mock-data.ts.
		command: "npm run dev:web:preview -- --port 5173 --host 127.0.0.1",
		port: 5173,
		reuseExistingServer: !process.env.CI,
	},
});
