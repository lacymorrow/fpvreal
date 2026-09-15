// FPV Real: pick a place on Earth, fly it with your radio, in the browser.
//
// The flight stack (input, controller, airframe, physics) and the terrain
// streaming come from FPVThePlanet by lionrayonnant, AGPL-3.0. This file is
// the shell around them: boot, the flight loop, respawn. Nothing here knows
// the airframe, the controller or the radio; those modules keep their
// upstream boundaries so fixes can be pulled in.

import * as THREE from 'three';
import { initPhysics, Physics } from './physics.js';
import { MAX_STEPS_PER_FRAME, catchUpStep } from './frame-pacing.js';
import { crashThreshold, idleThrottle } from './quad.js';
import { FlightController, RATE_PRESETS } from './flightController.js';
import { PROFILES } from './drone-profiles.js';
import { Input } from './input.js';
import { EngineAudio } from './audio.js';
import { FpvLens, LINK_ANALOG } from './lens.js';
import { VideoLink } from './link.js';
import { SkyDome, CLEAR_HORIZON as SKY } from './sky.js';
import { createRocktreeMaterial, createLiveEdgeUniforms, edgeFadeForRadius } from './RocktreeMaterial.js';
import { RocktreeWindow } from './rocktree-window.js';
import { LiveNodeQueue } from './live-node-queue.js';
import { warmUp as warmUpTraverseWorker } from './rocktree-traverse-client.js';
import { warmUp as warmUpNodePool } from './rocktree-worker-pool.js';
import { push as rocktreeFencePush } from './rocktree-fence.js';
import { chaseTarget, chaseStep, CHASE } from './chase-camera.js';
import { localEnuToEcef, ecefToGeodetic } from '../tools/lib/rocktree/geodesy.mjs';

// ---------------------------------------------------------------------------
// Where and what

// Uptown Charlotte, NC. ?at=lat,lon flies anywhere else. M1 replaces this
// with the map screen.
const DEFAULT_AT = [35.2271, -80.8431];
// Google Earth octree level. 21 is street-level photogrammetry; measured
// upstream as the level that keeps a 600 m window under budget.
const ROCKTREE_LEVEL = 21;
// The disc of terrain kept loaded around the quad, in metres.
const VIEW_RANGE_M = 600;
// Spawn height over the first ground found under the origin. Low on purpose:
// a racing pilot arms on the pad, not in a fall.
const SPAWN_ABOVE_GROUND_M = 1.0;
// The pilot stands at the spawn; the video receiver's antenna is at head
// height. The link model degrades with distance and occlusion from here.
const ANTENNA_HEIGHT = 1.2;
// FPV camera: field of view and uptilt, both in degrees.
const CAMERA_FOV = 120;
const CAMERA_TILT = 25;
// After a crash the picture dies, then you are back on the pad.
const RESPAWN_AFTER_MS = 700;
// How long to wait for the ground under the spawn before giving up.
const BOOT_DEADLINE_MS = 45000;
// Family flown. freestyle5 is the 5-inch reference airframe upstream tuned.
const PROFILE = PROFILES.freestyle5;
// The picture the goggles show once the link is gone.
const DEAD_LINK = { quality: 0, rssiDbm: -100, lossDb: 999, frozen: true };

const params = new URLSearchParams(location.search);
const AT = params.has('at') ? params.get('at').split(',').map(Number) : DEFAULT_AT;
if (AT.length !== 2 || !AT.every(Number.isFinite)) {
	throw new Error(`?at= expects "lat,lon", got "${params.get('at')}"`);
}

// ---------------------------------------------------------------------------
// Scene, renderer, screen

// The imagery already carries its own light and colour: the whole pipeline is
// pass-through. With colour management on, Three would re-encode the sky.
THREE.ColorManagement.enabled = false;

const ui = document.getElementById('ui');
ui.insertAdjacentHTML('beforeend', `
	<div id="boot">
		<p id="boot-title">FPV REAL</p>
		<p id="boot-status">Reaching the terrain</p>
		<p id="boot-detail"></p>
	</div>
	<div id="osd" hidden>
		<span id="osd-left"></span>
		<span id="osd-right"></span>
	</div>
	<p id="credit" hidden>Imagery © Google</p>
`);
const el = {
	boot: ui.querySelector('#boot'),
	status: ui.querySelector('#boot-status'),
	detail: ui.querySelector('#boot-detail'),
	osd: ui.querySelector('#osd'),
	osdLeft: ui.querySelector('#osd-left'),
	osdRight: ui.querySelector('#osd-right'),
	credit: ui.querySelector('#credit'),
};
function bootStatus(text, detail = '') {
	el.status.textContent = text;
	el.detail.textContent = detail;
}
function bootFail(err) {
	console.error(err);
	el.boot.hidden = false;
	el.boot.classList.add('failed');
	bootStatus(String(err?.message ?? err), 'Reload to try again, or pick another place with ?at=lat,lon');
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
// The terrain edge dissolves into this fog rather than stopping dead. The
// density is pushed per frame from the streaming window's radius.
scene.fog = new THREE.FogExp2(SKY, 0);
const skyDome = new SkyDome(scene);
skyDome.setState({});

// near = 0.15 is the collider radius: nothing gets closer to the camera
// without having already collided. Also what keeps photogrammetry's coplanar
// surfaces from z-fighting.
const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.15, 2500);

let renderer;
try {
	renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch (err) {
	bootFail(new Error('This browser has no WebGL2. Chrome or Firefox on a machine with a GPU is what this needs.'));
	throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

const input = new Input();
const audio = new EngineAudio();
const lens = new FpvLens(renderer, scene);
const link = new VideoLink();
lens.setEnabled(true);
lens.setParams({ lens: 0.6, vignette: 0.5, shutter: 0.008 });
lens.setLink({ mode: LINK_ANALOG, severity: 1 });
link.setSeverity(1);

function resize() {
	camera.aspect = innerWidth / innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(innerWidth, innerHeight);
	lens.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize);
resize();

// Web Audio needs a gesture. The first key or click starts the motors' sound;
// a radio alone never will, which is a browser rule, not ours.
const wakeAudio = () => { audio.start(); };
addEventListener('keydown', wakeAudio, { once: true });
addEventListener('pointerdown', wakeAudio, { once: true });

// ---------------------------------------------------------------------------
// Live terrain: streamed nodes become meshes and colliders under a budget

let physics = null;
let controller = null;
let liveWindow = null;
const liveQueue = new LiveNodeQueue();
// node path -> [{ colliderPath, mesh }]
const liveMeshes = new Map();
const liveEdgeUniforms = createLiveEdgeUniforms(SKY);

function buildNodeMesh(path, meshes) {
	const built = [];
	meshes.forEach((m, i) => {
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
		geometry.setIndex(new THREE.BufferAttribute(m.indices, 1));
		if (m.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
		geometry.boundingSphere = new THREE.Sphere(
			new THREE.Vector3(...m.boundingSphere.center), m.boundingSphere.radius,
		);
		let material;
		if (m.bitmap && m.uvs) {
			const texture = new THREE.CanvasTexture(m.bitmap);
			// The rocktree UV origin is top-left, as an ImageBitmap stores it.
			texture.flipY = false;
			texture.generateMipmaps = false;
			texture.minFilter = THREE.LinearFilter;
			material = createRocktreeMaterial(liveEdgeUniforms, { map: texture });
		} else {
			material = createRocktreeMaterial(liveEdgeUniforms, { color: 0x808080 });
		}
		const mesh = new THREE.Mesh(geometry, material);
		mesh.name = `rocktree-${path}-${i}`;
		// Static terrain in local ENU metres: the matrix never changes.
		mesh.matrixAutoUpdate = false;
		mesh.updateMatrix();
		built.push({ mesh, colliderPath: `${path}#${i}`, vertices: m.positions, indices: m.indices });
	});
	return built;
}

function disposeLiveNode(path) {
	for (const { colliderPath, mesh } of liveMeshes.get(path) ?? []) {
		scene.remove(mesh);
		mesh.geometry.dispose();
		const map = mesh.material.uniforms?.uMap?.value;
		if (map) { map.dispose(); map.image.close(); }
		mesh.material.dispose();
		physics.removeNodeCollider(colliderPath);
	}
	liveMeshes.delete(path);
}

function processLiveNodeWork(budgetMs = liveQueue.budgetMs()) {
	if (!liveWindow) return;
	liveQueue.drain({
		budgetMs,
		pendingFetches: () => liveWindow.pendingCount(),
		dispose: disposeLiveNode,
		build: (path, job) => {
			const built = buildNodeMesh(path, job.meshes);
			if (liveMeshes.has(path)) disposeLiveNode(path);
			const entries = [];
			liveMeshes.set(path, entries);
			for (const { mesh, colliderPath, vertices, indices } of built) {
				// Collider first: it is the step that can throw.
				physics.addNodeCollider(colliderPath, vertices, indices);
				scene.add(mesh);
				const map = mesh.material.uniforms?.uMap?.value;
				if (map) renderer.initTexture(map);
				entries.push({ colliderPath, mesh });
			}
		},
	});
	physics.flushNodeColliders();
}

// ---------------------------------------------------------------------------
// Flight state

let viewMode = 'fpv';
let chasePos = null;
let chaseYaw = 0;
let paused = false;
let crashed = false;
let crashedAt = 0;
let accumulator = 0;
let lastTime = performance.now();
let groundY = null;
let emitter = { x: 0, y: 0, z: 0 };
const linkState = { distance: 0, blocked: false, span: 0 };
const fenceForce = { x: 0, y: 0, z: 0 };
const _fwd = new THREE.Vector3();
const _camQ = new THREE.Quaternion();
const _tilt = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);

function droneYaw(q) {
	_fwd.set(0, 0, -1).applyQuaternion(q);
	if (Math.hypot(_fwd.x, _fwd.z) > 1e-4) chaseYaw = Math.atan2(_fwd.x, -_fwd.z);
	return chaseYaw;
}

function placeCamera(dt) {
	if (!physics) return;
	const p = physics.position;
	const r = physics.rotation;
	_camQ.set(r.x, r.y, r.z, r.w);
	if (viewMode === 'chase') {
		const desired = chaseTarget(p, droneYaw(_camQ));
		chasePos = chasePos ? chaseStep(chasePos, desired, dt) : desired;
		camera.position.set(chasePos.x, chasePos.y, chasePos.z);
		camera.lookAt(p.x, p.y, p.z);
	} else {
		camera.position.set(p.x, p.y, p.z);
		_tilt.setFromAxisAngle(X_AXIS, CAMERA_TILT * Math.PI / 180);
		camera.quaternion.copy(_camQ).multiply(_tilt);
	}
}

function setView(mode) {
	viewMode = mode === 'chase' ? 'chase' : 'fpv';
	chasePos = null;
	const fov = viewMode === 'chase' ? Math.min(CAMERA_FOV, CHASE.fovDeg) : CAMERA_FOV;
	if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
	placeCamera(0);
}

function respawn() {
	if (!physics) return;
	physics.reset();
	link.reset();
	controller.arm();
	controller.setMode(controller.mode);
	input.resetKeyboardThrottle();
	crashed = false;
	setView('fpv');
}

function togglePause(force) {
	paused = force ?? !paused;
	if (!paused) { accumulator = 0; lastTime = performance.now(); }
	el.osd.classList.toggle('paused', paused);
}

input.onAction = (action, event) => {
	if (action === 'respawn') respawn();
	else if (action === 'pause') { event.preventDefault(); togglePause(); }
	else if (action === 'view') setView(viewMode === 'fpv' ? 'chase' : 'fpv');
	else if (action === 'cyclePreset') controller?.cyclePreset();
	else if (action === 'cycleMode') controller?.cycleMode();
};

// ---------------------------------------------------------------------------
// The frame

function frame() {
	const now = performance.now();
	const dt = Math.min((now - lastTime) / 1000, 0.25);
	lastTime = now;
	const frozen = paused;

	const sticks = input.update(dt, { frozen });
	audio.setMuted(frozen);

	// Streaming is not simulation: it carries on while paused.
	processLiveNodeWork();
	{
		const p = physics.position;
		const ecef = localEnuToEcef(p, liveWindow.originEcef, liveWindow.originBasis);
		const geo = ecefToGeodetic(...ecef);
		if (Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
			liveWindow.update({ lat: geo.lat, lon: geo.lon })
				.catch((err) => console.warn('[rocktree] window recompute failed', err));
		}
	}

	let peakImpact = 0;
	if (!frozen) {
		// Resting on the ground: throttle cut and skimming the surface pins the
		// quad, otherwise a sphere with angular velocity rolls for ever.
		const pp = physics.position;
		const gb = physics.groundBelow(pp.x, pp.y, pp.z);
		const touchdown = controller.armed && sticks.throttle < idleThrottle(physics.profile)
			&& gb !== null && (pp.y - gb) < 0.6;
		physics.setGroundHold(touchdown);

		accumulator += dt;
		const h = catchUpStep(accumulator);
		let steps = 0;
		while (accumulator >= h && steps < MAX_STEPS_PER_FRAME) {
			const { motors } = controller.update(sticks, physics, h);
			if (touchdown) motors.fill(0);
			// The loaded disc has an edge. Past the trusted radius the terrain is
			// not there yet, so a soft push keeps the quad over ground that exists.
			let push = null;
			const c = liveWindow.windowCenterLocal;
			if (c) {
				const dp = physics.position;
				const dx = dp.x - c.x, dz = dp.z - c.z;
				const dist = Math.hypot(dx, dz);
				const a = rocktreeFencePush(dist, liveWindow.nearestTrustedRadius());
				if (a > 0) {
					const len = dist || 1, m = physics.profile.mass;
					fenceForce.x = -(dx / len) * a * m;
					fenceForce.z = -(dz / len) * a * m;
					fenceForce.y = 0;
					push = fenceForce;
				}
			}
			const impact = physics.step(motors, h, push, null);
			if (impact > 0 && !crashed && impact > crashThreshold(physics.rotation)) {
				crashed = true;
				crashedAt = now;
				controller.disarm();
			}
			if (impact > peakImpact) peakImpact = impact;
			accumulator -= h;
			steps++;
		}
		if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;

		// Google Earth terrain has real holes (missing nodes, water). A clean
		// fall with nothing below down to 6 km is one; respawn rather than fall
		// for ever.
		{
			const p = physics.position;
			if (physics.body.linvel().y < -20 && physics.groundBelow(p.x, p.y + 2, p.z, 6000) === null) {
				console.warn('[rocktree] fell through a hole in the map, respawning');
				respawn();
			}
		}
		if (crashed && now - crashedAt > RESPAWN_AFTER_MS) respawn();

		const fp = physics.position;
		groundY = physics.groundBelow(fp.x, fp.y, fp.z);
		placeCamera(dt);
	}

	skyDome.update(camera, frozen ? 0 : dt);

	// The terrain's edge fade follows the streaming window.
	if (liveWindow.windowCenterLocal) {
		const { x, z } = liveWindow.windowCenterLocal;
		const radius = liveWindow.loadRadiusM();
		liveEdgeUniforms.uWindowCenter.value.set(x, z);
		liveEdgeUniforms.uLoadRadiusM.value = radius;
		liveEdgeUniforms.uEdgeFadeM.value = edgeFadeForRadius(radius);
	}
	liveEdgeUniforms.uFogDensity.value = scene.fog.density;
	liveEdgeUniforms.uEyeY.value = physics.position.y;

	// The video link: distance and occlusion from the pilot's antenna decide
	// how much of the picture survives.
	const p = physics.position;
	const shadow = physics.obstructionBetween(emitter.x, emitter.y, emitter.z, p.x, p.y, p.z);
	linkState.distance = Math.hypot(p.x - emitter.x, p.y - emitter.y, p.z - emitter.z);
	linkState.blocked = shadow.blocked;
	linkState.span = shadow.span;
	link.update({ distance: linkState.distance, blocked: shadow.blocked, span: shadow.span, dt });

	const linkOut = crashed ? DEAD_LINK : link.out;
	lens.render(camera, dt, viewMode === 'chase' ? null : linkOut);

	if (!frozen) {
		const prop = physics.propulsion;
		audio.update({ omega: prop.omega, thrust: prop.thrust, airspeed: physics.airspeed, propwash: prop.propwash });
		if (peakImpact > 0) audio.playImpact(peakImpact);
	}

	updateOsd(sticks);
}

let osdTick = 0;
function updateOsd(sticks) {
	// Ten times a second is plenty for text.
	if (++osdTick % 6) return;
	const v = physics.velocity;
	const speed = Math.hypot(v.x, v.y, v.z);
	const agl = groundY === null ? null : physics.position.y - groundY;
	const bat = physics.battery;
	el.osdLeft.textContent = [
		controller.mode.toUpperCase(),
		RATE_PRESETS[controller.preset].label,
		input.usingGamepad ? 'RADIO' : 'KEYS',
		crashed ? 'CRASH' : controller.armed ? 'ARMED' : 'DISARMED',
	].join('  ·  ');
	el.osdRight.textContent = [
		`${(speed * 3.6).toFixed(0)} km/h`,
		agl === null ? '' : `${agl.toFixed(1)} m`,
		`${bat.voltage.toFixed(1)} V`,
		`THR ${(sticks.throttle * 100).toFixed(0)}%`,
	].filter(Boolean).join('  ·  ');
}

// ---------------------------------------------------------------------------
// Boot

async function boot([lat, lon]) {
	// Three latencies overlapped: Rapier's WASM, the first tile traverse, and
	// the worker start-up.
	const physicsReady = initPhysics();
	warmUpTraverseWorker();
	warmUpNodePool();

	liveWindow = new RocktreeWindow({
		level: ROCKTREE_LEVEL,
		origin: { lat, lon },
		floorRadiusM: VIEW_RANGE_M,
		onNodeReady: (path, matrix, meshes, sphereRadius) => {
			liveQueue.queueBuild(path, { matrix, meshes, sphereRadius }, { swap: liveMeshes.has(path) });
		},
		onNodeReleased: (path, opts) => {
			if (opts?.replaced) return;
			if (opts?.covered && liveMeshes.has(path)) { liveQueue.queueCovered(path); return; }
			if (!liveMeshes.has(path)) { liveQueue.dropBuild(path); return; }
			liveQueue.queueRelease(path);
		},
	});
	const firstWave = liveWindow.update({ lat, lon });

	await physicsReady;
	const emptyCollision = { vertices: new Float32Array(0), indices: new Uint32Array(0) };
	// Provisional height: the real spawn is set on the real ground below.
	physics = new Physics(emptyCollision, { x: 0, y: 80, z: 0 }, { profile: PROFILE });
	physics.reset();
	audio.setProfile(physics.profile);
	await firstWave;

	// Wait for the ground under the spawn and for the first wave to settle, so
	// the quad is put down on terrain that exists.
	const deadline = performance.now() + BOOT_DEADLINE_MS;
	let groundHere = null;
	for (;;) {
		processLiveNodeWork(25);
		if (groundHere === null) groundHere = physics.groundBelow(0, 3000, 0, 6000);
		const pending = liveWindow.pendingCount();
		const waveDone = pending === 0 && liveQueue.idle();
		if (groundHere !== null && waveDone) break;
		bootStatus('Reaching the terrain', `${pending} tiles in flight, ${groundHere === null ? 'no ground yet' : 'ground found'}`);
		if (performance.now() > deadline) {
			if (groundHere === null) throw new Error('No terrain arrived for this place. Google Earth has no 3D coverage here, or the tile server is blocked.');
			console.warn(`[rocktree] boot released at the deadline, ${pending} fetches still in flight`);
			break;
		}
		await new Promise((r) => setTimeout(r, 10));
	}

	physics.spawn.y = groundHere + SPAWN_ABOVE_GROUND_M;
	physics.reset();
	emitter = { x: 0, y: groundHere + ANTENNA_HEIGHT, z: 0 };
	controller = new FlightController({ profile: PROFILE });

	setView('fpv');
	renderer.compile(scene, camera);
	el.boot.hidden = true;
	el.osd.hidden = false;
	// Google requires its imagery credited wherever it is shown.
	el.credit.hidden = false;
	window.__sim = { physics, controller, input, liveWindow, respawn };
	lastTime = performance.now();
	renderer.setAnimationLoop(frame);
}

boot(AT).catch(bootFail);
