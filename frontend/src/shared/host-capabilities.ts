/**
 * What the host around the renderer can do on the server's behalf.
 *
 * Every entry names a feature that reaches outside the app to something on a
 * computer: launching an editor, revealing a directory, opening a native file
 * dialog, embedding a real browser view. None of them are features of the
 * daemon, and none of them travel — a renderer in a browser tab has no editor
 * to launch, and a desktop client pointed at a daemon on another machine has an
 * editor but nothing on this disk for it to open.
 *
 * They are declared rather than detected because the renderer cannot tell the
 * difference by probing: `window.ao` being present says an Electron preload is
 * there, not that the feature behind it is meaningful right now. The host knows
 * and says so.
 */
export type HostCapabilityName =
	/** Launch a local editor on a session's worktree. */
	| "editorHandoff"
	/** Reveal a session's worktree in the platform file manager. */
	| "revealInFileManager"
	/** Open the native directory-chooser dialog. */
	| "directoryPicker"
	/** Embed the native browser view the agent drives. */
	| "browserPanel";

export type HostCapabilities = Record<HostCapabilityName, boolean>;

/** Every capability off — the honest answer from a host that is only a browser. */
export const NO_HOST_CAPABILITIES: HostCapabilities = {
	editorHandoff: false,
	revealInFileManager: false,
	directoryPicker: false,
	browserPanel: false,
};

/** Every capability on — a desktop host beside the daemon it talks to. */
export const ALL_HOST_CAPABILITIES: HostCapabilities = {
	editorHandoff: true,
	revealInFileManager: true,
	directoryPicker: true,
	browserPanel: true,
};

export const HOST_CAPABILITY_NAMES = Object.keys(NO_HOST_CAPABILITIES) as HostCapabilityName[];
