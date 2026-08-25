/**
 * The handoff from the login page a daemon serves to the client it then loads.
 *
 * A browser client cannot be handed its credential the way the desktop one is.
 * It is downloaded by the daemon it will talk to, after a login page has already
 * taken the password and exchanged it at `POST /api/v1/remote/session`. That
 * exchange returns two things the client needs and has no other way to learn —
 * the token for its own API and stream requests, and the daemon's version — and
 * the login page leaves both in `sessionStorage` before navigating to the app.
 *
 * `sessionStorage` rather than a cookie because the client has to read them:
 * `ao_web` is HttpOnly, and deliberately so, and it authenticates only the
 * requests the browser makes on the client's behalf. Rather than a cookie the
 * client could read, because that cookie would ride along on every request to
 * the daemon's own origin, which is where its API lives.
 *
 * The consequence is that a credential lives exactly as long as the tab. A
 * second tab opened on `/app/` gets the assets, since the cookie is the
 * browser's, but finds no token and is sent back to the login page to ask for
 * the password again. That is the correct trade: the alternative is a credential
 * that outlives the session that was granted it.
 *
 * The two key names are written by `backend/internal/httpd/remote_web_page.go`,
 * which has a test asserting it and this file still agree.
 */

export const REMOTE_SESSION_TOKEN_KEY = "ao.remote.token";
export const REMOTE_SESSION_VERSION_KEY = "ao.remote.serverVersion";

/** Where the daemon serves the login page, relative to the client it serves. */
export const REMOTE_LOGIN_PATH = "/";

export type RemoteSession = {
	/** The credential for API, stream, and terminal requests. */
	token: string;
	/** The daemon's app version, or "" when it was launched without one. */
	appVersion: string;
};

/**
 * The session the login page left behind, or null when there is none to find.
 *
 * A storage that throws is treated as an absent session rather than allowed to
 * fail the launch: Safari's private mode and some enterprise policies make
 * `sessionStorage` a property access that raises, and the recovery for "no
 * session" — go ask for the password — is the right one either way.
 */
export function readRemoteSession(storage: Pick<Storage, "getItem"> | null | undefined): RemoteSession | null {
	if (!storage) return null;
	try {
		const token = storage.getItem(REMOTE_SESSION_TOKEN_KEY);
		if (token === null || token === "") return null;
		return { token, appVersion: storage.getItem(REMOTE_SESSION_VERSION_KEY) ?? "" };
	} catch {
		return null;
	}
}
