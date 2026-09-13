// BUILD NOTES (PHASE 21, D8). A hand-written ladder: the volume is too small
// and too curatorial for batch generation.
//
// The writing rule, and the reason the selftest exists: a note talks about the
// TOOL, in the PAST TENSE. Never about the operator, never about what comes
// next. That is what keeps the lore decorative even as the ladder unlocks
// session after session.

export const NOTES = [
	{ build: '0.1.0', unlock: { terrains: 0, sessions: 0, targets: 0 }, lines: [
		'first public build',
		'terrain import works. mostly',
	] },
	{ build: '0.1.4', unlock: { terrains: 1, sessions: 0, targets: 0 }, lines: [
		'fixed: tile 842 decoded twice',
		'mikhail was right',
	] },
	{ build: '0.2.0', unlock: { terrains: 1, sessions: 1, targets: 0 }, lines: [
		'session log added',
		'no crash recovery, sessions kept anyway',
	] },
	{ build: '0.2.1', unlock: { terrains: 1, sessions: 3, targets: 0 }, lines: [
		'fixed: session timestamp off by one hour on the export box',
		'root: leave the clock alone',
	] },
	{ build: '0.3.0', unlock: { terrains: 2, sessions: 3, targets: 1 }, lines: [
		'target scan integrated',
		'scan radius tuned against three terrains, not one',
	] },
	{ build: '0.3.2', unlock: { terrains: 2, sessions: 5, targets: 2 }, lines: [
		'fixed: target log duplicated entries on resume',
		'jensen found it, cron never complained',
	] },
	{ build: '0.4.0', unlock: { terrains: 3, sessions: 6, targets: 3 }, lines: [
		'control vector capture rewritten',
		'old capture dropped the last input on slow machines',
	] },
	{ build: '0.5.0', unlock: { terrains: 3, sessions: 9, targets: 5 }, lines: [
		'weather bulletin wired to world state',
		'forecast text pulled from the same feed as the terrain query',
	] },
	{ build: '0.5.3', unlock: { terrains: 4, sessions: 12, targets: 6 }, lines: [
		'fixed: forecast request retried forever on a dead feed',
		'now gives up after three tries and says so',
	] },
	{ build: '0.6.0', unlock: { terrains: 4, sessions: 15, targets: 8 }, lines: [
		'operator switching added',
		'mikhail: about time',
	] },
	{ build: '0.7.0', unlock: { terrains: 5, sessions: 20, targets: 10 }, lines: [
		'terrain cache pruning added',
		'oldest unopened terrain drops first past the storage cap',
	] },
	{ build: '0.9.0', unlock: { terrains: 6, sessions: 25, targets: 13 }, lines: [
		'fixed: cache pruning counted a terrain twice under its old and new slug',
		'root signed off after a week of watching it run clean',
	] },
];

// The operator file is read, not written, by this module: a hand edit can put
// anything under `sessions` and `terrainCache`, and `?? []` only covers null
// and undefined — `"sessions": 0` walked straight into `.filter is not a
// function` and took the whole FIELD screen down with it. Array.isArray is the
// only test that holds (fuzzing finding 3, same class as tools/lib/as-text.mjs).
const arrayOf = (v) => (Array.isArray(v) ? v : []);

export function countersOf(operator) {
	return {
		terrains: arrayOf(operator?.terrainCache).length,
		sessions: arrayOf(operator?.sessions).length,
		targets: arrayOf(operator?.sessions).filter((s) => s?.target).length,
	};
}

const reached = (c, u) => c.terrains >= u.terrains && c.sessions >= u.sessions && c.targets >= u.targets;

// A prefix, never a filter: the thresholds are increasing (the selftest pins
// that), so the first note out of reach stops the ladder. Without it, a gap in
// the list would give a build number inconsistent with what can be read.
export function unlockedNotes(counters) {
	const out = [];
	for (const note of NOTES) {
		if (!reached(counters, note.unlock)) break;
		out.push(note);
	}
	return out.length ? out : [NOTES[0]];
}

export function currentBuild(counters) {
	return unlockedNotes(counters).at(-1).build;
}
