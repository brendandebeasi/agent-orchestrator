import { useSyncExternalStore } from "react";
import { aoBridge } from "../lib/bridge";
import { getServerTarget, subscribeServerTarget } from "../lib/server-target";
import type { HostCapabilityName } from "../../shared/host-capabilities";

/**
 * Whether a host-bound feature is usable right now, and why not when it is not.
 *
 * Deliberately not a boolean. Every call site has to render something when the
 * answer is no — an absent button, or a disabled one carrying a reason — and a
 * hook that returned only `false` would leave each of them inventing its own
 * explanation, which is exactly the drift this module exists to prevent.
 */
export type HostCapabilityState = {
	available: boolean;
	/** A message key to explain the absence, or null when the feature is available. */
	reasonKey: "hostCapability.needsDesktopApp" | "hostCapability.needsLocalServer" | null;
	/** The server's display name, for reasons that name it. */
	serverLabel: string;
};

/**
 * Two independent facts decide this, and both have to hold.
 *
 * The host declares what it is wired to: an Electron preload reports every
 * capability, a browser tab reports none. That answers "could this work at all",
 * and it is fixed for the life of the window.
 *
 * The server target decides whether it would be *right*. Every one of these
 * features reaches for something on a disk — a worktree to open, a directory to
 * reveal, a path to pick — and takes for granted that the disk holding it is
 * this one. Point the desktop client at a daemon on another machine and that
 * stops being true while every capability the preload declared stays declared:
 * the editor still launches, and it launches on a path that does not exist here.
 * So a capability is withdrawn when the server is remote, whatever the host said.
 *
 * The host cannot make this second call by itself, which is why it is not folded
 * into the preload's declaration. Remote mode is a startup setting there, and the
 * operator can connect somewhere else long after startup.
 */
export function hostCapability(name: HostCapabilityName): HostCapabilityState {
	const target = getServerTarget();
	if (!aoBridge.capabilities[name]) {
		return { available: false, reasonKey: "hostCapability.needsDesktopApp", serverLabel: target.label };
	}
	if (target.kind !== "local") {
		return { available: false, reasonKey: "hostCapability.needsLocalServer", serverLabel: target.label };
	}
	return { available: true, reasonKey: null, serverLabel: target.label };
}

// One state object per (name, target) so useSyncExternalStore's identity check
// does not see a fresh object on every render and loop. The bridge half never
// changes, so the target is the whole key.
const cache = new Map<HostCapabilityName, HostCapabilityState>();
let cachedTarget = getServerTarget();

function snapshot(name: HostCapabilityName): HostCapabilityState {
	const target = getServerTarget();
	if (target !== cachedTarget) {
		cache.clear();
		cachedTarget = target;
	}
	const hit = cache.get(name);
	if (hit) return hit;
	const next = hostCapability(name);
	cache.set(name, next);
	return next;
}

/**
 * The only permitted read of `aoBridge.capabilities` (see the guard in
 * `useHostCapability.test.tsx`). Re-renders when the server target changes, so
 * connecting to another machine withdraws these features from the UI without a
 * reload.
 */
export function useHostCapability(name: HostCapabilityName): HostCapabilityState {
	return useSyncExternalStore(
		subscribeServerTarget,
		() => snapshot(name),
		() => snapshot(name),
	);
}
