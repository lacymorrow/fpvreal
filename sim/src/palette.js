// PHASE 19 (issue #56) — the bridge between tokens.css and the little code that
// paints for itself.
//
// A Leaflet vector layer does not understand `var(--warm-white)`: it wants a
// resolved colour, as a string. Rather than copying the values into the JS —
// which is exactly what made `#7ddc8a` and `#7ddc9a` diverge before this
// phase — the stylesheet is read, and stays the single source.
//
// What is NOT here: drone-osd.js's canvas palette. That OSD is painted into the
// drone's image and crosses the video link — it is filmed material, not
// interface. Its colours belong to the hardware, not to the tokens, and
// Bible §42 wants whatever passes through the camera to stay raw.

const cache = new Map();

// The fallback values serve rendering outside a browser (Node tests) and the
// instant when a layer would be built before the sheet is applied. They must
// stay aligned with tokens.css; palette-selftest.mjs checks it.
const FALLBACK = {
	'--black': '#0a0908',
	'--dark-grey': '#121110',
	'--grey': '#221f1c',
	'--warm-white': '#ece7dd',
	'--light-grey': '#8a827a',
	'--green': '#7aa96b',
	'--yellow': '#d4b155',
	'--orange': '#cf7b3e',
	'--red': '#d4635c',
	// The one demo colour a daily screen may touch, and only under the cursor:
	// DATA marks the SELECTED item with it (issue #26, Bible §19).
	'--magenta': '#e34de0',
};

export function token(name) {
	if (cache.has(name)) return cache.get(name);
	let v = '';
	if (typeof document !== 'undefined') {
		v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	}
	if (!v) return FALLBACK[name] ?? '';
	// Only a genuinely resolved value is cached: otherwise a call made too early
	// would freeze the fallback for the whole session.
	cache.set(name, v);
	return v;
}

// For the tests only: the sheet does not change during a session.
export function resetPaletteCache() { cache.clear(); }
