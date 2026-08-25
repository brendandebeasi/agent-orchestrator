import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { rootRelativeAssetReferences, staleBundleEntries } from "./build-web-client-helpers.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptsDir, "..");
const repoRoot = resolve(frontendRoot, "..");
// The bundle is written straight into the directory the daemon embeds from, so
// producing it and embedding it are one step. A build plus a copy would be two,
// and the copy is the one that gets forgotten.
const outDir = join(repoRoot, "backend", "internal", "httpd", "webclient");
const entryPoint = join(outDir, "index.html");

if (!existsSync(outDir)) {
	mkdirSync(outDir, { recursive: true });
} else {
	for (const name of staleBundleEntries(readdirSync(outDir))) {
		rmSync(join(outDir, name), { recursive: true, force: true });
	}
}

// vite's own JS entry point rather than `npx vite`, which on Windows is a shell
// script and would need the cmd.exe boundary the rest of these scripts go out
// of their way to avoid.
const viteEntry = join(frontendRoot, "node_modules", "vite", "bin", "vite.js");
const result = spawnSync(process.execPath, [viteEntry, "build", "--config", "vite.renderer.config.ts"], {
	cwd: frontendRoot,
	// AO_BUILD_TARGET is what tells vite.renderer.config.ts to emit the bundle a
	// daemon serves to a browser rather than the one Electron loads from its own
	// protocol: a relative base, this output directory, and a content security
	// policy naming the serving origin instead of an address baked at build time.
	//
	// VITE_AO_WEB_CLIENT reaches the bundle itself, and answers a question the
	// running client cannot answer from what it can see. Both this build and
	// `npm run dev:web` are the renderer in a browser aimed at its own origin,
	// but one was downloaded from a daemon behind a connection password and has
	// to present a credential, while the other is vite's dev server proxying to
	// a daemon on loopback that wants none. Nothing at runtime distinguishes
	// them — same origin shape, same absent Electron preload — so the build says
	// which one it made.
	env: { ...process.env, AO_BUILD_TARGET: "web", VITE_AO_WEB_CLIENT: "1" },
	stdio: "inherit",
	windowsHide: true,
});

if (result.error) {
	console.error(`failed to start vite: ${result.error.message}`);
	process.exit(1);
}
if (result.status !== 0) {
	process.exit(result.status ?? 1);
}

if (!existsSync(entryPoint)) {
	console.error(`vite reported success but wrote no entry point to ${entryPoint}`);
	process.exit(1);
}

const rootRelative = rootRelativeAssetReferences(readFileSync(entryPoint, "utf8"));
if (rootRelative.length > 0) {
	console.error(
		`the built entry point references ${rootRelative.join(", ")} from the server root, but the daemon serves this ` +
			`client under /app/ and keeps its API at the root. Check the "base" option in vite.renderer.config.ts.`,
	);
	process.exit(1);
}

console.log(`web client written to ${outDir}; build a daemon with -tags webui to embed it`);
