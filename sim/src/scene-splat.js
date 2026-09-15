// A scene built from a video: a Gaussian splat for the picture, a trimesh
// for the crash, the pilot's flown path for the ghost line. The folder comes
// from pipeline/ (fpvreal-scene); this file only opens it.
//
// The splat stays in the reconstruction's own frame and is placed with one
// transform, because rotating a splat's spherical harmonics by hand is a
// bug farm. The collision mesh and the path already arrive in sim metres.

import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

export const SCENE_FORMAT = 'fpvreal-scene/1';
const GHOST_COLOR = 0xe4552b;

// scene.json, splat.ply and collision.bin live next to each other.
function resolveBase(url) {
	const u = new URL(url, location.href);
	if (!u.pathname.endsWith('.json')) {
		if (!u.pathname.endsWith('/')) u.pathname += '/';
		u.pathname += 'scene.json';
	}
	return u;
}

async function fetchOrThrow(url, what) {
	let r;
	try { r = await fetch(url); } catch { throw new Error(`Could not reach ${what} at ${url}`); }
	if (!r.ok) throw new Error(`${what} is missing (HTTP ${r.status}) at ${url}`);
	return r;
}

// Reads the manifest and the collision triangles. Cheap: no splat yet.
export async function loadSceneManifest(url) {
	const manifest = resolveBase(url);
	const r = await fetchOrThrow(manifest, 'the scene');
	let json = null;
	// A dev server answers a missing path with the app's own HTML.
	if (!/html/i.test(r.headers.get('content-type') ?? '')) {
		try { json = await r.json(); } catch { json = null; }
	}
	if (!json) {
		throw new Error(`No scene at ${manifest.pathname}. Copy the folder fpvreal-scene wrote into sim/public/scenes/ and open ?scene=/scenes/<name>/`);
	}
	if (json.format !== SCENE_FORMAT) {
		throw new Error(`${manifest} is "${json.format ?? 'unknown'}", this build opens ${SCENE_FORMAT}`);
	}
	const binUrl = new URL(json.collision.file, manifest);
	const buf = await (await fetchOrThrow(binUrl, 'the collision mesh')).arrayBuffer();
	const nv = json.collision.vertices, nt = json.collision.triangles;
	if (buf.byteLength !== nv * 12 + nt * 12) {
		throw new Error(`collision.bin is ${buf.byteLength} bytes, scene.json expects ${nv * 12 + nt * 12}`);
	}
	const vertices = new Float32Array(buf, 0, nv * 3);
	const indices = new Uint32Array(buf, nv * 12, nt * 3);
	return { json, base: manifest, collision: { vertices, indices } };
}

// The picture. onProgress(0..1) while the splat streams in.
export function loadSplat({ json, base }, renderer, scene, onProgress) {
	const spark = new SparkRenderer({ renderer });
	scene.add(spark);
	const mesh = new SplatMesh({
		url: new URL(json.splat, base).href,
		onProgress: (p) => onProgress?.(typeof p === 'number' ? p : (p?.loaded && p?.total ? p.loaded / p.total : 0)),
	});
	const t = json.splatTransform;
	mesh.quaternion.set(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);
	mesh.scale.setScalar(t.scale);
	mesh.position.set(t.position[0], t.position[1], t.position[2]);
	scene.add(mesh);
	return { spark, mesh, ready: mesh.initialized };
}

// The line the original pilot flew, in the accent colour, always visible:
// a ghost is meant to show through walls.
export function ghostLine(json) {
	const pts = json.path.map((p) => new THREE.Vector3(p[1], p[2], p[3]));
	const geometry = new THREE.BufferGeometry().setFromPoints(pts);
	const material = new THREE.LineBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.55, depthTest: false });
	const line = new THREE.Line(geometry, material);
	line.name = 'ghost-path';
	line.renderOrder = 10;
	line.frustumCulled = false;
	return line;
}

// Where the pilot started: the first point of the path.
export function pathStart(json) {
	const p = json.path[0];
	return p ? { x: p[1], y: p[2], z: p[3] } : { x: 0, y: 0, z: 0 };
}
