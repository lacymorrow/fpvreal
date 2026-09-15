import assert from 'node:assert/strict';
import {
	FLIP_MIN, armMapping, beginArmDetect, feedArmDetect, armFromSignals,
	loadArmStore, saveArmStore, armStoreGet, armStoreSet, armStoreDelete,
} from '../src/arm-switch.js';

let n = 0;
function pass(label) { n++; console.log(`  PASS  ${label}`); }

// 1. a two-position switch on axis 4, disarmed at -1, armed at +1
{
	const rest = [0, 0, 0, -1, -1, 0];
	let s = beginArmDetect(rest);
	s = feedArmDetect(s, rest);
	assert.equal(s.found, null);
	s = feedArmDetect(s, [0, 0, 0, -1, 1, 0]);
	assert.deepEqual(s.found, { signal: 4, threshold: 0, armedAbove: true });
	assert.equal(armFromSignals(s.found, [0, 0, 0, -1, 1, 0]), true);
	assert.equal(armFromSignals(s.found, [0, 0, 0, -1, -1, 0]), false);
	pass('a switch flipped from -1 to +1 on signal 4 is found, thresholded at 0, armed above');
}

// 2. wired backwards: armed is the LOW side
{
	let s = beginArmDetect([0, 0, 0, 0, 1]);
	s = feedArmDetect(s, [0, 0, 0, 0, -1]);
	assert.equal(s.found.armedAbove, false);
	assert.equal(armFromSignals(s.found, [0, 0, 0, 0, -1]), true);
	assert.equal(armFromSignals(s.found, [0, 0, 0, 0, 1]), false);
	pass('a switch that goes DOWN to arm is armed below its threshold');
}

// 3. stick wobble under FLIP_MIN is not a switch; the stick moving more than
//    the switch wins, which is why the prompt says hands off the sticks
{
	let s = beginArmDetect([0, 0, 0, 0, -1]);
	s = feedArmDetect(s, [0.2, 0, 0, 0, -1]);
	assert.equal(s.found, null);
	pass(`a movement under FLIP_MIN (${FLIP_MIN}) finds nothing`);
}

// 4. three-position switch: adjacent positions are 1 apart, still found
{
	let s = beginArmDetect([0, 0, 0, 0, -1]);
	s = feedArmDetect(s, [0, 0, 0, 0, 0]);
	assert.equal(s.found.signal, 4);
	assert.equal(s.found.threshold, -0.5);
	pass('a three-position switch moving one notch is found, thresholded between the notches');
}

// 5. a mapping whose signal is gone reads disarmed, never armed
{
	const m = armMapping({ signal: 9, low: -1, high: 1 });
	assert.equal(armFromSignals(m, [0, 0, 0, 0]), false);
	assert.equal(armFromSignals(m, [0, 0, 0, 0, 0, 0, 0, 0, 0, NaN]), false);
	assert.equal(armFromSignals(null, [1, 1, 1]), null);
	pass('a missing or NaN signal reads disarmed; no mapping reads null');
}

// 6. storage round trip and garbage tolerance
{
	const mem = new Map();
	const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
	let store = loadArmStore(storage);
	assert.deepEqual(store, {});
	store = armStoreSet(store, 'Radiomaster Pocket (1209:4f54)', armMapping({ signal: 4, low: -1, high: 1 }));
	saveArmStore(storage, store);
	const back = loadArmStore(storage);
	assert.deepEqual(armStoreGet(back, 'Radiomaster Pocket (1209:4f54)'), { signal: 4, threshold: 0, armedAbove: true });
	assert.equal(armStoreGet(back, 'other pad'), null);
	assert.equal(armStoreGet(armStoreDelete(back, 'Radiomaster Pocket (1209:4f54)'), 'Radiomaster Pocket (1209:4f54)'), null);
	mem.set('fpvreal.armSwitch', '{not json');
	assert.deepEqual(loadArmStore(storage), {});
	mem.set('fpvreal.armSwitch', '[1,2]');
	assert.deepEqual(loadArmStore(storage), {});
	mem.set('fpvreal.armSwitch', JSON.stringify({ pad: { signal: 'x' } }));
	assert.equal(armStoreGet(loadArmStore(storage), 'pad'), null);
	pass('the store survives a round trip and shrugs off hand-edited garbage');
}

console.log(`arm-switch: ${n} checks, all PASS`);
