// Fuzzing the rocktree decode path — the ONE surface of this game that eats
// bytes a remote machine chose.
//
//   node tools/fuzz-rocktree.mjs                  all targets, fixed seed
//   node tools/fuzz-rocktree.mjs --list           what is covered
//   node tools/fuzz-rocktree.mjs --only node-pb --cases 20000 --seed 3
//
// The threat model, and why this file exists apart from tools/fuzz.mjs:
//
// In live mode (#168) src/rocktree-worker.js does `fetch(kh.google.com/...)`
// and hands the bytes straight to parseNode() and buildNodeGeometries(). The
// protocol is not ours, the server is not ours, and the transport is a plain
// HTTPS GET a captive portal, a corporate proxy or a compromised resolver can
// answer instead. Every other fuzz target in this repo eats something the game
// itself wrote; this one eats something a stranger wrote.
//
// WHAT IS AND IS NOT A DEFECT HERE. Throwing is FINE: the worker wraps the
// whole decode in try/catch and answers `{ ok: false, error }`, so a node that
// refuses to decode is a node that does not appear — the documented outcome of
// a 404 too. What is NOT fine, and what this file hunts:
//
//   1. a loop or an allocation whose size the BYTES choose. The pool's workers
//      are shared and persistent, and cancellation deliberately no longer
//      terminates them (src/rocktree-worker-pool.js) — a worker stuck in a
//      decode is stuck for the rest of the session, and six of them stop the
//      terrain dead;
//   2. geometry that decodes "successfully" and is wrong in a way the next
//      stage cannot survive — an index past the end of the vertex array goes
//      to Rapier's trimesh, and physics.js already documents that a bad
//      trimesh takes the WASM down with `RuntimeError: unreachable` rather
//      than a catchable exception.
//
// The corpus is tools/testdata/rocktree — real bytes kh.google.com served on
// 2026-08-31, the same fixtures the decoder selftests use. Mutating those
// reaches the parser's deep paths; pure noise never gets past the first field.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRng, pick, int, chance, firstNonFinite, pretty, runTarget } from './lib/fuzz.mjs';

const pb = await import('./lib/rocktree/pb.mjs');
const proto = await import('./lib/rocktree/proto.mjs');
const unpack = await import('./lib/rocktree/unpack.mjs');
const { buildNodeGeometries } = await import('./lib/rocktree/build-node.mjs');
const { geodeticToEcef, enuBasis } = await import('./lib/rocktree/geodesy.mjs');
const { expandBulk, dropFillinAncestors } = await import('./lib/rocktree/traverse.mjs');
const { rootOctant } = await import('./lib/rocktree/octant.mjs');

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata/rocktree');

// The fixtures are committed, but a checkout without them must SKIP loudly
// rather than fail — the pattern of tools/entry-state-selftest.mjs.
let FIX = null;
try { FIX = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')); } catch { FIX = null; }
if (!FIX) {
	console.log('fuzz-rocktree: SKIPPED — tools/testdata/rocktree is not installed');
	process.exit(0);
}

const read = (f) => new Uint8Array(fs.readFileSync(path.join(DIR, f)));
const NODES = FIX.nodes.map((n) => read(n.file));
const BULKS = FIX.bulks.map((b) => ({ ...b, buf: read(b.file) }));
const RADIUS = proto.parsePlanetoid(read(FIX.planetoid)).radius;

// An ENU origin near the capture. Any origin has to work; this one is real.
const ORIGIN = { lat: 48.8584, lon: 2.2945 };
const ORIGIN_ECEF = geodeticToEcef(ORIGIN.lat, ORIGIN.lon, 0);
const BASIS = enuBasis(ORIGIN.lat, ORIGIN.lon);

// --- corrupting bytes --------------------------------------------------------

// The four things that really happen to a response body: it is cut short, a
// byte flips, a length field lies, or a length field is enormous. Applied to
// REAL bytes — the parser's interesting code is all past the first few fields,
// and random noise never gets there.
function corrupt(r, src) {
	const buf = src.slice();
	switch (int(r, 0, 5)) {
		case 0: return buf.subarray(0, int(r, 0, buf.length));            // truncated transfer
		case 1: {                                                          // flipped bits
			for (let i = 0, n = int(r, 1, 8); i < n; i++) buf[int(r, 0, buf.length - 1)] ^= 1 << int(r, 0, 7);
			return buf;
		}
		case 2: {                                                          // a varint made huge
			const at = int(r, 0, Math.max(0, buf.length - 6));
			for (let i = 0; i < 5; i++) buf[at + i] = 0xff;
			buf[at + 5] = 0x7f;
			return buf;
		}
		case 3: {                                                          // a run zeroed
			const at = int(r, 0, Math.max(0, buf.length - 1));
			buf.fill(0, at, Math.min(buf.length, at + int(r, 1, 64)));
			return buf;
		}
		case 4: {                                                          // spliced with itself
			const at = int(r, 0, Math.max(0, buf.length - 1));
			return new Uint8Array([...buf.subarray(0, at), ...buf.subarray(int(r, 0, buf.length))]);
		}
		default: return buf;                                               // untouched: the control
	}
}

const noise = (r) => {
	const n = int(r, 0, 200);
	const buf = new Uint8Array(n);
	for (let i = 0; i < n; i++) buf[i] = chance(r, 0.4) ? pick(r, [0, 0xff, 0x80, 0x7f, 0x08, 0x12]) : int(r, 0, 255);
	return buf;
};

// --- counting the work a buffer asks for, WITHOUT doing it -------------------
//
// unpackIndices() allocates `len` slots and unpackLayerBoundsAndOctants() runs
// an inner loop `v` times per varint — both numbers read straight off the wire.
// A target that simply called them would BE the denial of service it reports,
// so the cost is counted first, from the same varints, and the call is only
// made when it is small. Duplicated rather than imported because the point is
// precisely that the real functions do not do this.

function scanVarints(buf, max = 1e6) {
	const out = [];
	const pos = { i: 0 };
	while (pos.i < buf.length && out.length < max) {
		try { out.push(pb.readVarint(buf, pos)); } catch { return out; }
	}
	return out;
}

// What unpackIndices() would allocate: `new Uint32Array(len)`, len straight off
// the wire.
const indexWork = (buf) => (buf?.length ? scanVarints(buf, 1)[0] ?? 0 : 0);

// What unpackLayerBoundsAndOctants() would iterate: `len` outer steps, plus the
// sum of the next `len` varints — its inner `for (let j = 0; j < v; j++)`.
function layerWork(buf) {
	if (!buf?.length) return 0;
	const vs = scanVarints(buf);
	const len = vs[0] ?? 0;
	let total = len;
	for (let i = 1; i < vs.length && i <= len; i++) total += vs[i];
	return total;
}

// A varint, as the wire spells one.
function putVarint(out, v) {
	let n = v;
	while (n >= 0x80) { out.push((n % 0x80) + 0x80); n = Math.floor(n / 0x80); }
	out.push(n);
}

// A mesh whose two length-driven loops are small enough to actually run.
const CHEAP = 4e6;
const cheapMesh = (m) => indexWork(m.indices) <= CHEAP && layerWork(m.layerAndOctantCounts) <= CHEAP;

// --- targets -----------------------------------------------------------------

const targets = [

{
	name: 'pb-wire',
	note: 'the protobuf wire reader, on a body kh.google.com (or whatever answered for it) sent — no schema, just bytes',
	gen(r, i) {
		if (i % 3 === 0) return noise(r);
		return corrupt(r, pick(r, [...NODES, ...BULKS.map((b) => b.buf), read(FIX.planetoid)]));
	},
	check(buf) {
		let fields;
		try { fields = pb.readFields(buf); } catch (err) {
			// Refusing is the contract; refusing with something that is not an
			// Error leaves the worker's catch nothing to report.
			if (!(err instanceof Error) || !err.message) return `readFields threw a useless error: ${pretty(err)}`;
			return null;
		}
		// A field can never claim more bytes than the buffer holds, and the
		// reader can never invent a wire type it does not implement.
		let bytes = 0;
		for (const f of fields) {
			if (!Number.isInteger(f.num) || f.num < 0) return `field number ${pretty(f.num)}`;
			if (![0, 1, 2, 5].includes(f.wire)) return `wire type ${pretty(f.wire)}`;
			if (f.wire === 2) {
				if (!(f.value instanceof Uint8Array)) return `a length-delimited field came back as ${pretty(f.value)}`;
				if (f.value.byteOffset + f.value.length > buf.byteOffset + buf.length) return 'a field runs past the end of the buffer';
				bytes += f.value.length;
			} else if (typeof f.value !== 'number') return `field ${f.num} (wire ${f.wire}) came back as ${pretty(f.value)}`;
			else if (f.wire === 0 && !Number.isSafeInteger(f.value)) return `varint ${f.value} is not a safe integer`;
		}
		if (bytes > buf.length) return `the fields add up to ${bytes} bytes out of a ${buf.length}-byte body`;
		// doubles()/floats() reinterpret a field as a typed array. A length that
		// is not a multiple of the element size is a RangeError, which is fine —
		// silently reading past the field would not be.
		for (const f of fields) {
			if (f.wire !== 2) continue;
			for (const [name, fn] of [['doubles', pb.doubles], ['floats', pb.floats]]) {
				let out;
				try { out = fn(f.value); } catch (err) {
					if (!(err instanceof Error)) return `${name} threw ${pretty(err)}`;
					continue;
				}
				if (out.byteLength > f.value.length) return `${name} read ${out.byteLength} bytes out of a ${f.value.length}-byte field`;
			}
		}
		return null;
	},
},

{
	name: 'node-pb',
	known: 'nothing between parseNode() and RAPIER.ColliderDesc.trimesh() checks the decode: a strip index past the vertex plane and a NaN in the placement matrix both reach the collider, and physics.js already records that a bad trimesh aborts the WASM instead of throwing',
	note: 'NodeData from kh.google.com, decoded in src/rocktree-worker.js and handed to Three and to Rapier\'s trimesh',
	gen(r, i) {
		return { buf: i % 8 === 0 ? noise(r) : corrupt(r, pick(r, NODES)), exclude: chance(r, 0.3) ? [int(r, 0, 7)] : [] };
	},
	check({ buf, exclude }) {
		let node;
		try { node = proto.parseNode(buf); } catch (err) {
			if (!(err instanceof Error) || !err.message) return `parseNode threw a useless error: ${pretty(err)}`;
			return null;   // refused: the worker answers { ok: false } and the node is skipped
		}
		if (!Array.isArray(node.meshes)) return `parseNode produced meshes = ${pretty(node.meshes)}`;
		// The matrix places every vertex. 16 doubles or nothing.
		if (!(node.matrix instanceof Float64Array)) return `matrix came back as ${pretty(node.matrix)}`;
		if (node.matrix.length !== 16) return null;   // a short matrix makes the build meaningless, and it throws below anyway
		// Cost is COUNTED before anything is decoded — see the header. A mesh
		// whose declared counts are absurd is unpack-cost's finding, not this
		// target's, and running it here would hang the fuzzer exactly the way it
		// hangs a pool worker.
		if (!node.meshes.every((m) => m && cheapMesh(m))) return null;
		let built;
		try {
			built = buildNodeGeometries({ matrix: node.matrix, meshes: node.meshes, sphereRadius: RADIUS, originEcef: ORIGIN_ECEF, originBasis: BASIS, exclude });
		} catch (err) {
			if (!(err instanceof Error) || !err.message) return `buildNodeGeometries threw a useless error: ${pretty(err)}`;
			return null;
		}
		for (const [i, g] of built.entries()) {
			const count = g.positions.length / 3;
			// THIS is the one that matters. physics.js hands `indices` to
			// RAPIER.ColliderDesc.trimesh(), and its own comment records that a
			// malformed trimesh takes the WASM process down with
			// `RuntimeError: unreachable` — not something a try/catch sees.
			for (let k = 0; k < g.indices.length; k++) {
				if (!(g.indices[k] >= 0 && g.indices[k] < count)) {
					return `mesh ${i}: index ${g.indices[k]} into a ${count}-vertex array (Rapier trimesh territory)`;
				}
			}
			if (g.indices.length % 3 !== 0) return `mesh ${i}: ${g.indices.length} indices is not a whole number of triangles`;
			const posBad = firstNonFinite(g.positions);
			if (posBad) return `mesh ${i}: positions hold ${posBad}`;
			if (g.uvs && firstNonFinite(g.uvs)) return `mesh ${i}: uvs hold ${firstNonFinite(g.uvs)}`;
			// The bounding sphere is what the frustum culls on: a wrong one makes
			// a mesh vanish or never cull.
			const sph = g.boundingSphere;
			if (firstNonFinite(sph)) return `mesh ${i}: boundingSphere holds ${firstNonFinite(sph)}`;
			if (!(sph.radius >= 0)) return `mesh ${i}: boundingSphere radius ${sph.radius}`;
		}
		return null;
	},
},

{
	name: 'unpack-cost',
	known: 'unpackIndices() allocates the length the bytes declare, and unpackLayerBoundsAndOctants() runs its inner loop the number of times the bytes declare — neither is bounded by the mesh',
	note: 'the two length fields of a mesh — opaque byte strings whose leading varint whatever answered the NodeData request chose, and which the unpackers believe',
	// The field bytes are built here rather than carved out of a fixture: the
	// leading varint is the whole subject, and reaching it by flipping bits
	// inside a 56 KB body finds it about never. This IS the shape parseNode
	// hands the unpackers — `one(f, 3)` and `one(f, 8)` are raw subarrays.
	gen(r) {
		const verts = int(r, 0, 4000);
		const len = pick(r, [0, 1, 12, verts, 2 ** 20, 2 ** 31, 2 ** 40, Number.MAX_SAFE_INTEGER]);
		const bytes = [];
		putVarint(bytes, len);
		for (let i = 0, n = int(r, 0, 40); i < n; i++) putVarint(bytes, pick(r, [0, 1, 7, 2 ** 20, 2 ** 40]));
		return { field: new Uint8Array(bytes), verts };
	},
	check({ field, verts }) {
		// Counted from the same varints the unpackers read, never executed:
		// executing it is the denial of service being reported.
		const idx = indexWork(field);
		const layers = layerWork(field);
		// The mesh is the bound. A strip cannot hold more indices than the mesh
		// has vertices to visit, and an octant run cannot paint more of the
		// strip than the strip holds — both are checkable before a byte is
		// unpacked, and neither is checked.
		const ceiling = Math.max(1024, verts * 4);
		if (idx > ceiling) return `unpackIndices would allocate ${idx.toExponential(2)} slots (${(idx * 4).toExponential(2)} bytes) for a ${verts}-vertex mesh`;
		if (layers > ceiling) return `unpackLayerBoundsAndOctants would loop ${layers.toExponential(2)} times for a ${verts}-vertex mesh`;
		return null;
	},
},

{
	name: 'bulk-pb',
	note: 'BulkMetadata from kh.google.com — the octree map the traversal walks before a single node is fetched',
	gen(r, i) {
		const b = pick(r, BULKS);
		return {
			buf: i % 8 === 0 ? noise(r) : corrupt(r, b.buf),
			bulkPath: b.path,
			level: int(r, 2, 22),
			zone: { south: 48.8, north: 48.9, west: 2.2, east: 2.4 },
		};
	},
	check({ buf, bulkPath, level, zone }) {
		let bulk;
		try { bulk = proto.parseBulk(buf); } catch (err) {
			if (!(err instanceof Error) || !err.message) return `parseBulk threw a useless error: ${pretty(err)}`;
			return null;
		}
		if (!(bulk.nodes instanceof Map)) return `parseBulk produced nodes = ${pretty(bulk.nodes)}`;
		// A relative path is 1 to 4 octal digits — the protocol's own bulk
		// boundary. expandBulk walks it as a tree and would not terminate on
		// anything else.
		for (const rel of bulk.nodes.keys()) {
			if (!/^[0-7]{1,4}$/.test(rel)) return `parseBulk produced the relative path ${pretty(rel)}`;
		}
		const box = bulkPath.length >= 2 ? rootOctant(48.8584, 2.2945).box : { s: -90, n: 90, w: -180, e: 180 };
		let out;
		try { out = expandBulk(bulk, bulkPath, box, zone, level); } catch (err) {
			return `expandBulk threw on a decoded bulk: ${err?.name}: ${err?.message}`;
		}
		const paths = new Set();
		for (const n of out.retained) {
			if (!n.path.startsWith(bulkPath)) return `expandBulk retained ${n.path}, which is not under ${pretty(bulkPath)}`;
			// The guard the comment calls "une divergence à ne pas introduire":
			// a 4-digit relative path must not overshoot the requested level.
			if (n.path.length > level) return `expandBulk retained ${n.path} (${n.path.length} digits) for level ${level}`;
			if (paths.has(n.path)) return `expandBulk retained ${n.path} twice`;
			paths.add(n.path);
			if (!n.box || firstNonFinite(n.box)) return `${n.path} carries the box ${pretty(n.box)}`;
			if (!(n.box.s <= n.box.n && n.box.w <= n.box.e)) return `${n.path} carries an inverted box: ${pretty(n.box)}`;
		}
		for (const c of out.children) {
			if (!c.bulkPath.startsWith(bulkPath) || c.bulkPath.length !== bulkPath.length + 4) {
				return `expandBulk asked for the child bulk ${pretty(c.bulkPath)} under ${pretty(bulkPath)}`;
			}
		}
		// dropFillinAncestors mutates the map it is given; what it removes must
		// be exactly the paths another retained path extends.
		const map = new Map(out.retained.map((n) => [n.path, n]));
		const before = new Set(map.keys());
		const dropped = dropFillinAncestors(map);
		if (dropped !== before.size - map.size) return `dropFillinAncestors said it dropped ${dropped} and dropped ${before.size - map.size}`;
		for (const p of before) {
			const isAncestor = [...before].some((q) => q !== p && q.startsWith(p));
			if (isAncestor === map.has(p)) return `dropFillinAncestors ${map.has(p) ? 'kept' : 'dropped'} ${p} against its own rule`;
		}
		return null;
	},
},

];

// --- CLI ---------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

if (has('list')) {
	console.log('fuzz-rocktree targets:\n');
	for (const t of targets) console.log(`  ${t.known ? '!' : ' '} ${t.name.padEnd(14)} ${t.note}`);
	const known = targets.filter((t) => t.known);
	if (known.length) {
		console.log('\n! = known failure: registered, reproduces an unfixed defect, and left OUT of the');
		console.log('    default run so it does not break CI. Run one with --only <name>, or all with --known.');
		for (const t of known) console.log(`      ${t.name}: ${t.known}`);
	}
	process.exit(0);
}

const cases = Number(flag('cases', 1500));
const seed = Number(flag('seed', 0x46555a5a));
const only = flag('only', null);
const verbose = has('verbose');
const chosen = only ? targets.filter((t) => t.name === only) : targets.filter((t) => has('known') || !t.known);

if (chosen.length === 0) {
	console.error(`unknown target "${only}" — try --list`);
	process.exit(2);
}

console.log(`fuzz-rocktree: ${chosen.length} target(s), ${cases} cases each, seed 0x${seed.toString(16)}\n`);

let failed = 0;
for (const target of chosen) {
	const result = runTarget(target, { cases, seed, verbose });
	console.log(`  ${result.failures.length === 0 ? ' ok ' : 'FAIL'}  ${target.name.padEnd(14)} ${String(result.ms).padStart(6)} ms`);
	for (const f of result.failures) {
		failed++;
		console.log(`        ${f.kind}: ${f.detail}`);
		console.log(`        seen in ${f.count ?? 1} case(s), smallest input (case ${f.case}):`);
		console.log(`          ${describe(f.input)}`);
		if (f.stack && verbose) console.log(f.stack.split('\n').slice(1, 4).map((l) => `        ${l.trim()}`).join('\n'));
	}
}

// A shrunk protobuf is a few hundred bytes, and printing them as a list of
// numbers hides what matters. Hex, with the length, is what a decoder bug is
// read from — and it pastes straight back into a reproducer.
function describe(input) {
	if (input instanceof Uint8Array) return hex(input);
	if (!input || typeof input !== 'object') return pretty(input);
	const out = [];
	for (const [k, v] of Object.entries(input)) out.push(`${k}: ${v instanceof Uint8Array ? hex(v) : pretty(v)}`);
	return `{ ${out.join(', ')} }`;
}

const hex = (buf) => `${buf.length} bytes ${[...buf.subarray(0, 64)].map((b) => b.toString(16).padStart(2, '0')).join('')}${buf.length > 64 ? '…' : ''}`;

const skipped = only ? [] : targets.filter((t) => t.known && !chosen.includes(t));
if (skipped.length) console.log(`\nskipped (known failure): ${skipped.map((t) => t.name).join(', ')} — run with --known`);
console.log(`\n${failed === 0 ? 'no findings' : `${failed} finding(s)`} — replay with --seed 0x${seed.toString(16)} --cases ${cases}`);
process.exit(failed === 0 ? 0 : 1);
