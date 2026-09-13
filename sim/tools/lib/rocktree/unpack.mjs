// Unpacking rocktree meshes. Rewritten from the protocol documentation of
// earth-reverse-engineering (that repository has no licence: nothing is
// copied, the described format is reimplemented).
//
// Everything here decodes bytes that came off the network from a server this
// project does not own, and the same code runs inside the browser worker on
// the `?live=` path. So every length read out of the stream is treated as
// hostile until it has been checked against what the buffer can actually hold:
// a varint is cheap to write and `new Uint32Array(n)` is not.
import { readVarint } from './pb.mjs';

// A count read from the stream can only be honest if the bytes that must
// follow it fit in what is left. Each subsequent element costs at least one
// varint byte, so the remaining length is a hard ceiling. Without this, eight
// bytes of input ask for an 8 GiB allocation and tie up the thread for over a
// minute — on the player's machine, not ours.
function checkedCount(len, buf, pos, what) {
	const remaining = buf.length - pos.i;
	if (!Number.isInteger(len) || len < 0 || len > remaining) {
		throw new Error(`${what}: count ${len} cannot fit in ${remaining} remaining bytes`);
	}
	return len;
}

// 3 byte planes (all the Xs, all the Ys, all the Zs), delta-encoded mod 256.
export function unpackVertices(buf) {
	const count = Math.floor(buf.length / 3);
	const xyz = new Uint8Array(count * 3);
	let x = 0, y = 0, z = 0;
	for (let i = 0; i < count; i++) {
		xyz[i * 3] = (x = (x + buf[i]) & 0xff);
		xyz[i * 3 + 1] = (y = (y + buf[count + i]) & 0xff);
		xyz[i * 3 + 2] = (z = (z + buf[count * 2 + i]) & 0xff);
	}
	return { xyz, count };
}

// 4-byte header: (uMod-1, vMod-1) as little-endian uint16. Then 4 byte planes:
// lo(u), lo(v), hi(u), hi(v) — delta-encoded modulo uMod/vMod.
export function unpackTexCoords(buf, count) {
	const dv = new DataView(buf.buffer, buf.byteOffset, 4);
	const uMod = 1 + dv.getUint16(0, true), vMod = 1 + dv.getUint16(2, true);
	const data = buf.subarray(4);
	if (data.length !== count * 4) throw new Error(`texcoords: ${data.length} bytes for ${count} vertices`);
	const uv = new Uint16Array(count * 2);
	let u = 0, v = 0;
	for (let i = 0; i < count; i++) {
		uv[i * 2] = (u = (u + data[i] + (data[count * 2 + i] << 8)) % uMod);
		uv[i * 2 + 1] = (v = (v + data[count + i] + (data[count * 3 + i] << 8)) % vMod);
	}
	return { uv, uMod, vMod };
}

// Compressed triangle strip: each value is a step back from the number of
// zeros seen so far. Returned as absolute indices; the caller unrolls the strip.
export function unpackIndices(buf) {
	const pos = { i: 0 };
	const len = checkedCount(readVarint(buf, pos), buf, pos, 'indices');
	const strip = new Uint32Array(len);
	let zeros = 0;
	for (let i = 0; i < len; i++) {
		const val = readVarint(buf, pos);
		strip[i] = zeros - val;
		if (val === 0) zeros++;
	}
	return strip;
}

// layer_and_octant_counts: `len` varints; every 8th is a layer bound (indices
// into the strip), and each varint v paints octant (i & 7) over the next v
// indices of the strip. layerBounds[m] = the strip index where group m starts;
// layerBounds[3] is therefore the START of TERRAIN_HIDDEN — downstream keeps
// i < layerBounds[3], that is layers 0-2 (OVERGROUND + visible terrain). Do
// not shift it: the reference records the bound BEFORE the group.
export function unpackLayerBoundsAndOctants(buf, strip, vertCount) {
	const pos = { i: 0 };
	const len = checkedCount(readVarint(buf, pos), buf, pos, 'layer/octant counts');
	const layerBounds = new Int32Array(10);
	const octantOf = new Uint8Array(vertCount);
	let k = 0, m = 0, idx = 0;
	for (let i = 0; i < len; i++) {
		if (i % 8 === 0 && m < 10) layerBounds[m++] = k;
		const v = readVarint(buf, pos);
		// v is also off the wire: it walks `strip`, and a value larger than what
		// is left of it would read past the end. Refuse rather than truncate —
		// a strip that does not describe itself is not a mesh we can trust.
		if (idx + v > strip.length) {
			throw new Error(`layer/octant counts: run of ${v} exceeds the ${strip.length - idx} indices left`);
		}
		for (let j = 0; j < v; j++) octantOf[strip[idx++]] = i & 7;
		k += v;
	}
	while (m < 10) layerBounds[m++] = k;
	return { layerBounds, octantOf };
}
