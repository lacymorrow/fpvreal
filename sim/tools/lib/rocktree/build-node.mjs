// A rocktree node's geometry, ready for Three/Rapier, WITHOUT Three (#187).
// Extracted from buildNodeMesh() (src/main.js) to run inside
// src/rocktree-worker.js: each node cost ~0.3-2.6 ms of conversion on the main
// thread, and during a wave that work helped overrun the 16.7 ms frame (the
// physics accumulator's catch-up spiral). No dependencies: portable to a Worker
// AND to Node (parity selftest against the reference decoder
// tools/lib/decoders/rocktree.mjs).
//
// Everything here is fed bytes a remote machine chose, and what it produces
// goes to RAPIER.ColliderDesc.trimesh(). physics.js:addNodeCollider records
// what a malformed trimesh does: `RuntimeError: unreachable` out of the WASM,
// NOT a catchable JS exception — the player's tab dies mid-flight. So the
// decode is checked here, and a node that fails is REFUSED: the worker's catch
// answers { ok: false } and the tile is simply not drawn, exactly what a 404
// already does.
import { unpackVertices, unpackTexCoords, unpackIndices, unpackLayerBoundsAndOctants } from './unpack.mjs';
import { sphereToWgs84Ecef, ecefToLocalEnu } from './geodesy.mjs';

// matrix (node.matrix) places the vertices on a SPHERE, not on the WGS84
// ellipsoid — sphereToWgs84Ecef() is the correction, NOT a formality: leaving
// it out measured 5 km of error on #18 Task 9.
export function buildNodeGeometries({ matrix, meshes, sphereRadius, originEcef, originBasis, exclude = [] }) {
	const ma = matrix;
	// The matrix comes off the wire as 16 raw doubles (proto.mjs reads any 8
	// bytes as one, NaN and Infinity included) and it multiplies EVERY vertex:
	// one bad double and the whole mesh is non-finite. Checked once, here,
	// rather than per vertex. See the finiteness accumulator below for why that
	// is not the only check.
	if (!ma || ma.length !== 16) throw new Error(`node matrix: ${ma ? ma.length : 'none'} values, expected 16`);
	for (let i = 0; i < 16; i++) {
		if (!Number.isFinite(ma[i])) throw new Error(`node matrix: entry ${i} is ${ma[i]}`);
	}
	const excludeSet = new Set(exclude);
	const built = [];
	for (const m of meshes) {
		const { xyz, count } = unpackVertices(m.vertices);
		const positions = new Float32Array(count * 3);
		// Local bounding box as the array fills: the bounding sphere is derived
		// EXACTLY the way Three.computeBoundingSphere() does (centre = middle of
		// the bbox, radius = max distance to the centre) so that frustum culling
		// is identical to what Three would have computed itself — its lazy
		// computation ran on each mesh's first visible frame, in mid-wave.
		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
		// One running sum instead of three Number.isFinite per vertex: NaN and
		// Infinity both propagate through an addition, so a single test at the
		// end says whether ANY coordinate was non-finite, at one add per vertex
		// in a loop that runs in the worker during a wave. It sums what was
		// STORED, not what was computed: `positions` is a Float32Array, and a
		// finite double past 3.4e38 — which a legal but absurd placement matrix
		// produces — becomes Infinity on the way in. Rapier reads the stored
		// array, so the stored array is what has to be checked.
		let finiteSum = 0;
		for (let v = 0; v < count; v++) {
			const x = xyz[v * 3], y = xyz[v * 3 + 1], z = xyz[v * 3 + 2];
			const ecef = sphereToWgs84Ecef(
				x * ma[0] + y * ma[4] + z * ma[8] + ma[12],
				x * ma[1] + y * ma[5] + z * ma[9] + ma[13],
				x * ma[2] + y * ma[6] + z * ma[10] + ma[14],
				sphereRadius,
			);
			const local = ecefToLocalEnu(ecef, originEcef, originBasis);
			positions[v * 3] = local.x; positions[v * 3 + 1] = local.y; positions[v * 3 + 2] = local.z;
			finiteSum += positions[v * 3] + positions[v * 3 + 1] + positions[v * 3 + 2];
			if (local.x < minX) minX = local.x; if (local.x > maxX) maxX = local.x;
			if (local.y < minY) minY = local.y; if (local.y > maxY) maxY = local.y;
			if (local.z < minZ) minZ = local.z; if (local.z > maxZ) maxZ = local.z;
		}
		// A non-finite position reaches RAPIER.ColliderDesc.trimesh() through
		// physics.js:addNodeCollider, and that aborts the WASM with
		// `RuntimeError: unreachable` — not a JS exception anything can catch, so
		// the player's tab dies mid-flight. Refuse the node instead: the worker
		// answers { ok: false } and the tile is simply not drawn, exactly what a
		// 404 already does.
		if (count > 0 && !Number.isFinite(finiteSum)) {
			throw new Error(`node geometry: a vertex is not finite after placement (${count} vertices)`);
		}
		const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
		let r2 = 0;
		for (let v = 0; v < count; v++) {
			const dx = positions[v * 3] - cx, dy = positions[v * 3 + 1] - cy, dz = positions[v * 3 + 2] - cz;
			const d2 = dx * dx + dy * dy + dz * dz;
			if (d2 > r2) r2 = d2;
		}

		// Triangle strip -> independent triangles. Written straight into an
		// oversized Uint32Array (at most 3 indices per strip step) then trimmed:
		// no intermediate JS array to collect during a wave.
		const strip = unpackIndices(m.indices);
		// Two guards, not one, both taken from forEachDrawnTriangle() in the
		// reference decoder:
		//  - layerBounds[3] = the start of TERRAIN_HIDDEN. Past it the strip
		//    describes relief the protocol does NOT draw; walking it anyway
		//    stacked that layer over the visible terrain AND made it solid on
		//    the Rapier side (#178).
		//  - exclude: octants whose geometry a kept child already draws (z-fight
		//    otherwise), normally empty after dropFillinAncestors().
		// layerBounds forces layer_and_octant_counts to be read for EVERY mesh,
		// so computing octantOf lazily no longer buys anything: it is the same
		// pass. The cost is paid in the Worker, not on the main thread (#187).
		const { layerBounds, octantOf } = unpackLayerBoundsAndOctants(m.layerAndOctantCounts, strip, count);
		const end = Math.min(layerBounds[3], strip.length);
		// Degenerate triangles (zero area, common at a strip's joins) are dropped
		// on the way past: a collision geometry that holds them destabilises
		// Rapier's contact resolution (#176).
		const idxAll = new Uint32Array(Math.max(0, end - 2) * 3);
		let w = 0;
		for (let s = 0; s + 2 < end; s++) {
			const a = strip[s], b = strip[s + 1], c = strip[s + 2];
			// unpackIndices() returns ABSOLUTE indices computed as `zeros - val`
			// from varints the remote server chose; nothing bounds them against
			// this mesh's vertex plane. An index past `count` indexes off the end
			// of the position array inside Rapier's trimesh — same uncatchable
			// WASM abort as above. Refuse the node rather than clamp: a strip
			// that does not describe its own mesh is not geometry we can trust.
			if (a >= count || b >= count || c >= count) {
				throw new Error(`node geometry: strip index ${Math.max(a, b, c)} into a ${count}-vertex mesh`);
			}
			if (a === b || a === c || b === c) continue;
			if (excludeSet.size && excludeSet.has(octantOf[a])) continue;
			if (s % 2 === 0) { idxAll[w++] = a; idxAll[w++] = b; idxAll[w++] = c; }
			else { idxAll[w++] = b; idxAll[w++] = a; idxAll[w++] = c; }
		}
		const indices = idxAll.slice(0, w);

		// Same UV normalisation as the reference decoder: the proto's
		// offset+scale when it is there, otherwise the protocol's (0.5, 1/mod)
		// fallback. NO V flip (the protocol's origin is top-left, measured
		// #158/#180).
		let uvs = null;
		if (m.texCoords) {
			const { uv: rawUv, uMod, vMod } = unpackTexCoords(m.texCoords, count);
			const [ou, ov, su, sv] = m.uvOffsetAndScale ?? [0.5, 0.5, 1 / uMod, 1 / vMod];
			uvs = new Float32Array(count * 2);
			for (let v = 0; v < count; v++) {
				uvs[v * 2] = (rawUv[v * 2] + ou) * su;
				uvs[v * 2 + 1] = (rawUv[v * 2 + 1] + ov) * sv;
			}
		}

		built.push({
			positions,
			uvs,
			indices,
			boundingSphere: { center: [cx, cy, cz], radius: Math.sqrt(r2) },
		});
	}
	return built;
}
