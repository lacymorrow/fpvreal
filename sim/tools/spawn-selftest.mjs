import assert from 'node:assert/strict';
import { findSpawn, yawQuaternion, RINGS, EYE_M, SLOPE_MAX } from '../src/spawn.js';

let n = 0;
function pass(label) { n++; console.log(`  PASS  ${label}`); }

// A fake world: flat ground at height 0, a building occupying x in [-40, -8]
// at 20 m tall, and a wall along z = +15 for x in [-50, 50].
function world({ buildings = [], groundAt = () => 0 } = {}) {
	const inside = (x, y, z) => buildings.some((b) =>
		x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && y >= groundAt(x, z) && y <= groundAt(x, z) + b.h);
	return {
		groundBelow: (x, y, z) => {
			// The roof if the ray starts above a building, else the ground.
			for (const b of buildings) {
				if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) {
					const roof = groundAt(x, z) + b.h;
					if (y >= roof) return roof;
				}
			}
			const g = groundAt(x, z);
			return y >= g ? g : null;
		},
		obstructionBetween: (ax, ay, az, bx, by, bz) => {
			// Sample the segment.
			for (let t = 0; t <= 1; t += 0.05) {
				const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
				if (inside(x, y, z)) return { blocked: true, span: 0 };
				if (y < groundAt(x, z)) return { blocked: true, span: 0 };
			}
			return { blocked: false, span: 0 };
		},
	};
}

// 1. an empty field: the pin itself wins, any heading is fine
{
	const w = world();
	const s = findSpawn({ ...w, origin: { x: 0, z: 0 } });
	assert.ok(s);
	assert.equal(s.x, 0); assert.equal(s.z, 0); assert.equal(s.y, 0);
	assert.equal(s.clearance, 60);
	pass('an open field spawns on the pin with 60 m of clearance all round');
}

// 2. the pin is on a roof: the search comes down to the street
{
	const w = world({ buildings: [{ x0: -10, x1: 10, z0: -10, z1: 10, h: 20 }] });
	const s = findSpawn({ ...w, origin: { x: 0, z: 0 } });
	assert.equal(s.y, 0, 'ground level, not the roof');
	assert.ok(Math.hypot(s.x, s.z) >= 12, `moved off the building: ${s.x.toFixed(1)}, ${s.z.toFixed(1)}`);
	pass('a pin on a roof spawns on the street beside the building, not on the roof');
}

// 3. a wall just north of the pin and a second one behind it: the pad stays
//    south of the first wall and the nose points south, away from both
{
	const w = world({ buildings: [
		{ x0: -60, x1: 60, z0: -4, z1: -2, h: 10 },
		{ x0: -60, x1: 60, z0: -14, z1: -12, h: 10 },
	] });
	const s = findSpawn({ ...w, origin: { x: 0, z: 0 } });
	assert.ok(s.z > -2, `pad stays south of the wall, z ${s.z.toFixed(1)}`);
	// -Z is north (yaw 0); south is yaw pi.
	const dz = -Math.cos(s.yaw);
	assert.ok(dz > 0.5, `nose points south, yaw ${s.yaw.toFixed(2)}`);
	pass('with walls to the north the pad stays south of them and the nose faces the open side');
}

// 3b. the pin is on a hillside: the pad moves to the flat ground beside it
{
	// Ground climbs 0.5 m per metre for x < 0, flat for x >= 0.
	const w = world({ groundAt: (x) => (x < 0 ? -0.5 * x : 0) });
	const s = findSpawn({ ...w, origin: { x: -6, z: 0 } });
	assert.ok(s.x >= 0, `pad on the flat side, x ${s.x.toFixed(1)}`);
	assert.ok(s.slope <= SLOPE_MAX, `slope ${s.slope.toFixed(2)}`);
	pass('a pin on a 50 % hillside spawns on the flat ground beside it');
}

// 4. no ground anywhere: null, not a crash
{
	const s = findSpawn({ groundBelow: () => null, obstructionBetween: () => ({ blocked: false }), origin: { x: 0, z: 0 } });
	assert.equal(s, null);
	pass('a pin over nothing (sea, missing tiles) returns null');
}

// 5. the quaternion for yaw 0 is identity, for pi is a half turn about Y
{
	assert.deepEqual(yawQuaternion(0), { x: 0, y: 0, z: 0, w: 1 });
	const q = yawQuaternion(Math.PI);
	assert.ok(Math.abs(q.y - 1) < 1e-9 && Math.abs(q.w) < 1e-9);
	pass('yawQuaternion is identity at 0 and a half turn about Y at pi');
}

// 6. the search budget is bounded
{
	let rays = 0;
	const w = world();
	findSpawn({
		groundBelow: (...a) => { rays++; return w.groundBelow(...a); },
		obstructionBetween: (...a) => { rays++; return w.obstructionBetween(...a); },
	});
	const points = RINGS.reduce((s, r) => s + r.n, 0);
	assert.ok(rays <= points * (5 + 8 * 6), `${rays} rays for ${points} points`);
	pass(`the search casts at most ${points * 53} rays (${rays} on an open field), eye at ${EYE_M} m`);
}

console.log(`spawn: ${n} checks, all PASS`);
