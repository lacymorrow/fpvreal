// Selftest of the length guards in tools/lib/rocktree/unpack.mjs.
//
// This decoder eats bytes that came off kh.google.com, and the same code runs
// in the browser worker on the `?live=` path. A security pass found that a
// count read straight out of the stream was handed to `new Uint32Array(n)`
// unchecked: eight bytes of input asked for an 8 GiB allocation and tied up
// the thread for over a minute. These tests pin the guards, because this is
// the class of bug that comes back the next time the decoder is edited.
//
// Run: node tools/rocktree-unpack-selftest.mjs
import assert from 'node:assert/strict';
import { unpackIndices, unpackLayerBoundsAndOctants } from './lib/rocktree/unpack.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// A varint, little-endian base-128, high bit as the continuation flag.
function varint(v) {
	const out = [];
	while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
	out.push(v);
	return out;
}
const bytes = (...vs) => Uint8Array.from(vs.flatMap(varint));

t('unpackIndices refuses a count larger than the bytes that follow it', () => {
	// The exact shape the fuzzing pass found: a huge count, then nothing.
	assert.throws(() => unpackIndices(bytes(0x7fffffff)), /cannot fit/);
	assert.throws(() => unpackIndices(bytes(1000, 0, 0, 0)), /cannot fit/);
});

t('unpackIndices still decodes a well-formed strip', () => {
	// Each value is a step back from the number of zeros seen so far; a zero
	// both emits an index and increments that count.
	const strip = unpackIndices(bytes(3, 0, 0, 1));
	assert.equal(strip.length, 3);
	assert.deepEqual([...strip], [0, 1, 1]);
});

t('unpackIndices accepts an empty strip', () => {
	assert.equal(unpackIndices(bytes(0)).length, 0);
});

t('a hostile count allocates nothing measurable', () => {
	// The point of the guard is that it costs no memory to refuse. Without it
	// this line alone reserved gigabytes.
	const before = process.memoryUsage().heapTotal;
	assert.throws(() => unpackIndices(bytes(0x7fffffff)));
	const grown = (process.memoryUsage().heapTotal - before) / 1024 / 1024;
	assert.ok(grown < 64, `heap grew by ${grown.toFixed(1)} MB refusing a hostile count`);
});

t('unpackLayerBoundsAndOctants refuses a count larger than its buffer', () => {
	const strip = Uint32Array.from([0, 1, 2]);
	assert.throws(() => unpackLayerBoundsAndOctants(bytes(0x7fffffff), strip, 3), /cannot fit/);
});

t('unpackLayerBoundsAndOctants refuses a run that walks past the strip', () => {
	// The per-entry count is off the wire too: a run longer than what is left
	// of the strip would read past its end and paint from undefined indices.
	const strip = Uint32Array.from([0, 1, 2]);
	assert.throws(() => unpackLayerBoundsAndOctants(bytes(1, 99), strip, 3), /exceeds/);
});

t('unpackLayerBoundsAndOctants still decodes a well-formed buffer', () => {
	const strip = Uint32Array.from([0, 1, 2, 3]);
	// Two entries: 3 indices in octant 0, then 1 index in octant 1.
	const { layerBounds, octantOf } = unpackLayerBoundsAndOctants(bytes(2, 3, 1), strip, 4);
	assert.deepEqual([...octantOf], [0, 0, 0, 1]);
	// The first bound is recorded BEFORE the group, so it is 0; the rest fill
	// with the running total once the entries run out.
	assert.equal(layerBounds[0], 0);
	assert.equal(layerBounds[9], 4);
});

console.log(`PASS  rocktree-unpack-selftest (${n} tests)`);
