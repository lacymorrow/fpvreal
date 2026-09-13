// Model of the musical arc (issue #122). Pure logic: NO Web Audio, NO DOM, NO
// `node:`. Imported as-is by the selftest and, through a Vite bundle, by
// src/music.js. The rendering lives over there.
//
// The whole arc fits in ONE scalar, `intensity` in [0,1]:
//
//   terminal --MENU--+
//                    +- HACK (0.12, "the music from the next room")
//                    |      +- the ritual ducks it
//                    +- DROP (1.0, in 0.4 s -- the release)
//                    +- flight: flightIntensity(telemetry)
//
// The music never names the drone. At HACK the family is already known to the
// code but the screen does not reveal it: the music is the first sensory clue.
// "You don't read the drone. You feel it."

import { rngFrom } from './target-build.mjs';
import { MUSIC_POOLS } from './music-prompts.mjs';
import { asText, nameOf } from './lib/as-text.mjs';

export const MUSIC_SCHEMA_VERSION = 1;
export { MUSIC_POOLS };

const POOL_SET = new Set(MUSIC_POOLS);

// --- intensity ---------------------------------------------------------------

// Two parameters only -- a filter and a gain -- so that calibrating by ear stays
// feasible. A third axis (a shelf, a reverb) would make the setting impossible
// to hold in one's head.
//
// The filter carries most of the effect: at k=0 only the bottom of the spectrum
// is left, exactly what music through a wall sounds like. Gain alone would only
// give "quieter" music, not "elsewhere" music.
export const INTENSITY = {
	cutoffHz: [380, 19000],  // interpolated in log: the ear hears octaves
	gainDb: [-20, 0],        // interpolated in dB, converted to linear on output
};

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** k in [0,1] -> { cutoffHz, gain }; gain is LINEAR, ready for an AudioParam. */
export function intensityParams(k) {
	const t = clamp01(k);
	const [c0, c1] = INTENSITY.cutoffHz;
	const [g0, g1] = INTENSITY.gainDb;
	const cutoffHz = c0 * Math.pow(c1 / c0, t);
	const gainDb = g0 + (g1 - g0) * t;
	return { cutoffHz, gain: Math.pow(10, gainDb / 20) };
}

// The steps of the arc. MENU sits above HACK: the terminal is a place one sits
// in, the hack is stolen listening.
export const PHASE_INTENSITY = {
	MENU: 0.55,
	// Raised from 0.12 to 0.28 (field feedback, 2026-09-06): at 0.12 the hack,
	// and the Control Vector ritual that ducks it further, could not be heard at
	// all -- "the next room" had ended up with the door shut. At 0.28 the cutoff
	// (see intensityParams) stays under 1.2 kHz, so still filtered and clearly
	// behind MENU: the music stays elsewhere, but you know it is playing.
	HACK: 0.28,
	DROP: 1.0,
	// Flight NEVER goes below this. Raised from 0.30 to 0.62 after listening: in
	// FPV the throttle is cut constantly -- punch, chop, dive, coast -- and at
	// 0.30 the music dropped to -14 dB behind a 1.2 kHz cutoff, i.e. it vanished
	// on every normal piloting gesture.
	//
	// The floor does not cancel the arc, it moves it: from 0.62 to 1.0 the cutoff
	// still travels from 4.1 to 19 kHz and the gain from -7.6 to 0 dB. What
	// changes is that the bottom of the range now reads as "the music breathes"
	// rather than "the music leaves".
	FLOOR: 0.62,
};

// Transition durations, in milliseconds.
export const FADE = {
	menuToHack: 1500,  // the menu track fades out while the drone's fades in
	drop: 400,         // the release: short, but not a click
	kill: 30,          // the crash: a clean cut, just long enough not to pop
};

// The ritual has its own synthesised score (Bible section 36) and that is what
// must peak, not the music.
// Raised from 0.25 to 0.55 along with HACK (2026-09-06): the ritual's duck
// stacked on an already very muffled HACK (-17.6 dB x 0.25 = about -30 dB
// combined, below a headset's noise floor). The ritual must still dominate its
// own synthesised score, not disappear into silence: 0.55 lets the hack step
// clearly back (-5 dB more) without extinguishing it.
export const DUCK = { ritual: 0.55, ms: 250 };

// NOT CALIBRATED. These three values are a reasoned starting point, NOT a
// measurement, and the repository requires thresholds to be measured.
//
// What was tried and why it failed: a scripted open-loop flight (sticks frozen
// through window.__sim.setInput) does not produce representative speeds --
// without a piloting loop the drone falls or drifts, and the reading obtained
// (k between 0.62 and 0.96 over 450 frames) measured free fall, not flight.
// Calibrating on that would have been worse than not calibrating.
//
// TO DO, sticks in hand, during the listening session (same session, same
// acceptance criterion). Paste into the console during a normal flight:
//
//   const s=[]; const t=setInterval(()=>{const v=__sim.physics.velocity;
//     s.push([+Math.hypot(v.x,v.y,v.z).toFixed(1), +__sim.music.intensity.toFixed(2)]);},100);
//   // ... fly for 60 s: hover, cruise, rush, turns, proximity ...
//   clearInterval(t); console.log(JSON.stringify(s));
//
// Then set speedRefMs so that k really travels from the floor to full over the
// range of speeds actually flown -- neither stuck at FLOOR nor saturated at 1.
export const FLIGHT = {
	speedRefMs: 25,      // speed beyond which speed pushes no further
	// The stick weight went from 0.40 to 0.25, the speed weight from 0.60 to
	// 0.75. Measured reason: the stick is TWITCHY, speed has inertia. At 0.40,
	// cutting the throttle removed 0.28 of intensity in one go, while the drone
	// keeps flying -- the music dived on a gesture that changes nothing about
	// what the pilot feels.
	wThrottle: 0.25,     // what the player DOES
	wSpeed: 0.75,        // what the player UNDERGOES -- that is what is felt
};

// ASYMMETRIC smoothing of the intensity, in seconds. Rise fast, fall slowly:
// this is the second remedy to throttle chops, and the more important one.
//
// A chop lasts half a second; a real lull lasts ten. With a single constant the
// two look alike. With a slow fall, the chop barely descends -- the music has no
// time -- while a flight that really calms down does come back down. That is the
// principle of an envelope follower, and it encodes musically the difference
// between a gesture and an intention.
export const INTENSITY_TAU = {
	rise: 0.25,
	fall: 1.80,
};

/**
 * Telemetry -> intensity. Pure, stateless and dt-free: the smoothing is done by
 * src/music.js with setTargetAtTime, hence independent of the frame rate.
 * Disarmed, it falls back to the floor: the music waits with the player.
 */
export function flightIntensity({ throttle = 0, speedMs = 0, armed = true } = {}) {
	if (!armed) return PHASE_INTENSITY.FLOOR;
	const thr = clamp01(throttle);
	const spd = clamp01(Math.max(0, Number.isFinite(speedMs) ? speedMs : 0) / FLIGHT.speedRefMs);
	const drive = clamp01(FLIGHT.wThrottle * thr + FLIGHT.wSpeed * spd);
	return PHASE_INTENSITY.FLOOR + (1 - PHASE_INTENSITY.FLOOR) * drive;
}

// --- selection ---------------------------------------------------------------

// How many recently played tracks are excluded from the draw. Enough that an
// evening does not repeat, few enough not to empty a pool of 10.
export const RECENT_LIMIT = 12;

/**
 * Draws a track. Pure and deterministic: the same (pool, seed) always yields the
 * same track for an equal `recent` -- so resuming a session means resuming that
 * drone AND its music.
 *
 * `recent` (the ids last played) is set aside while there is still a choice; if
 * it covers the whole pool a track is replayed rather than returning silence.
 *
 * @returns {object|null} the manifest entry, or null if the pool is empty.
 */
export function pickTrack(manifest, pool, seed, recent = []) {
	const all = (manifest?.tracks ?? []).filter((t) => t.pool === pool);
	if (!all.length) return null;

	const excluded = new Set(recent);
	const fresh = all.filter((t) => !excluded.has(t.id));
	const from = fresh.length ? fresh : all;

	const rand = rngFrom(`${seed}::track::${pool}`);
	return from[Math.floor(rand() * from.length)];
}

/** Updates the recently played list, most recent first, bounded. */
export function pushRecent(recent, id) {
	if (!id) return recent.slice(0, RECENT_LIMIT);
	return [id, ...recent.filter((x) => x !== id)].slice(0, RECENT_LIMIT);
}

// --- manifest -----------------------------------------------------------------

const REQUIRED = ['id', 'pool', 'file', 'durS', 'bpm'];

// What to call a value in a problem message. Primitives keep their text; a
// value that has none is named by its kind rather than crashing the validator.
const named = (v) => asText(v, nameOf(v));

/**
 * Validates public/music.json. Returns the list of problems; empty = valid.
 * Called by the selftest and by music-review before writing: a broken manifest
 * would leave the game silent without saying anything.
 *
 * Every value named back in a problem message goes through asText(): this file
 * is hand-edited and fetched over HTTP, and `{"pool": {"toString": null}}` is
 * valid JSON that a template literal THROWS on -- which turned a validator that
 * returns its problems into one that raises an engine TypeError instead
 * (fuzzing finding 3, tools/lib/as-text.mjs).
 */
export function validateManifest(json) {
	const problems = [];
	if (!json || typeof json !== 'object') return ['manifest missing or not an object'];
	if (json.schemaVersion !== MUSIC_SCHEMA_VERSION) {
		problems.push(`schemaVersion: expected ${MUSIC_SCHEMA_VERSION}, got ${named(json.schemaVersion)}`);
	}
	if (!Array.isArray(json.tracks)) return [...problems, 'tracks is not an array'];

	const ids = new Set();
	const files = new Set();
	for (const [i, t] of json.tracks.entries()) {
		const where = `tracks[${i}]`;
		for (const key of REQUIRED) {
			if (t?.[key] === undefined || t[key] === null) problems.push(`${where}: ${key} missing`);
		}
		if (t?.pool !== undefined && !POOL_SET.has(t.pool)) problems.push(`${where}: unknown pool "${named(t.pool)}"`);
		if (typeof t?.durS === 'number' && !(t.durS > 0)) problems.push(`${where}: durS must be > 0`);
		if (t?.id !== undefined) {
			if (ids.has(t.id)) problems.push(`${where}: duplicate id "${named(t.id)}"`);
			ids.add(t.id);
		}
		if (t?.file !== undefined) {
			if (files.has(t.file)) problems.push(`${where}: duplicate file "${named(t.file)}"`);
			files.add(t.file);
		}
	}
	return problems;
}

/** A drone's pool. The family IS the pool: no lookup table. */
export function poolForFamily(family) {
	return POOL_SET.has(family) && family !== 'menu' ? family : null;
}
