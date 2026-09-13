// node tools/music-selftest.mjs
//
// Covers the PURE model of the musical arc: selection, intensity, prompts,
// manifest, looping. Nothing here touches Web Audio, the DOM or the GPU -- what
// is listened to is checked by ear, not here.

import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	MUSIC_SCHEMA_VERSION, MUSIC_POOLS, INTENSITY, PHASE_INTENSITY, FADE, DUCK, FLIGHT,
	intensityParams, flightIntensity, pickTrack, pushRecent, validateManifest,
	poolForFamily, RECENT_LIMIT, INTENSITY_TAU,
} from './music-model.mjs';
import {
	POOLS, AXES, AXIS_NAMES, AXES_PER_TRACK, buildPrompt, negativesFor,
	NEGATIVES_COMMON, NO_VOICE, WORDLESS_VOICE, POOL_VOICE, POOL_AXIS_BANS,
} from './music-prompts.mjs';
import { planFor, trackId, DEFAULTS, suggestSeedBase } from './music-gen.mjs';
import { partition } from './music-retire.mjs';
import { loopFilter, loudnormMeasureFilter, loudnormApplyFilter, TARGET_LUFS, TARGET_PEAK_DBFS, TARGET_LRA, CROSSFADE_S } from './music-loop.mjs';
import { judge, BOUNDS } from './music-gate.mjs';
import { FAMILIES } from '../src/drone-profiles.js';

const SIM = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
function test(name, fn) {
	try { fn(); passed++; }
	catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// --- pools and families -----------------------------------------------------

test('every drone family has its pool, and the two pools outside FAMILIES are known', () => {
	for (const f of FAMILIES) {
		assert.ok(MUSIC_POOLS.includes(f), `family ${f} has no music pool`);
		assert.equal(poolForFamily(f), f);
	}
	// Two pools are not in FAMILIES, for opposite reasons: `menu` is not a drone
	// at all, and `swarmNode` is one that IS flown but that FAMILIES excludes on
	// purpose (never an ordinary scan candidate, never an ambient one --
	// src/drone-profiles.js). The order follows MUSIC_POOLS.
	assert.deepEqual(MUSIC_POOLS.filter((p) => !FAMILIES.includes(p)), ['menu', 'swarmNode']);
	// And that one, unlike `menu`, MUST return a pool.
	assert.equal(poolForFamily('swarmNode'), 'swarmNode');
});

test('menu is not a drone pool', () => {
	assert.equal(poolForFamily('menu'), null);
	assert.equal(poolForFamily('unknown'), null);
});

test('every pool has a core, a BPM range and a feel', () => {
	for (const p of MUSIC_POOLS) {
		const spec = POOLS[p];
		assert.ok(spec, `pool ${p} has no spec`);
		assert.ok(spec.core.length > 40, `${p}: core too short`);
		assert.ok(spec.feel.length > 5, `${p}: feel missing`);
		assert.ok(spec.bpm[0] < spec.bpm[1], `${p}: empty BPM range`);
	}
});

// --- prompts ----------------------------------------------------------------

test('buildPrompt is deterministic', () => {
	const a = buildPrompt('race5', 'seed-a');
	const b = buildPrompt('race5', 'seed-a');
	assert.deepEqual(a, b);
});

test('two seeds give different prompts', () => {
	const seen = new Set();
	for (let i = 0; i < 30; i++) seen.add(buildPrompt('race5', `s${i}`).prompt);
	assert.ok(seen.size > 15, `too little variety: ${seen.size}/30`);
});

test('the BPM stays inside the family range', () => {
	for (const p of MUSIC_POOLS) {
		const [lo, hi] = POOLS[p].bpm;
		for (let i = 0; i < 40; i++) {
			const { bpm } = buildPrompt(p, `s${i}`);
			assert.ok(bpm >= lo && bpm <= hi, `${p}: ${bpm} outside [${lo},${hi}]`);
		}
	}
});

test('every prompt carries the genre fence and its BPM', () => {
	for (const p of MUSIC_POOLS) {
		const { prompt, bpm } = buildPrompt(p, 'x');
		assert.ok(prompt.includes(negativesFor(p)), `${p}: negatives missing`);
		assert.ok(prompt.includes(NEGATIVES_COMMON), `${p}: anti-target missing`);
		assert.ok(prompt.includes(`${bpm} BPM`), `${p}: BPM missing from the prompt`);
	}
});

test('HEAVY is the ONLY pool to carry voices, and only wordless ones', () => {
	assert.deepEqual(Object.keys(POOL_VOICE), ['heavy5'],
		'the voice is HEAVY\'s signature, not a shared colour');
	for (const p of MUSIC_POOLS) {
		const { prompt } = buildPrompt(p, 'x');
		if (p === 'heavy5') {
			assert.ok(prompt.includes(WORDLESS_VOICE), 'heavy5: voice fence missing');
			assert.ok(!prompt.includes(NO_VOICE), 'heavy5: forbids the voices it asks for');
		} else {
			assert.ok(prompt.includes(NO_VOICE), `${p}: should be strictly instrumental`);
		}
	}
});

test('even with voices, no prompt can become a song', () => {
	// What Bible section 37 really targets: the narrator, the hacker voice, the
	// spoken word. A choir treated as an instrument is not that -- lyrics are.
	for (const p of MUSIC_POOLS) {
		const { prompt } = buildPrompt(p, 'x');
		for (const forbidden of ['no lyrics', 'no spoken word']) {
			const covered = prompt.includes(forbidden) || prompt.includes(NO_VOICE);
			assert.ok(covered, `${p}: nothing forbids "${forbidden.slice(3)}"`);
		}
	}
});

test('no prompt contradicts itself', () => {
	// The defect that motivated POOL_AXIS_BANS: a core at "punk intensity" was
	// given "restrained and patient", and the model settled it on its own -- in
	// favour of the softer one. A prompt that contradicts itself is a prompt that
	// no longer asks for anything.
	for (const pool of MUSIC_POOLS) {
		const bans = POOL_AXIS_BANS[pool] ?? {};
		for (let i = 0; i < 300; i++) {
			const { axes, prompt } = buildPrompt(pool, `s${i}`);
			for (const [axis, values] of Object.entries(bans)) {
				assert.ok(!values.includes(axes[axis]),
					`${pool}: "${axes[axis]}" contradicts its core`);
				for (const v of values) {
					assert.ok(!prompt.includes(v), `${pool}: "${v}" leaked into the prompt`);
				}
			}
		}
	}
});

test('the hardware grain survives a ban', () => {
	// Grain is the only axis always present: it is what holds the "played on
	// hardware" anchor, hence the DNA. Banning it must not remove it.
	for (const pool of MUSIC_POOLS) {
		for (let i = 0; i < 50; i++) {
			const { axes } = buildPrompt(pool, `g${i}`);
			assert.ok(axes.grain, `${pool}: track with no hardware anchor`);
			assert.ok(AXES.grain.includes(axes.grain), `${pool}: grain outside the vocabulary`);
			assert.ok(!(POOL_AXIS_BANS[pool]?.grain ?? []).includes(axes.grain),
				`${pool}: a banned grain was kept`);
		}
	}
});

test('only what exists in the axis vocabulary can be banned', () => {
	// A typo in POOL_AXIS_BANS would be a silent ban: the contradictory value
	// would keep coming out with nothing to say so.
	for (const [pool, bans] of Object.entries(POOL_AXIS_BANS)) {
		assert.ok(MUSIC_POOLS.includes(pool), `ban for an unknown pool: ${pool}`);
		for (const [axis, values] of Object.entries(bans)) {
			assert.ok(AXES[axis], `${pool}: unknown axis "${axis}"`);
			for (const v of values) {
				assert.ok(AXES[axis].includes(v), `${pool}.${axis}: "${v}" is not a value of that axis`);
			}
		}
	}
});

test('no prompt contains a term outside the DNA', () => {
	// The prompt SAYS "no modern EDM drop"; what is forbidden here is asking for
	// it in the positive.
	const banned = ['orchestral', 'cinematic score', 'dubstep', 'future bass', 'hip hop', 'rock band'];
	for (const p of MUSIC_POOLS) {
		for (let i = 0; i < 20; i++) {
			const { prompt } = buildPrompt(p, `s${i}`);
			const head = prompt.slice(0, prompt.indexOf(negativesFor(p)));
			for (const b of banned) assert.ok(!head.includes(b), `${p}: "${b}" in the prompt`);
		}
	}
});

test('a track receives AXES_PER_TRACK axes plus the grain', () => {
	const { axes } = buildPrompt('cinewhoop', 'x');
	assert.equal(Object.keys(axes).length, AXES_PER_TRACK + 1);
	assert.ok(axes.grain, 'the grain is always drawn');
	assert.ok(AXES.grain.includes(axes.grain));
});

test('every axis offers a neutral option except the grain', () => {
	for (const name of AXIS_NAMES) {
		if (name === 'grain') { assert.ok(!AXES[name].includes(null)); continue; }
		assert.ok(AXES[name].includes(null), `${name}: no neutral option`);
	}
});

// Words too common to say anything about a musical identity.
const STOP = new Set(('and the of a an with in to that at more than into over under '
	+ 'early late 2000s 1990s music musical sound like its it is are be').split(' '));

const contentWords = (core) => new Set(core.toLowerCase()
	.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
	.filter((w) => w.length > 3 && !STOP.has(w)));

// Threshold set on the measurement, not by eye. The closest pair after the v2
// rewrite is race5 vs toothpick at 0.149 -- and those two are, by ear, the most
// recognisable in the library: their shared words ("energetic", "percussion",
// "underground") are generic, not identifying. 0.16 therefore lets through what
// works and catches the regression: before v2, race5 vs heavy5 sat at 0.190
// sharing "mechanical percussion kick distorted bass", and heavy5 sounded like a
// failed race5.
const MAX_CORE_OVERLAP = 0.16;

test('two pools do not tread on each other', () => {
	// Careful about what this test proves: lexical overlap is a smell detector,
	// not a verdict. Two disjoint prompts can render twin tracks, and only the ear
	// settles that (music-review). What it does catch is the case where the same
	// family was WRITTEN twice -- which happened.
	const pools = Object.keys(POOLS);
	for (let i = 0; i < pools.length; i++) {
		for (let j = i + 1; j < pools.length; j++) {
			const a = contentWords(POOLS[pools[i]].core);
			const b = contentWords(POOLS[pools[j]].core);
			const shared = [...a].filter((w) => b.has(w));
			const overlap = shared.length / new Set([...a, ...b]).size;
			assert.ok(overlap <= MAX_CORE_OVERLAP,
				`${pools[i]} vs ${pools[j]}: ${overlap.toFixed(3)} overlap [${shared.join(' ')}]`);
		}
	}
});

test('no core hedges on three adjectives at once', () => {
	// The v1 of cinewhoop said "subtle", "gentle" and "restrained" in the same
	// sentence: nothing committed, and it was the pool that convinced least on
	// first listen. One hedge is fine (MICRO's "slightly strange" is a twist, not
	// a retreat); three is a prompt that dares ask for nothing.
	const hedges = ['subtle', 'gentle', 'restrained', 'slightly', 'somewhat', 'mild', 'soft'];
	for (const p of Object.keys(POOLS)) {
		const core = POOLS[p].core.toLowerCase();
		const found = hedges.filter((h) => core.includes(h));
		assert.ok(found.length < 3, `${p}: ${found.length} hedging adjectives [${found.join(' ')}]`);
	}
});

test('an unknown pool fails outright', () => {
	assert.throws(() => buildPrompt('nope', 'x'), /pool inconnu/);
});

// --- intensity ----------------------------------------------------------------

test('intensityParams is bounded at both ends', () => {
	assert.equal(intensityParams(0).cutoffHz, INTENSITY.cutoffHz[0]);
	assert.equal(intensityParams(1).cutoffHz, INTENSITY.cutoffHz[1]);
	assert.equal(intensityParams(1).gain, 1);
	assert.ok(Math.abs(intensityParams(0).gain - Math.pow(10, INTENSITY.gainDb[0] / 20)) < 1e-9);
});

test('intensityParams saturates outside [0,1] instead of diverging', () => {
	assert.deepEqual(intensityParams(-5), intensityParams(0));
	assert.deepEqual(intensityParams(9), intensityParams(1));
});

test('intensityParams never returns NaN', () => {
	for (const bad of [NaN, undefined, null, 'x', Infinity]) {
		const { cutoffHz, gain } = intensityParams(bad);
		assert.ok(Number.isFinite(cutoffHz) && Number.isFinite(gain), `NaN on ${bad}`);
	}
});

test('intensityParams is strictly increasing', () => {
	let prevC = -1; let prevG = -1;
	for (let k = 0; k <= 1.0001; k += 0.05) {
		const { cutoffHz, gain } = intensityParams(k);
		assert.ok(cutoffHz > prevC, `cutoff not increasing at k=${k}`);
		assert.ok(gain > prevG, `gain not increasing at k=${k}`);
		prevC = cutoffHz; prevG = gain;
	}
});

test('HACK really is "the next room" and DROP is full', () => {
	assert.ok(PHASE_INTENSITY.HACK < PHASE_INTENSITY.MENU, 'the hack must be more muffled than the menu');
	assert.ok(PHASE_INTENSITY.MENU < PHASE_INTENSITY.DROP);
	assert.equal(PHASE_INTENSITY.DROP, 1);
	// At the hack's intensity the cutoff must stay low: otherwise you do not hear
	// distant music, you hear quieter music. Raised to 1.2 kHz along with HACK
	// (field feedback: the hack was inaudible) -- the bound rises with it, but
	// stays far from the ~19 kHz of full volume.
	assert.ok(intensityParams(PHASE_INTENSITY.HACK).cutoffHz < 1200);
});

test('the flight floor leaves the music REALLY present', () => {
	assert.ok(PHASE_INTENSITY.FLOOR > PHASE_INTENSITY.HACK);
	// The floor is not a comfort value: it is the guarantee that a normal
	// piloting gesture does not make the music disappear. At 0.30 it dropped to
	// -14 dB behind a 1.2 kHz cutoff, which was heard as a shutdown.
	const p = intensityParams(PHASE_INTENSITY.FLOOR);
	assert.ok(20 * Math.log10(p.gain) > -9, `floor at ${(20 * Math.log10(p.gain)).toFixed(1)} dB, too low`);
	assert.ok(p.cutoffHz > 3000, `floor at ${Math.round(p.cutoffHz)} Hz, too muffled`);
	// But there is still an arc: full must stay clearly above.
	assert.ok(PHASE_INTENSITY.FLOOR < 0.8, 'a floor set too high cancels the arc');
});

test('cutting the throttle does not cut the music', () => {
	// In FPV the throttle is cut constantly -- punch, chop, dive, coast. It is the
	// most common gesture in piloting, and it must not duck the music.
	for (const speedMs of [5, 15, 25]) {
		const full = flightIntensity({ throttle: 1, speedMs });
		const cut = flightIntensity({ throttle: 0, speedMs });
		const dbFull = 20 * Math.log10(intensityParams(full).gain);
		const dbCut = 20 * Math.log10(intensityParams(cut).gain);
		assert.ok(dbFull - dbCut < 2.5,
			`at ${speedMs} m/s, cutting the throttle removes ${(dbFull - dbCut).toFixed(1)} dB`);
	}
});

test('speed weighs clearly more than the stick', () => {
	// The stick is twitchy, speed has inertia. A ratio that is too balanced makes
	// the music sensitive to a gesture that changes nothing about what the pilot
	// feels.
	assert.ok(FLIGHT.wSpeed >= 3 * FLIGHT.wThrottle,
		`ratio ${(FLIGHT.wSpeed / FLIGHT.wThrottle).toFixed(1)}, the stick weighs too much`);
});

test('the smoothing is asymmetric: rise fast, fall slowly', () => {
	// The real remedy to throttle chops. A chop lasts half a second, a lull lasts
	// ten; with a single constant the two look alike.
	assert.ok(INTENSITY_TAU.fall > 4 * INTENSITY_TAU.rise,
		`fall ${INTENSITY_TAU.fall} s against rise ${INTENSITY_TAU.rise} s: not asymmetric enough`);
	// A half-second chop must only travel a fraction of the way.
	const travelled = 1 - Math.exp(-0.5 / INTENSITY_TAU.fall);
	assert.ok(travelled < 0.35, `a 0.5 s chop travels ${(travelled * 100).toFixed(0)} % of the fall`);
	// But a rush must be heard straight away.
	assert.ok(1 - Math.exp(-0.5 / INTENSITY_TAU.rise) > 0.8, 'the rise is too slow for a rush');
});

test('flightIntensity reste dans [FLOOR, 1]', () => {
	const cases = [
		{}, { throttle: 0, speedMs: 0 }, { throttle: 1, speedMs: 1000 },
		{ throttle: -3, speedMs: -12 }, { throttle: NaN, speedMs: NaN },
		{ throttle: Infinity, speedMs: Infinity }, { throttle: null, speedMs: undefined },
	];
	for (const c of cases) {
		const k = flightIntensity(c);
		assert.ok(Number.isFinite(k), `NaN sur ${JSON.stringify(c)}`);
		assert.ok(k >= PHASE_INTENSITY.FLOOR - 1e-9 && k <= 1 + 1e-9, `${k} out of bounds on ${JSON.stringify(c)}`);
	}
});

test('disarmed, the music waits at the floor', () => {
	assert.equal(flightIntensity({ throttle: 1, speedMs: 40, armed: false }), PHASE_INTENSITY.FLOOR);
});

test('a rush is more intense than a hover', () => {
	const hover = flightIntensity({ throttle: 0.45, speedMs: 0.5 });
	const rush = flightIntensity({ throttle: 0.95, speedMs: 28 });
	// The range is narrower now that the floor is high, but the arc must stay
	// clear: at least 4 dB between a hover and a rush.
	const dbHover = 20 * Math.log10(intensityParams(hover).gain);
	const dbRush = 20 * Math.log10(intensityParams(rush).gain);
	assert.ok(dbRush - dbHover > 4, `arc too flat: ${(dbRush - dbHover).toFixed(1)} dB`);
});

test('speed weighs more than the stick', () => {
	// It is what the player UNDERGOES that carries the intensity, not what they
	// do: full throttle into a wall must not sound like a rush.
	assert.ok(FLIGHT.wSpeed > FLIGHT.wThrottle);
	assert.ok(Math.abs(FLIGHT.wSpeed + FLIGHT.wThrottle - 1) < 1e-9, 'the weights must sum to 1');
});

test('the ritual ducks the music without silencing it', () => {
	assert.ok(DUCK.ritual > 0 && DUCK.ritual < 1);
	assert.ok(DUCK.ms > 0);
});

test('the transition durations are ordered like the staging', () => {
	// The crash cuts dead, the entrance is a gesture.
	assert.ok(FADE.kill < FADE.drop, 'the crash must cut shorter than the drop');
	assert.ok(FADE.drop < FADE.menuToHack);
});

// --- selection ----------------------------------------------------------------

const fakeManifest = {
	schemaVersion: MUSIC_SCHEMA_VERSION,
	tracks: ['a', 'b', 'c', 'd'].map((s) => ({
		id: `race5-${s}`, pool: 'race5', file: `music/race5/race5-${s}.opus`, durS: 87, bpm: 148,
	})).concat([{ id: 'menu-a', pool: 'menu', file: 'music/menu/menu-a.opus', durS: 90, bpm: 90 }]),
};

test('pickTrack is deterministic on the same seed', () => {
	const a = pickTrack(fakeManifest, 'race5', 'seed::0');
	const b = pickTrack(fakeManifest, 'race5', 'seed::0');
	assert.equal(a.id, b.id);
});

test('pickTrack never leaves the requested pool', () => {
	for (let i = 0; i < 50; i++) {
		assert.equal(pickTrack(fakeManifest, 'race5', `s${i}`).pool, 'race5');
	}
});

test('pickTrack sets recent tracks aside', () => {
	const recent = ['race5-a', 'race5-b', 'race5-c'];
	for (let i = 0; i < 50; i++) {
		assert.equal(pickTrack(fakeManifest, 'race5', `s${i}`, recent).id, 'race5-d');
	}
});

test('an entirely recent pool replays rather than returning silence', () => {
	const all = fakeManifest.tracks.filter((t) => t.pool === 'race5').map((t) => t.id);
	const t = pickTrack(fakeManifest, 'race5', 'x', all);
	assert.ok(t && all.includes(t.id));
});

test('an empty pool returns null, not an exception', () => {
	assert.equal(pickTrack(fakeManifest, 'cinewhoop', 'x'), null);
	assert.equal(pickTrack({ tracks: [] }, 'race5', 'x'), null);
	assert.equal(pickTrack(null, 'race5', 'x'), null);
	assert.equal(pickTrack(undefined, 'race5', 'x'), null);
});

test('pushRecent puts first, deduplicates and bounds', () => {
	let r = [];
	for (let i = 0; i < RECENT_LIMIT + 8; i++) r = pushRecent(r, `t${i}`);
	assert.equal(r.length, RECENT_LIMIT);
	assert.equal(r[0], `t${RECENT_LIMIT + 7}`);
	const again = pushRecent(r, r[3]);
	assert.equal(again[0], r[3]);
	assert.equal(new Set(again).size, again.length, 'duplicate among the recent ones');
});

test('pushRecent copes with a missing id', () => {
	assert.deepEqual(pushRecent(['a'], null), ['a']);
});

// --- manifest -----------------------------------------------------------------

test('the fake manifest is valid', () => {
	assert.deepEqual(validateManifest(fakeManifest), []);
});

test('validateManifest refuses what would silently mute the game', () => {
	const bad = (m) => validateManifest(m).length > 0;
	assert.ok(bad(null));
	assert.ok(bad({ schemaVersion: 99, tracks: [] }));
	assert.ok(bad({ schemaVersion: MUSIC_SCHEMA_VERSION, tracks: 'nope' }));
	assert.ok(bad({ schemaVersion: MUSIC_SCHEMA_VERSION, tracks: [{ id: 'x', pool: 'race5', file: 'f', bpm: 1 }] }), 'durS missing');
	assert.ok(bad({ schemaVersion: MUSIC_SCHEMA_VERSION, tracks: [{ id: 'x', pool: 'nope', file: 'f', durS: 1, bpm: 1 }] }), 'unknown pool');
	assert.ok(bad({ schemaVersion: MUSIC_SCHEMA_VERSION, tracks: [{ id: 'x', pool: 'race5', file: 'f', durS: 0, bpm: 1 }] }), 'zero duration');
});

test('validateManifest catches duplicate ids and files', () => {
	const dup = (tracks) => validateManifest({ schemaVersion: MUSIC_SCHEMA_VERSION, tracks });
	const t = { pool: 'race5', durS: 1, bpm: 1 };
	assert.ok(dup([{ ...t, id: 'a', file: 'f1' }, { ...t, id: 'a', file: 'f2' }]).some((p) => /duplicate id/.test(p)));
	assert.ok(dup([{ ...t, id: 'a', file: 'f' }, { ...t, id: 'b', file: 'f' }]).some((p) => /duplicate file/.test(p)));
});

test('the shipped manifest, if it exists, is valid and points at files that are there', () => {
	const p = join(SIM, 'public/music.json');
	if (!existsSync(p)) return; // before the first wave there is nothing to validate
	const m = JSON.parse(readFileSync(p, 'utf8'));
	assert.deepEqual(validateManifest(m), []);
	for (const t of m.tracks) {
		assert.ok(existsSync(join(SIM, 'public', t.file)), `file missing: ${t.file}`);
	}
});

// --- pipeline ---------------------------------------------------------------

test('trackId is stable and separates neighbours well', () => {
	assert.equal(trackId('race5', 'v1', 0), trackId('race5', 'v1', 0));
	const ids = [];
	for (let i = 0; i < 200; i++) ids.push(trackId('race5', 'v1', i));
	assert.equal(new Set(ids).size, 200, 'id collision');
	// The point of the avalanche: two consecutive indices must not give two ids
	// that look alike, or the listening review picks the wrong line.
	assert.notEqual(ids[0].slice(-8, -4), ids[1].slice(-8, -4));
});

test('planFor produces a complete, reproducible plan', () => {
	const a = planFor({ pool: 'heavy5', count: 4, seedBase: 'v1', duration: 90 });
	const b = planFor({ pool: 'heavy5', count: 4, seedBase: 'v1', duration: 90 });
	assert.deepEqual(a.map((j) => j.id), b.map((j) => j.id));
	assert.equal(a.length, 4);
	for (const j of a) {
		assert.equal(j.pool, 'heavy5');
		assert.equal(j.durationS, 90);
		assert.ok(Number.isInteger(j.modelSeed) && j.modelSeed >= 0, 'the model seed must be a positive integer');
		assert.ok(j.prompt.includes(negativesFor(j.pool)));
		assert.ok(j.out.endsWith(`${j.id}.wav`));
	}
});

test('loopFilter cuts head/body/tail and rejoins both seams', () => {
	const f = loopFilter({ startS: 0, endS: 90, crossfadeS: 3 });
	assert.ok(f.includes('atrim=0:3'), 'head');
	assert.ok(f.includes('atrim=87:90'), 'tail');
	assert.ok(f.includes('atrim=3:87'), 'body');
	assert.ok(f.includes('[tail][head]acrossfade=d=3'), 'the tail fades INTO the head, not the other way round');
	assert.ok(f.indexOf('[joint][body]concat') > f.indexOf('acrossfade'), 'the seam comes before the body');
});

test('loopFilter accounts for the trimmed head silence', () => {
	const f = loopFilter({ startS: 1.2, endS: 88, crossfadeS: 3 });
	assert.ok(f.includes('atrim=1.2:4.2'));
	assert.ok(f.includes('atrim=85:88'));
});

test('loopFilter refuses a segment too short for its crossfade', () => {
	assert.throws(() => loopFilter({ startS: 0, endS: 6, crossfadeS: 3 }), /trop court/);
});

test('the first pass really asks for a measurement', () => {
	const f = loudnormMeasureFilter();
	assert.ok(f.startsWith('loudnorm='));
	assert.ok(f.includes(`I=${TARGET_LUFS}`));
	assert.ok(f.includes(`TP=${TARGET_PEAK_DBFS}`));
	assert.ok(f.includes('print_format=json'), 'without JSON the second pass has nothing to read');
	assert.ok(!f.includes('measured_'), 'the first pass knows nothing yet');
});

const measured = {
	input_i: '-15.80', input_tp: '0.30', input_lra: '9.10',
	input_thresh: '-26.10', target_offset: '-0.40',
};

test('the second pass reports EVERY measurement and stays linear', () => {
	const f = loudnormApplyFilter(measured);
	for (const [key, value] of [
		['measured_I', measured.input_i], ['measured_TP', measured.input_tp],
		['measured_LRA', measured.input_lra], ['measured_thresh', measured.input_thresh],
		['offset', measured.target_offset],
	]) {
		assert.ok(f.includes(`${key}=${value}`), `${key} missing from the second pass`);
	}
	// Without linear=true, loudnorm compresses the dynamics instead of settling
	// for a static gain when a static gain is enough.
	assert.ok(f.includes('linear=true'));
	assert.ok(f.includes(`I=${TARGET_LUFS}`) && f.includes(`TP=${TARGET_PEAK_DBFS}`) && f.includes(`LRA=${TARGET_LRA}`));
});

test('an incomplete measurement fails instead of normalising in one pass', () => {
	// The silent trap: loudnorm accepts a filter with no measured_*, and then
	// returns a one-pass normalisation -- hence a library that sprawls.
	for (const missing of Object.keys(measured)) {
		const partial = { ...measured };
		delete partial[missing];
		assert.throws(() => loudnormApplyFilter(partial), /mesure loudnorm incompl\u00e8te/, `${missing} missing, not detected`);
	}
	assert.throws(() => loudnormApplyFilter(null), /incompl\u00e8te/);
	assert.throws(() => loudnormApplyFilter({ ...measured, input_tp: 'nan' }), /incompl\u00e8te/);
});

test('the peak target leaves headroom under 0 dBFS', () => {
	assert.ok(TARGET_PEAK_DBFS < 0, 'Opus can overshoot on decoding');
	assert.ok(TARGET_LRA > 0);
});

test('the loop crossfade is audible but short', () => {
	assert.ok(CROSSFADE_S >= 1 && CROSSFADE_S <= 6);
});

test('the gate catches an EMPTY track, not only a flat one', () => {
	// The hole that let through three menu draws described as "there is not even
	// any music". The RMS spread is not enough: a very dynamic track also has a
	// large spread. What distinguishes emptiness is the PROPORTION of the track
	// spent below the median.
	const t = { durationS: 90, lufs: -14, truePeak: 0, headSilenceS: 0, tailSilenceS: 1, rmsSpreadDb: 20, sideDb: -14 };
	// Real measurements of the three failed draws.
	for (const silentFraction of [0.15, 0.36]) {
		assert.ok(judge({ ...t, silentFraction }, 90).reasons.some((r) => /vide/.test(r)),
			`${silentFraction * 100} % emptiness not detected`);
	}
	// And the worst track ACCEPTED by ear must keep passing.
	assert.deepEqual(judge({ ...t, silentFraction: 0.06 }, 90).reasons, [],
		'6 % emptiness is the measurement of cinewhoop-1fbea112, validated by ear');
});

test('menu can no longer receive an axis that empties it', () => {
	// The pool's core already says "sparse minimal percussion, patient and
	// watchful". An axis that adds emptiness on top gives a prompt that asks for
	// nothing. "relentless and driving" had been banned -- the wrong direction:
	// the three menu tracks that work are the DENSEST.
	const bans = POOL_AXIS_BANS.menu;
	assert.ok(bans.energy.includes('restrained and patient'), 'menu can still be emptied');
	assert.ok(bans.density.includes('sparse arrangement, lots of space'));
	for (let i = 0; i < 300; i++) {
		const { axes } = buildPrompt('menu', `s${i}`);
		assert.notEqual(axes.energy, 'restrained and patient');
		assert.notEqual(axes.density, 'sparse arrangement, lots of space');
	}
});

test('judge accepts a sound track and names every defect', () => {
	const sane = { durationS: 90, lufs: -13, truePeak: -1.2, headSilenceS: 0.1, tailSilenceS: 1.0, rmsSpreadDb: 6, silentFraction: 0, sideDb: -14 };
	assert.deepEqual(judge(sane, 90).reasons, []);
	assert.ok(judge({ ...sane, durationS: 40 }, 90).reasons.some((r) => /dur\u00e9e/.test(r)));
	assert.ok(judge({ ...sane, headSilenceS: 9 }, 90).reasons.some((r) => /t\u00eate/.test(r)));
	assert.ok(judge({ ...sane, tailSilenceS: 30 }, 90).reasons.some((r) => /queue/.test(r)));
	assert.ok(judge({ ...sane, lufs: -40 }, 90).reasons.some((r) => /LUFS/.test(r)));
	assert.ok(judge({ ...sane, lufs: NaN }, 90).reasons.some((r) => /non mesur\u00e9/.test(r)));
	assert.ok(judge({ ...sane, rmsSpreadDb: 0.1 }, 90).reasons.some((r) => /nappe/.test(r)));
	assert.ok(judge({ ...sane, sideDb: -70 }, 90).reasons.some((r) => /mono/.test(r)));
	assert.ok(judge({ ...sane, truePeak: 20 }, 90).reasons.some((r) => /cass\u00e9/.test(r)));
});

test('the gate does NOT reject a normal inter-sample peak', () => {
	// 19 of the 21 tracks in the calibration batch go past 0 dBFS. That is the
	// normal behaviour of a loud master, and music-loop.mjs corrects it with a
	// static gain. Rejecting on that would empty the library.
	const sane = { durationS: 90, lufs: -13, headSilenceS: 0, tailSilenceS: 1, rmsSpreadDb: 6, silentFraction: 0, sideDb: -14 };
	for (const truePeak of [0.1, 0.6, 1.4, 2.9]) {
		assert.deepEqual(judge({ ...sane, truePeak }, 90).reasons, [], `peak ${truePeak} rejected wrongly`);
	}
});

test('the gate lets deliberately even genres live', () => {
	// Dub techno (LONG RANGE) and the menu ambience are hypnotic by construction:
	// an RMS-spread threshold set too high would reject exactly the pools whose
	// identity that is. Real measurements from the batch: 1.29 and 1.75 dB.
	const even = { durationS: 90, lufs: -14, truePeak: 1.1, headSilenceS: 0, tailSilenceS: 1, silentFraction: 0, sideDb: -18 };
	for (const rmsSpreadDb of [1.29, 1.75, 3.3]) {
		assert.deepEqual(judge({ ...even, rmsSpreadDb }, 90).reasons, [], `spread ${rmsSpreadDb} dB rejected wrongly`);
	}
	// But disguised silence is still caught.
	assert.ok(judge({ ...even, rmsSpreadDb: 0.2 }, 90).reasons.some((r) => /nappe/.test(r)));
});

test('the model\'s normal tail fade passes, a dead tail does not', () => {
	const t = { durationS: 90, lufs: -13, truePeak: 0.5, headSilenceS: 0, rmsSpreadDb: 6, silentFraction: 0, sideDb: -14 };
	for (const tailSilenceS of [0, 1.12, 2.95, 4.42]) {
		assert.deepEqual(judge({ ...t, tailSilenceS }, 90).reasons, [], `tail ${tailSilenceS} s rejected wrongly`);
	}
	assert.ok(judge({ ...t, tailSilenceS: 30 }, 90).reasons.some((r) => /queue/.test(r)));
});

test('the gate bounds are ordered and plausible', () => {
	assert.ok(BOUNDS.lufs[0] < BOUNDS.lufs[1]);
	assert.ok(BOUNDS.lufs[0] < TARGET_LUFS && TARGET_LUFS < BOUNDS.lufs[1],
		'the normalisation target must fall inside the accepted range');
	assert.ok(BOUNDS.headSilenceS < BOUNDS.tailSilenceS,
		'more silence is tolerated at the tail: music-loop trims it back');
	assert.ok(BOUNDS.minSideDb < 0);
	assert.ok(BOUNDS.maxSilentFraction > 0.06 && BOUNDS.maxSilentFraction < 0.15,
		'the emptiness threshold must pass the worst accepted track (6 %) and catch the failures (15 %)');
});

test('generation stays at the model\'s operating point', () => {
	// Counter-intuitive, hence protected: raising the step count DEGRADES this
	// model. Stable Audio 3 is built for fast inference and 8 steps is its
	// nominal regime, not a shortcut. At 50 steps the output drops from 3.6 to
	// 8.7 dB and goes out of style -- checked by ear on the `menu` pool.
	assert.equal(DEFAULTS.steps, 8, 'the model leaves its regime past that');
	// And the CFG stays low: at 7 the render already comes out compressed (-5.3 LUFS, LRA 4.4).
	assert.ok(DEFAULTS.cfgScale <= 2, `cfg ${DEFAULTS.cfgScale}: the render will be crushed`);
});

test('suggestSeedBase follows the series and never collides', () => {
	// The easiest trap in the pipeline: reusing a seed does not produce other
	// tracks, it returns EXACTLY the same ones, which the worker then skips as
	// already generated. You believe the library grew and nothing happened --
	// silently.
	assert.equal(suggestSeedBase(new Set()), 'v1');
	assert.equal(suggestSeedBase(new Set(['v5'])), 'v6');
	assert.equal(suggestSeedBase(new Set(['cal1', 'v2', 'v3', 'v5'])), 'v6');
	// A seed outside the series must not block the suggestion.
	assert.equal(suggestSeedBase(new Set(['cal1'])), 'v1');
	// And the suggestion must never already be taken.
	for (const used of [new Set(['v1']), new Set(['v1', 'v2', 'v3']), new Set(['v9', 'cal1'])]) {
		assert.ok(!used.has(suggestSeedBase(used)), 'the suggestion collides');
	}
});

// --- removal ------------------------------------------------------------------

const lib = [
	{ id: 'race5-a', pool: 'race5', file: 'music/race5/a.opus', durS: 80, bpm: 148, seed: 'cal1::0' },
	{ id: 'race5-b', pool: 'race5', file: 'music/race5/b.opus', durS: 80, bpm: 148, seed: 's50::0' },
	{ id: 'menu-a', pool: 'menu', file: 'music/menu/a.opus', durS: 80, bpm: 90, seed: 'cal1::0' },
	{ id: 'menu-b', pool: 'menu', file: 'music/menu/b.opus', durS: 80, bpm: 90, seed: 's50::0' },
];

test('partition splits by seed and by id', () => {
	const bySeed = partition(lib, { before: 's50' });
	assert.deepEqual(bySeed.drop.map((t) => t.id), ['race5-a', 'menu-a']);
	assert.deepEqual(bySeed.keep.map((t) => t.id), ['race5-b', 'menu-b']);

	const byId = partition(lib, { ids: ['menu-b'] });
	assert.deepEqual(byId.drop.map((t) => t.id), ['menu-b']);
	assert.equal(byId.keep.length, 3);
});

test('partition removes nothing without a criterion', () => {
	const p = partition(lib, {});
	assert.equal(p.drop.length, 0);
	assert.equal(p.keep.length, lib.length);
});

test('partition copes with a track that has no seed', () => {
	// The oldest manifest entries might not have one; treating them silently as
	// "to be removed" would be data loss disguised as housekeeping.
	const seedless = [{ id: 'x', pool: 'menu', file: 'f', durS: 1, bpm: 1 }];
	const p = partition(seedless, { before: 's50' });
	assert.equal(p.drop.length, 1, 'a track with no seed does not survive --before, and that is intended');
	assert.equal(partition(seedless, { ids: [] }).drop.length, 0);
});

console.log(`music-selftest: ${passed} tests`);
