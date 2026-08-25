export const DEFAULT_POSTHOG_PROJECT_KEY = "phc_uXAqS8nokL2QLSGBZSEMHTUNVXsFeXu3SrcWG7fjEyVH";
export const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * The host the telemetry client sends to, given an environment.
 *
 * Three places have to agree on this exactly: the renderer, which sends;
 * the renderer build, which writes the browser client's policy into its HTML;
 * and the main process, which writes the desktop client's policy into a
 * response header. A host any one of them resolved differently would be a host
 * the other two block, so the resolution lives here rather than being retyped.
 */
export function resolvePosthogHost(env: { VITE_AO_POSTHOG_HOST?: string }): string {
	return env.VITE_AO_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
}
