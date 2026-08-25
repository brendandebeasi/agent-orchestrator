/**
 * Leaving the app entirely, as opposed to routing within it.
 *
 * One line in its own module for one reason: `window.location` is unforgeable,
 * so a test can neither replace it nor spy on its methods. The seam a test needs
 * therefore has to sit one level above it, and a module is the only seam
 * available. Everything else in the renderer navigates through the router, which
 * is a hash change and needs no such thing.
 */
export function replaceLocation(url: string): void {
	window.location.replace(url);
}
