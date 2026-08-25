/**
 * The renderer's content security policy.
 *
 * There is one policy per kind of host, because the thing the policy has to
 * permit — reaching the daemon — is in a different place in each. A desktop
 * client loads its bundle from a custom protocol and reaches a daemon at an
 * address that is not its own origin. A browser client is served by the daemon
 * it talks to, so its own origin is the whole answer.
 *
 * This used to be a single constant in `vite.renderer.config.ts` pinning
 * network access to `127.0.0.1`, which was exactly right while every daemon was
 * on loopback. Remote mode makes that premise false: the address comes from a
 * setting the operator writes, so it cannot be known when the bundle is built,
 * and a policy baked at build time would refuse every request the feature
 * exists to make. The desktop policy is therefore built per launch, in the main
 * process, which knows the address — and delivered as a response header from
 * the protocol handler rather than as a `<meta>` tag, because the two would be
 * intersected and the narrower one would win.
 */

/**
 * Where the daemon is, from the page's point of view.
 *
 * `loopback` is an ordinary desktop launch: the supervisor starts a daemon on
 * this machine and the port is not known until it does, so the whole loopback
 * range is permitted. `sameOrigin` is a browser client, which was served by its
 * daemon. A base URL is a desktop launch attached to a server elsewhere.
 */
export type DaemonLocation = { kind: "loopback" } | { kind: "sameOrigin" } | { kind: "remote"; baseUrl: string };

/**
 * The origins a page must be allowed to reach to talk to a daemon at `baseUrl`:
 * the daemon's own origin for HTTP and event streams, and the WebSocket origin
 * for terminal streams. CSP treats `ws://host` and `http://host` as different
 * sources even though they are the same server, so both have to be named.
 *
 * Returns nothing for an address that is not a URL. The callers normalize
 * before they get here, so this is a floor rather than a case that happens.
 */
function daemonOrigins(baseUrl: string): string[] {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return [];
	}
	const secure = url.protocol === "https:";
	return [url.origin, `${secure ? "wss:" : "ws:"}//${url.host}`];
}

/**
 * The origins the telemetry client talks to, given the configured PostHog host.
 *
 * posthog-js serves capture from the configured host but fetches remote config
 * from a sibling `-assets` host it derives from the same name, so a policy built
 * only from the configured host blocks that request and logs a console error on
 * every launch. Capture is unaffected and AO ignores what remote config offers
 * — replay, flags, and surveys are all disabled in the client — so allowing the
 * origin only silences the error; the client's own settings still win.
 *
 * The `asset_host` option deliberately does not cover this: per its own docs it
 * "only applies to /static/* asset paths; dynamic assets like remote config
 * continue to use the regular asset host derived from api_host".
 *
 * Scoped to PostHog Cloud, matching what posthog-js itself does — it only
 * rewrites to an `-assets` sibling for `*.posthog.com`. A self-hosted instance
 * or a loopback capture endpoint serves everything from one origin, and deriving
 * there would emit a nonsense entry (`127.0.0.1` would become
 * `127-assets.0.0.1`).
 */
export function posthogOrigins(host: string): string[] {
	const configured = host.trim();
	if (!configured) return [];
	let url: URL;
	try {
		url = new URL(configured);
	} catch {
		return [];
	}
	const origins = [url.origin];
	if (/\.posthog\.com$/i.test(url.hostname)) {
		const assetsHost = url.hostname.replace(/^([^.]+)\./, "$1-assets.");
		if (assetsHost !== url.hostname) origins.push(`${url.protocol}//${assetsHost}`);
	}
	return origins;
}

/**
 * The policy for a page whose daemon is at `daemon`, allowing telemetry to the
 * origins in `telemetry`.
 *
 * Everything outside `connect-src` and `img-src` is the same for every host and
 * is the part that actually constrains an attacker: `script-src 'self'` is what
 * stops injected code from running at all, and `object-src 'none'`,
 * `base-uri 'self'`, and `frame-src 'none'` close the usual ways around it. The
 * two directives that vary are the two that describe where the daemon is.
 */
export function rendererContentSecurityPolicy(options: {
	daemon: DaemonLocation;
	telemetry?: readonly string[];
}): string {
	const { daemon } = options;
	const telemetry = options.telemetry ?? [];
	// Loopback stays permitted for a remote launch as well. The client is still
	// an Electron app on this machine, and the browser panel, the ACP runtime,
	// and a daemon started here for a different window all live there; a remote
	// launch that later relaunches local would otherwise be a policy change with
	// no page load in between.
	const local = daemon.kind === "sameOrigin" ? [] : ["http://127.0.0.1:*", "ws://127.0.0.1:*"];
	const remote = daemon.kind === "remote" ? daemonOrigins(daemon.baseUrl) : [];
	// The daemon serves the images the renderer shows — avatars, diff previews,
	// anything a session produced — from the same origin it serves the API from.
	const imageOrigins = daemon.kind === "sameOrigin" ? [] : ["http://127.0.0.1:*", ...remote.filter(isHttp)];
	return [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		["img-src", "'self'", "data:", ...imageOrigins].join(" "),
		"font-src 'self' data:",
		["connect-src", "'self'", ...local, ...remote, ...telemetry].join(" "),
		"object-src 'none'",
		"base-uri 'self'",
		"frame-src 'none'",
	].join("; ");
}

function isHttp(origin: string): boolean {
	return origin.startsWith("http://") || origin.startsWith("https://");
}
