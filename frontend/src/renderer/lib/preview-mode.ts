// Fixed at module load because it is a build-time flag: the value cannot change
// while the renderer runs, and pinning it here keeps every call site agreeing
// with every other one no matter when it asks.
const previewMode = import.meta.env.VITE_AO_PREVIEW === "1";

/**
 * Whether the renderer is serving fixtures instead of talking to a daemon.
 *
 * This used to be `VITE_NO_ELECTRON === "1"`, which conflated two unrelated
 * facts: "there is no Electron preload behind this window" and "there is no
 * daemon behind this window". They were the same thing only because the browser
 * build existed solely as a design preview. A browser client that connects to a
 * real daemon breaks the equivalence — it has no preload and every reason to
 * ask the server for real data — so the fixture path gets a flag of its own and
 * `VITE_NO_ELECTRON` goes back to meaning what it says.
 */
export function isPreviewMode(): boolean {
	return previewMode;
}
