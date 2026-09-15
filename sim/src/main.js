// FPV Real: pick a place on Earth, fly it with your radio, in the browser.
//
// The flight stack (input, controller, airframe, physics) and the terrain
// streaming come from FPVThePlanet by lionrayonnant, AGPL-3.0. This file is
// the shell around them: the map, the boot, the flight loop, respawn. Nothing
// here knows the airframe, the controller or the radio; those modules keep
// their upstream boundaries so fixes can be pulled in.

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
import { pickPlace, saveLastPlace } from './map.js';
import { Setup, loadTilt, loadRates, saveRates, loadFeel } from './setup.js';
import { findSpawn, yawQuaternion } from './spawn.js';
import { loadSceneManifest, loadSplat, ghostLine, pathStart } from './scene-splat.js';

// ---------------------------------------------------------------------------
// Constants

// Google Earth octree level. 21 is street-level photogrammetry; measured
// upstream as the level that keeps a 600 m window under budget.
const ROCKTREE_LEVEL = 21;
// The disc of terrain kept loaded around the quad, in metres.
const VIEW_RANGE_M = 600;
// Spawn height over the ground the search picked. Low: a racing pilot arms on
// the pad, not in a fall.
const SPAWN_ABOVE_GROUND_M = 0.5;
// The pilot stands at the pad; the video antenna is at head height. The link
// model degrades with distance and occlusion from here.
const ANTENNA_HEIGHT = 1.2;
// FPV camera: field of view and default uptilt, in degrees.
const CAMERA_FOV = 120;
const CAMERA_TILT = 25;
// The smooth feel's camera filter: how long the picture takes to catch up
// with the frame. Short enough that a flick still reads as a flick, long
// enough to swallow anything above ~8 Hz, where nausea lives.
const CAMERA_TAU_S = 0.045;
// Shutter for each feel, seconds. Short means less smear on a fast pan.
const SHUTTER_S = { smooth: 0.003, real: 0.008 };
// After a crash the picture dies, then you are back on the pad.
const RESPAWN_AFTER_MS = 700;
// How long to wait for the first wave of terrain before giving up.
const BOOT_DEADLINE_MS = 45000;
// Family flown. freestyle5 is the 5-inch reference airframe upstream tuned.
const PROFILE = PROFILES.freestyle5;
// Rates everyone starts on until they pick their own.
const DEFAULT_RATES = 'cinematic';
// The picture the goggles show once the link is gone.
const DEAD_LINK = { quality: 0, rssiDbm: -100, lossDb: 999, frozen: true };
const ZERO = { x: 0, y: 0, z: 0 };
// 'smooth' or 'real', see setup.js. Read before the lens is built: the
// shutter depends on it.
let feel = loadFeel();

// ---------------------------------------------------------------------------
// Screen

// The imagery already carries its own light and colour: the whole pipeline is
// pass-through. With colour management on, Three would re-encode the sky.
THREE.ColorManagement.enabled = false;

const ui = document.getElementById('ui');
ui.insertAdjacentHTML('beforeend', `
	<div id="boot" hidden>
		<p id="boot-title">FPV REAL</p>
		<p id="boot-status"></p>
		<p id="boot-detail"></p>
		<button id="boot-back" type="button" hidden>PICK ANOTHER PLACE</button>
	</div>
	<div id="osd" hidden>
		<span id="osd-left"></span>
		<span id="osd-hint"></span>
		<span id="osd-right"></span>
	</div>
	<p id="credit" hidden>Imagery © Google</p>
`);
const el = {
	boot: ui.querySelector('#boot'),
	status: ui.querySelector('#boot-status'),
	detail: ui.querySelector('#boot-detail'),
	back: ui.querySelector('#boot-back'),
	osd: ui.querySelector('#osd'),
	osdLeft: ui.querySelector('#osd-left'),
	osdHint: ui.querySelector('#osd-hint'),
	osdRight: ui.querySelector('#osd-right'),
	credit: ui.querySelector('#credit'),
};
el.back.addEventListener('click', () => { location.href = location.pathname; });

function bootStatus(text, detail = '') {
	el.boot.hidden = false;
	el.status.textContent = text;
	el.detail.textContent = detail;
}
function bootFail(err) {
	console.error(err);
	el.boot.classList.add('failed');
	bootStatus(String(err?.message ?? err), '');
	el.back.hidden = false;
	try { el.back.focus(); } catch { /* focus is never load-bearing */ }
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
// The terrain edge dissolves into this fog rather than stopping dead.
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
renderer.domElement.hidden = true;
document.body.appendChild(renderer.domElement);

const input = new Input();
const audio = new EngineAudio();
const lens = new FpvLens(renderer, scene);
const link = new VideoLink();
lens.setEnabled(true);
lens.setParams({ lens: 0.6, vignette: 0.5, shutter: SHUTTER_S[feel] });
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
let cameraTilt = loadTilt(CAMERA_TILT);
let cameraSmoothed = false;
let spawnPoint = { x: 0, y: 0, z: 0 };
let spawnQuat = { x: 0, y: 0, z: 0, w: 1 };
let emitter = { x: 0, y: 0, z: 0 };
// With an arm switch, a respawn wants the switch seen OFF once before it arms
// again, the way a flight controller does. Without one, the pad arms itself.
let armLatch = false;
let hint = '';
let lastDevice = null;
const linkState = { distance: 0, blocked: false, span: 0 };
const fenceForce = { x: 0, y: 0, z: 0 };
const _fwd = new THREE.Vector3();
const _camQ = new THREE.Quaternion();
const _camSmooth = new THREE.Quaternion();
const _tilt = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);

function applyFeel(name) {
	feel = name;
	physics?.setShake(feel === 'real' ? 1 : 0);
	lens.setParams({ lens: 0.6, vignette: 0.5, shutter: SHUTTER_S[feel] });
	cameraSmoothed = false;
}

const setup = new Setup(ui, input, {
	tilt: cameraTilt,
	feel,
	onTilt: (deg) => { cameraTilt = deg; },
	onRates: (name) => setRates(name),
	onFeel: (name) => applyFeel(name),
	getController: () => controller,
});

function deviceId() {
	return input.usingGamepad ? (input.activePadId() ?? 'gamepad') : 'keyboard';
}

function setRates(name) {
	if (!controller) return;
	controller.setPreset(name);
	saveRates(deviceId(), controller.preset);
}

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
		_tilt.setFromAxisAngle(X_AXIS, cameraTilt * Math.PI / 180);
		if (feel === 'smooth') {
			// A first-order filter on the orientation alone: the position stays
			// bolted to the body so the picture never floats off the machine.
			if (!cameraSmoothed || dt <= 0) { _camSmooth.copy(_camQ); cameraSmoothed = true; }
			else _camSmooth.slerp(_camQ, 1 - Math.exp(-dt / CAMERA_TAU_S));
			camera.quaternion.copy(_camSmooth).multiply(_tilt);
		} else {
			camera.quaternion.copy(_camQ).multiply(_tilt);
		}
	}
}

function setView(mode) {
	viewMode = mode === 'chase' ? 'chase' : 'fpv';
	chasePos = null;
	const fov = viewMode === 'chase' ? Math.min(CAMERA_FOV, CHASE.fovDeg) : CAMERA_FOV;
	if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
	placeCamera(0);
}

// Back on the pad, nose where the search pointed it, motors primed.
function placeOnPad() {
	physics.applyEntryState({ position: spawnPoint, quaternion: spawnQuat, linvel: ZERO, angvel: ZERO });
}

function respawn() {
	if (!physics) return;
	placeOnPad();
	cameraSmoothed = false;
	link.reset();
	controller.setMode(controller.mode);
	input.resetKeyboardThrottle();
	crashed = false;
	// A mapped switch re-arms on its own once it has been seen off; the pad
	// arms itself for everyone else.
	if (input.sticks.arm === null) controller.arm();
	else { controller.disarm(); armLatch = true; }
	setView('fpv');
}

function togglePause(force) {
	paused = force ?? !paused;
	if (!paused) { accumulator = 0; lastTime = performance.now(); }
	el.osd.classList.toggle('paused', paused);
}

input.onAction = (action, event) => {
	if (action === 'tab') { event.preventDefault(); setup.toggle(); if (!setup.open) { accumulator = 0; lastTime = performance.now(); } }
	else if (action === 'escape' && setup.open) setup.toggle(false);
	else if (!controller) return;
	else if (action === 'respawn') respawn();
	else if (action === 'pause') { event.preventDefault(); togglePause(); }
	else if (action === 'view') setView(viewMode === 'fpv' ? 'chase' : 'fpv');
	else if (action === 'cyclePreset') { controller.cyclePreset(); saveRates(deviceId(), controller.preset); }
	else if (action === 'cycleMode') controller.cycleMode();
};

// The arm switch decides, when there is one. The refusal to arm with the
// throttle up is what a flight controller does, and for the same reason.
function applyArmSwitch(sticks) {
	const sw = sticks.arm;
	if (sw === null) {
		hint = input.usingGamepad ? '' : 'KEYS · plug in a radio and move a stick';
		if (!controller.armed && !crashed) controller.arm();
		return;
	}
	if (sw === false) armLatch = false;
	if (crashed) return;
	if (sw && !controller.armed) {
		if (armLatch) hint = 'FLIP THE ARM SWITCH OFF, THEN ON';
		else if (sticks.throttle > idleThrottle(physics.profile)) hint = 'THROTTLE DOWN TO ARM';
		else { controller.arm(); hint = ''; }
	} else if (!sw && controller.armed) {
		controller.disarm();
		hint = '';
	} else {
		hint = controller.armed ? '' : 'ARM SWITCH TO FLY';
	}
}

// ---------------------------------------------------------------------------
// The frame

function frame() {
	const now = performance.now();
	const dt = Math.min((now - lastTime) / 1000, 0.25);
	lastTime = now;
	const frozen = paused || setup.open;

	// One read for the frame's bookkeeping (dt 0: the keyboard ramps only
	// inside the substeps below, once per step, so it is never counted twice).
	let sticks = input.update(0, { frozen });
	audio.setMuted(frozen);

	// Rates follow the device in the pilot's hands.
	const dev = deviceId();
	if (dev !== lastDevice) {
		lastDevice = dev;
		const saved = loadRates(dev);
		if (saved) controller.setPreset(saved);
	}

	// Streaming is not simulation: it carries on while paused.
	processLiveNodeWork();
	if (liveWindow) {
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
		applyArmSwitch(sticks);

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
			// The sticks are read again for every 250 Hz step, so a snapshot that
			// arrived mid-frame is flown on the step after it, not the frame after.
			sticks = input.update(h);
			const { motors } = controller.update(sticks, physics, h);
			if (touchdown) motors.fill(0);
			// The loaded disc has an edge. Past the trusted radius the terrain is
			// not there yet, so a soft push keeps the quad over ground that exists.
			let push = null;
			const c = liveWindow?.windowCenterLocal;
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
	if (liveWindow?.windowCenterLocal) {
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
	el.osdHint.textContent = hint;
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
	if (navigator.onLine === false) {
		throw new Error('You are offline. The terrain streams from Google Earth and needs a connection.');
	}
	bootStatus('Reaching the terrain', `${lat.toFixed(5)}, ${lon.toFixed(5)}`);
	renderer.domElement.hidden = false;

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
	// Provisional: the real spawn is set on real ground below.
	physics = new Physics(emptyCollision, { x: 0, y: 80, z: 0 }, { profile: PROFILE, shake: feel === 'real' ? 1 : 0 });
	physics.reset();
	audio.setProfile(physics.profile);
	await firstWave;

	// Wait for the first wave to settle, so the pad search sees terrain that
	// exists. Past the deadline, fly with what is there.
	const deadline = performance.now() + BOOT_DEADLINE_MS;
	let groundHere = null;
	for (;;) {
		processLiveNodeWork(25);
		if (groundHere === null) groundHere = physics.groundBelow(0, 3000, 0, 6000);
		const pending = liveWindow.pendingCount();
		const waveDone = pending === 0 && liveQueue.idle();
		if (waveDone) break;
		bootStatus('Reaching the terrain', `${pending} tiles in flight, ${groundHere === null ? 'no ground yet' : 'ground found'}`);
		if (performance.now() > deadline) {
			console.warn(`[rocktree] boot released at the deadline, ${pending} fetches still in flight`);
			break;
		}
		await new Promise((r) => setTimeout(r, 10));
	}

	settleOnPad({
		origin: { x: 0, z: 0 },
		top: (groundHere ?? 0) + 500,
		reach: 6000,
		noPad: 'No terrain arrived for this place. Google Earth has no 3D coverage here, or the tile server is blocked.',
		// Google requires its imagery credited wherever it is shown.
		credit: 'Imagery © Google',
	});
}

// A scene built from a video (pipeline/): the splat is the picture, its
// triangles are the ground, and the line is the pilot who flew it.
async function bootScene(url) {
	bootStatus('Opening the scene', url);
	renderer.domElement.hidden = false;
	const physicsReady = initPhysics();
	const manifest = await loadSceneManifest(url);
	const { json } = manifest;
	bootStatus('Opening the scene', json.name);

	await physicsReady;
	const start = pathStart(json);
	physics = new Physics(manifest.collision, { x: start.x, y: start.y, z: start.z }, { profile: PROFILE, shake: feel === 'real' ? 1 : 0 });
	physics.reset();
	audio.setProfile(physics.profile);

	const splat = loadSplat(manifest, renderer, scene, (p) => {
		bootStatus('Opening the scene', `${json.name}, ${(p * 100).toFixed(0)}% of the splat`);
	});
	scene.add(ghostLine(json));
	scene.fog.density = 0;
	try {
		await splat.ready;
	} catch (err) {
		throw new Error(`The splat did not load: ${err?.message ?? err}`);
	}

	settleOnPad({
		origin: { x: start.x, z: start.z },
		top: start.y + 30,
		reach: 200,
		noPad: 'No ground under the pilot\'s first frame. The scale or the up vector in scene.json is off; rerun the pipeline with --speed.',
		credit: `Scene: ${json.credit}`,
	});
}

// The end of every boot: a pad near the origin, the controller, the OSD.
function settleOnPad({ origin, top, reach, noPad, credit }) {
	bootStatus('Finding a pad', '');
	const pad = findSpawn({
		groundBelow: (x, y, z, d) => physics.groundBelow(x, y, z, d),
		obstructionBetween: (...a) => physics.obstructionBetween(...a),
		origin,
		top,
		reach,
	});
	if (!pad) throw new Error(noPad);
	spawnPoint = { x: pad.x, y: pad.y + SPAWN_ABOVE_GROUND_M, z: pad.z };
	spawnQuat = yawQuaternion(pad.yaw);
	physics.spawn.x = spawnPoint.x; physics.spawn.y = spawnPoint.y; physics.spawn.z = spawnPoint.z;
	emitter = { x: pad.x, y: pad.y + ANTENNA_HEIGHT, z: pad.z };
	// A radio starts in acro. Keys start self-levelled: for someone here to
	// look at a place, not to race it, angle mode is the fun one. M cycles.
	// Cinematic rates to start: half the stick sensitivity of the freestyle
	// preset upstream defaults to, which is a racer's setting. P cycles, Tab
	// picks, and the choice is remembered per radio.
	controller = new FlightController({
		profile: PROFILE,
		mode: input.getGamepad() ? 'acro' : 'angle',
		preset: DEFAULT_RATES,
	});
	placeOnPad();
	console.log(`[spawn] pad at ${pad.x.toFixed(1)}, ${pad.z.toFixed(1)}, ground ${pad.y.toFixed(1)} m, clearance ${pad.clearance} m`);

	setView('fpv');
	renderer.compile(scene, camera);
	el.boot.hidden = true;
	el.osd.hidden = false;
	el.credit.textContent = credit;
	el.credit.hidden = false;
	window.__sim = { physics, controller, input, liveWindow, respawn, pad };
	lastTime = performance.now();
	renderer.setAnimationLoop(frame);
}

// ---------------------------------------------------------------------------
// Start: a place in the URL flies at once, otherwise the map asks for one.

async function start() {
	const params = new URLSearchParams(location.search);
	if (params.has('scene')) {
		await bootScene(params.get('scene'));
		return;
	}
	let at = null;
	if (params.has('at')) {
		at = params.get('at').split(',').map(Number);
		if (at.length !== 2 || !at.every(Number.isFinite)) {
			throw new Error(`?at= expects "lat,lon", got "${params.get('at')}"`);
		}
	} else {
		const place = await pickPlace(ui);
		at = [place.lat, place.lon];
		history.replaceState(null, '', `?at=${place.lat.toFixed(6)},${place.lon.toFixed(6)}`);
	}
	saveLastPlace({ lat: at[0], lon: at[1] });
	await boot(at);
}

start().catch(bootFail);
