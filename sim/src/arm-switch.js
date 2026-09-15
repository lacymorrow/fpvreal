// The arm switch: a fifth channel on the radio, read from the same signal
// vector as the sticks (axes then buttons, see calibration.js:padSignals).
// Pure: no DOM, no Gamepad API. input.js owns the storage and the reading;
// this file owns what a mapping is and how one is found.

// How far a signal has to travel, on a -1..1 scale, before it counts as the
// switch the pilot just flipped. A two-position switch travels the full 2;
// a three-position one travels 1 between adjacent positions. Half of that,
// with margin.
export const FLIP_MIN = 0.4;

// A mapping: which signal, the threshold between its two states, and which
// side of the threshold is armed. `armedAbove` is what makes a switch wired
// backwards still work without asking the pilot to re-flash anything.
export function armMapping({ signal, low, high }) {
	return {
		signal,
		threshold: (low + high) / 2,
		armedAbove: high > low,
	};
}

// Detection starts from a snapshot of every signal with the switch in the
// DISARMED position. The pilot then flips it; the signal that moved the most,
// and far enough, is the switch.
export function beginArmDetect(signals) {
	return { baseline: [...signals], found: null };
}

export function feedArmDetect(state, signals) {
	if (state.found) return state;
	let index = -1, delta = 0;
	for (let i = 0; i < state.baseline.length; i++) {
		const d = (signals[i] ?? 0) - state.baseline[i];
		if (Math.abs(d) > Math.abs(delta)) { index = i; delta = d; }
	}
	if (index < 0 || Math.abs(delta) < FLIP_MIN) return state;
	return {
		...state,
		found: armMapping({ signal: index, low: state.baseline[index], high: signals[index] }),
	};
}

// true when the switch is in its armed position, false otherwise. A mapping
// whose signal the device no longer reports reads as disarmed: a radio that
// went away must not leave the motors running.
export function armFromSignals(mapping, signals) {
	if (!mapping) return null;
	const v = signals[mapping.signal];
	if (v === undefined || !Number.isFinite(v)) return false;
	return mapping.armedAbove ? v > mapping.threshold : v < mapping.threshold;
}

// Storage shape: { [padId]: mapping }. Kept separate from the calibration
// store so calibrating again does not forget the switch, and vice versa.
export const ARM_STORAGE_KEY = 'fpvreal.armSwitch';

export function loadArmStore(storage) {
	try {
		const raw = storage?.getItem(ARM_STORAGE_KEY);
		const parsed = raw ? JSON.parse(raw) : null;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function saveArmStore(storage, store) {
	try { storage?.setItem(ARM_STORAGE_KEY, JSON.stringify(store)); } catch { /* private mode */ }
}

export function armStoreGet(store, padId) {
	const m = store?.[padId];
	if (!m || typeof m.signal !== 'number' || typeof m.threshold !== 'number') return null;
	return { signal: m.signal, threshold: m.threshold, armedAbove: !!m.armedAbove };
}

export function armStoreSet(store, padId, mapping) {
	return { ...store, [padId]: mapping };
}

export function armStoreDelete(store, padId) {
	const next = { ...store };
	delete next[padId];
	return next;
}
