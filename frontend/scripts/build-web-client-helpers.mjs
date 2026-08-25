// The two files the embed directory owns permanently: the marker that keeps the
// directory present in a clean checkout, which is what makes the `go:embed` in
// webclient_webui.go compile before anyone has run this build, and the ignore
// rule that keeps a built bundle out of git. Everything else in there is output
// from a previous run of this script.
const COMMITTED_MARKERS = [".gitkeep", ".gitignore"];

/**
 * The entries of the embed directory a fresh build should delete.
 *
 * The build can neither empty the directory nor leave it alone. Emptying it
 * removes the committed marker and breaks the next clean checkout; leaving it
 * accumulates bundles, because vite emits content-hashed asset names and every
 * rebuild writes a new set beside the old one. A daemon built afterwards would
 * embed every bundle ever produced on that machine — correct to serve, since the
 * entry point still names the current assets, but multiplying the binary size by
 * however many times the developer had run the build.
 */
export function staleBundleEntries(names) {
	return names.filter((name) => !COMMITTED_MARKERS.includes(name));
}

/**
 * The asset references in `html` that resolve from the server root rather than
 * from the document, which is the one mistake that would make a bundle build
 * cleanly and then fail to load.
 *
 * The daemon serves this client under `/app/` and keeps its API at the root, so
 * a `/assets/index-abc.js` reference asks the daemon for a route it does not
 * have and the page comes up blank with a MIME-type error in the console. That
 * is a build-configuration failure — vite's `base` — showing up as a runtime
 * one, hours later, on someone else's machine. Cheaper to catch here.
 *
 * Protocol-relative and absolute URLs (`//host/…`, `https://…`) are not what
 * this is looking for and are left alone; the policy on those is the content
 * security policy's business, and the bundle has none of them to begin with.
 */
export function rootRelativeAssetReferences(html) {
	const found = [];
	for (const match of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)) {
		const value = match[1];
		if (value.startsWith("/") && !value.startsWith("//")) found.push(value);
	}
	return found;
}
