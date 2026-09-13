// What a boot failure SAYS. Pure, so it can be checked without a browser: the
// error paths this maps are precisely the ones nobody can reproduce on the
// machine the game was written on.
//
// Every rejection of the startup chain ends on the loading screen through
// src/hud.js's fail(), which now carries a [ RELOAD ]. The text it carries is
// decided here. Three of the four cases exist because the raw message is either
// meaningless to a player or actively misleading about whose fault it is.
//
// Runs in the browser (bundled by Vite, imported by src/main.js) and in Node
// (the selftest) — no DOM, no `node:` import.

// The rocktree host. Named once: the message says it, and the matcher looks for
// it. Anything that reaches the player naming a host must name the same one.
export const TERRAIN_HOST = 'kh.google.com';

export const TERRAIN_UNREACHABLE =
	`terrain: the tile server could not be reached — an ad blocker, a VPN or a corporate proxy is the usual cause. Allow ${TERRAIN_HOST}, or try another network.`;

export const TERRAIN_EMPTY =
	'terrain: no ground arrived at this point after 45 s — the connection is too slow, partly blocked, or there is simply nothing mapped here. Reload and try another location.';

export const PHYSICS_OOM =
	"physics: out of memory — close the game's other tabs, then reload";

export const PHYSICS_UNAVAILABLE =
	'physics: the WebAssembly module could not be loaded — a proxy or a content blocker is the usual cause. Reload, or try another network.';

export const NO_WEBGL2 =
	'graphics: this browser could not create a WebGL2 context — update it, or turn hardware acceleration back on';

// One blocked request is spelled three ways: "Failed to fetch" on Chromium,
// "NetworkError when attempting to fetch resource" on Firefox, "Load failed" on
// Safari. A blocker that answers instead of dropping gives a status line
// carrying the host ("403 https://kh.google.com/rt/earth/PlanetoidMetadata"),
// which is what the traverse worker rethrows.
const NETWORK_RE = /Failed to fetch|NetworkError|Load failed|ERR_(?:BLOCKED|FAILED|CONNECTION|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED)/i;

export function isTerrainNetworkFailure(message) {
	const msg = String(message ?? '');
	return msg.includes(TERRAIN_HOST) || /rocktree|traverse worker/i.test(msg) || NETWORK_RE.test(msg);
}

// The 2 MB Rapier module is a dynamic import: a proxy, an offline reload or an
// over-eager blocker can refuse the chunk outright. That is NOT the trap below —
// nothing ran out of memory, the file never arrived.
export function isPhysicsLoadFailure(message) {
	const msg = String(message ?? '');
	return /dynamically imported module|WebAssembly\.instantiate|\.wasm\b|importing a module script failed/i.test(msg)
		&& /rapier|physics|wasm/i.test(msg);
}

// An error carrying `userMessage: true` has already been written for a player
// (the live boot's own 45 s deadline) and is passed through untouched.
export function bootFailureMessage(err) {
	if (err && err.userMessage) return String(err.message);
	// A Rapier WASM trap ("RuntimeError: unreachable") is not a JS exception with
	// a readable meaning: in practice (issue #249) it is an allocation that
	// failed because the renderer process is out of memory — other tabs of the
	// game, or several flights chained in the same tab. Say that, and say what to
	// do about it, rather than printing "unreachable".
	if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) return PHYSICS_OOM;
	const msg = String(err?.message ?? err ?? '');
	if (isPhysicsLoadFailure(msg)) return PHYSICS_UNAVAILABLE;
	if (isTerrainNetworkFailure(msg)) return TERRAIN_UNREACHABLE;
	return msg;
}

// Builds the rejection the live boot raises when its deadline expires with no
// ground under the spawn. Flagged so bootFailureMessage() hands it straight
// through instead of re-classifying it as a plain network failure.
export function terrainEmptyError(detail = '') {
	const err = new Error(TERRAIN_EMPTY + (detail ? ` (${detail})` : ''));
	err.userMessage = true;
	return err;
}
