// Where to put the quad down. Pure: the two raycasts come in as functions,
// so the search runs against a fake world in its selftest and against
// Rapier in flight.
//
// The pin is a point on a map; the ground under it can be a roof, a wall or
// a tree. The search walks rings around the pin, asks for the ground at each
// point, then asks how far it can see horizontally from a metre above that
// ground. The winner is the most open point, with a preference for low
// ground: a street is low and open, a roof is high and open, a courtyard is
// low and closed.

// Rings around the pin, in metres, and how many points on each.
export const RINGS = [
	{ r: 0, n: 1 },
	{ r: 6, n: 8 },
	{ r: 12, n: 8 },
	{ r: 20, n: 12 },
	{ r: 30, n: 12 },
];
// The distances tried along each of the 8 horizontal directions. The clearance
// of a direction is the longest one that is not blocked. The last two are what
// tell a runway from a courtyard: two directions both clear at 30 m still
// differ at 60.
export const REACH_M = [2, 5, 10, 20, 35, 60];
// Eye height for the horizontal rays: a quad on its pad, seen from its camera.
export const EYE_M = 1.0;
// How much a metre of ground height above the lowest candidate costs, in
// metres of clearance. Within a 30 m ring, 20 m of rise is a building, not a
// hill, and a roof must lose to the street beside it even though the roof is
// open on every side and the street has a wall on one.
export const HEIGHT_WEIGHT = 1.5;
// The pad has to be flat: the ground is probed this far around each point,
// and a rise or drop steeper than SLOPE_MAX over that distance rules it out.
// A quad put down on a slope rolls, and a photogrammetry hillside or a
// stairway reads as ground to a raycast.
export const FLAT_PROBE_M = 1.2;
export const SLOPE_MAX = 0.25;
// Metres of clearance a full SLOPE_MAX of tilt costs.
export const SLOPE_WEIGHT = 12;

const DIRS = Array.from({ length: 8 }, (_, i) => {
	const a = (i / 8) * 2 * Math.PI;
	return { x: Math.sin(a), z: -Math.cos(a), yaw: a };
});

// groundBelow(x, y, z, maxDistance) -> ground height or null.
// obstructionBetween(ax, ay, az, bx, by, bz) -> { blocked }.
// top: a height known to be above everything at the pin; reach: how far down
// to look from there.
export function findSpawn({ groundBelow, obstructionBetween, origin = { x: 0, z: 0 }, top = 3000, reach = 6000 }) {
	const candidates = [];
	for (const ring of RINGS) {
		for (let i = 0; i < ring.n; i++) {
			const a = (i / ring.n) * 2 * Math.PI;
			const x = origin.x + ring.r * Math.sin(a);
			const z = origin.z - ring.r * Math.cos(a);
			const g = groundBelow(x, top, z, reach);
			if (g === null || !Number.isFinite(g)) continue;
			// Flatness: the worst rise or drop across the pad, as a grade.
			let slope = 0;
			for (const [dx, dz] of [[FLAT_PROBE_M, 0], [-FLAT_PROBE_M, 0], [0, FLAT_PROBE_M], [0, -FLAT_PROBE_M]]) {
				const gg = groundBelow(x + dx, top, z + dz, reach);
				if (gg === null || !Number.isFinite(gg)) { slope = Infinity; break; }
				slope = Math.max(slope, Math.abs(gg - g) / FLAT_PROBE_M);
			}
			if (slope > SLOPE_MAX) continue;
			candidates.push({ x, z, g, slope });
		}
	}
	if (candidates.length === 0) return null;

	const gMin = Math.min(...candidates.map((c) => c.g));
	let best = null;
	for (const c of candidates) {
		const y = c.g + EYE_M;
		const reach = DIRS.map((d) => {
			let r = 0;
			for (const m of REACH_M) {
				if (obstructionBetween(c.x, y, c.z, c.x + d.x * m, y, c.z + d.z * m).blocked) break;
				r = m;
			}
			return r;
		});
		const mean = reach.reduce((a, b) => a + b, 0) / reach.length;
		// The nose goes where it is open AND the neighbours are open: a gap
		// between two walls is not a runway.
		let bestDir = 0, bestOpen = -1;
		for (let i = 0; i < DIRS.length; i++) {
			const open = reach[i] + 0.5 * (reach[(i + 7) % 8] + reach[(i + 1) % 8]);
			if (open > bestOpen) { bestOpen = open; bestDir = i; }
		}
		// Open beats closed, low beats high, and the pin itself wins a tie: the
		// rings are walked outward and only a strictly better point replaces it.
		const score = mean + 0.5 * reach[bestDir] - HEIGHT_WEIGHT * (c.g - gMin) - SLOPE_WEIGHT * (c.slope / SLOPE_MAX);
		if (!best || score > best.score) {
			best = { x: c.x, y: c.g, z: c.z, yaw: DIRS[bestDir].yaw, clearance: Math.min(...reach), slope: c.slope, score };
		}
	}
	return best;
}

// The body quaternion for a yaw about +Y. yaw = 0 is the nose toward -Z, the
// direction the flight camera looks by default.
export function yawQuaternion(yaw) {
	return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}
