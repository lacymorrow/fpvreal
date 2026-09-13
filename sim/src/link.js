// The 5.8 GHz video link, as a link budget in dB.
//
// No Rapier, no DOM, no three: this file only knows how far the drone is from
// the pilot and what sits on the straight line between them. Whoever measures
// those numbers is somebody else's problem
// (physics.js casts the rays, main.js wires it up) — same split as quad.js and
// flightController.js, and the reason this can be checked in tools/selftest.mjs
// without a browser.
//
// Everything below is dB because that is the only scale on which "twice as far"
// and "through a wall" are the same kind of quantity and can simply be added.

// Free-space reference distance. Loss is 0 dB here and climbs 20 dB per decade
// (20*log10(d/d0)) beyond it, which is plain inverse-square in field terms.
const D0 = 10;

// Where the picture starts to go, and where it is gone. The gap between them is
// the whole fade, so it is what sets how gradual the degradation looks.
//
// Calibrated for a continuous slide rather than a cliff. The fade is
// deliberately WIDE (58 dB between the first visible degradation and no picture
// at all). A narrow fade makes every dB matter, and since the geometry hands us
// large steps — you round a corner and a whole building appears on the path — a
// narrow fade turns those steps into an on/off switch.
//
// The band starts at 24 dB, up from 18. Note what it is a band OVER: since the
// playability work removed distance from the quality calculation, the only
// things that feed it are obstruction and the target's own advertised signal.
// Distance is cosmetic now, so the old comment here — "18 dB, which is about
// 80 m" — described a coupling that no longer exists. Flying far in clear air
// costs nothing; flying behind things costs.
//
// 18 dB meant the picture was never quite clean over a real city, and a
// degradation that is always present stops being information. 24 leaves
// ordinary flight clean and keeps the warning for when there is something to
// warn about.
//
// The two move TOGETHER. geofence.js hardcodes FENCE_SPAN = 58 and relies on it
// being exactly LOSS_DEAD - LOSS_CLEAN: the fence's terminal loss is what takes
// quality to 0 when you leave the zone, and a different span would leave it
// short. Change one of these and you must change the other by the same amount,
// or change FENCE_SPAN with them.
const LOSS_CLEAN = 24;
const LOSS_DEAD = 82;

// Blocked at all, before any depth is counted. A ridge line or a thin roof is
// a single sheet of geometry with no far face, so its measured depth is
// honestly zero — and yet standing behind a hill costs you the link. This is
// the diffraction term: the signal bends around the edge and arrives weakened.
// 6 dB rather than 8: over a city almost every metre of flight has something on
// the path, so this term is paid nearly all the time, and it was setting a floor
// of permanent degradation rather than marking an event.
const KNIFE_EDGE_DB = 6;

// Depth of material, saturating rather than linear. A flat dB-per-metre was the
// single biggest source of "fine, fine, gone": rounding a corner takes the span
// from 0 to 10+ m between one frame and the next, and at 8 dB/m that is 80 dB
// in one step — every building an instant kill, no matter how far away or how
// thin. Saturating means the first few metres carry most of the cost, which is
// also closer to the truth: the signal is already deep in the noise after one
// wall, and the ninth wall cannot take much more away than the second did.
// The asymptote is 26 dB rather than 38. Behind a whole building at 150 m that
// is the difference between quality ~0.19 — frozen in digital, unflyable in
// analog — and ~0.55, which reads as a link in trouble that you can still fly
// out of. The saturating shape is unchanged; only how much it can ever cost is.
const OBSTRUCTION_DB = 26;    // asymptote, for a span much deeper than the scale
const OBSTRUCTION_SCALE = 14; // metres at which 63% of it has been paid

// Received power at D0 with nothing in the way. Only used to report a number
// that looks like an RSSI; it plays no part in the quality calculation. Puts
// the cliff at -95 dBm, which is about where a real 5.8 GHz receiver gives up.
const RSSI_REF_DBM = -35;

// How much of the target's advertised weakness actually reaches the picture.
//
// This term, not obstruction, was the real driver of "the jamming is too
// strong". Targets are generated at -52..-72 dBm (tools/target-model.mjs), so
// against a reference of -35 the weakest one starts the budget 37 dB down —
// before a single building is on the path. With the band starting at 18 dB
// that target was already degraded hovering in clear air, and one 30 m
// building took it to quality 0: dead picture, from geometry the pilot could
// not have avoided.
//
// Halving it keeps the fiction intact — the target list still advertises the
// same dBm, and a weak target is still visibly worse to fly — while making the
// worst draw survivable. Worst case now: clean in the open, about 0.60 behind
// a 30 m building, which is degraded and flyable rather than gone.
//
// Halved here rather than by narrowing the generator's range, because that
// range is PHASE 08 fiction with golden fixtures pinned in
// tools/target-selftest.mjs, and the number a player reads on the target list
// should stay the number the designer chose.
const BASE_LOSS_WEIGHT = 0.5;

// Asymmetric, because that is what a diversity receiver does: it loses lock
// almost immediately and takes its time coming back. Symmetric smoothing makes
// flying back out from behind a building feel instant and wrong.
// Slow enough to read as a fade. These are doing more work than they look like:
// the geometry is a step function — the wall is either on the path or it is not
// — so these time constants are the only thing standing between "a link that
// fades" and "a switch". At 0.05 s the drop was over in three frames, which is
// exactly the "pouf" it felt like.
const TAU_FALL = 0.30;
const TAU_RISE = 0.70;

// Amplitude of the idle wander, in dB. Without it the RSSI readout is perfectly
// still in a hover, which no radio ever is.
const NOISE_DB = 1.5;
const NOISE_TAU = 0.25;

// Digital receivers do not fade, they hold the last good frame and then drop
// it. Two thresholds and not one: at a single threshold the picture strobes
// between frozen and clean while you hover on the boundary.
const FREEZE_ENTER = 0.18;
const FREEZE_LEAVE = 0.28;

// Playability bounds on the jamming (issue #79). Below BLACKOUT_Q the screen is
// effectively dead; it may stay there at most BLACKOUT_MAX_S, after which the
// link is pinned above COOLDOWN_FLOOR_Q (clear of FREEZE_LEAVE, so no freeze)
// for COOLDOWN_S before another blackout can arm. SPREAD_COSMETIC_MAX caps the
// distance term that now only decorates the RSSI readout.
const BLACKOUT_Q = 0.10;
const BLACKOUT_MAX_S = 2.0;
const COOLDOWN_S = 25;
const COOLDOWN_FLOOR_Q = 0.30;
const SPREAD_COSMETIC_MAX = 30;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Small deterministic generator rather than Math.random, so a selftest run is
// reproducible and a fade can be replayed exactly.
function xorshift(seed) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13; s >>>= 0;
		s ^= s >> 17;
		s ^= s << 5; s >>>= 0;
		return s / 4294967296;
	};
}

export class VideoLink {
	constructor(seed = 0x5eed) {
		this._rand = xorshift(seed);
		// 0..1: scales the losses. The slider, so 0 means "no link modelling at
		// all" and 1 means the link can genuinely break.
		this.severity = 1;
		// Loss offset from the target's advertised RSSI (PHASE 08). That figure is
		// this target's clean link level at D0: a weaker transmitter or a weaker
		// antenna starts the budget with less margin. Additive in dB, like spread
		// and shadow. NOT cleared by reset(): it is a property of the target and
		// survives a respawn within the session.
		this._baseLoss = 0;
		// The zone fence's loss. It does NOT go through _loss, and that is the
		// whole point: the playability bound clips _loss and pins quality back to
		// COOLDOWN_FLOOR_Q after two seconds of black screen. That bound exists so
		// nobody is ever stuck blind IN FLIGHT — but leaving the zone is not
		// flying, it is the end of the session. Applied on the way out, after the
		// bound.
		this._terminalLoss = 0;
		this.out = { quality: 1, rssiDbm: RSSI_REF_DBM, lossDb: 0, frozen: false };
		this.reset();
	}

	reset() {
		this._loss = 0;
		this._noise = 0;
		this._frozen = false;
		// Blackout budget and cooldown timer, both in seconds. Cleared on reset so
		// a respawn never drops you straight back into a jammed screen.
		this._blackoutT = 0;
		this._cooldownT = 0;
		this._terminalLoss = 0;
		this.out.quality = 1;
		this.out.rssiDbm = RSSI_REF_DBM;
		this.out.lossDb = 0;
		this.out.frozen = false;
	}

	setSeverity(s) {
		this.severity = clamp01(s);
	}

	setSignal({ rssiDbm } = {}) {
		const raw = Number.isFinite(rssiDbm) ? Math.max(0, RSSI_REF_DBM - rssiDbm) : 0;
		this._baseLoss = raw * BASE_LOSS_WEIGHT;
	}

	// The zone fence's loss, in dB. No smoothing: TAU_FALL and TAU_RISE exist
	// because obstacle geometry is a step function, and a position is not — this
	// loss already varies continuously with every metre travelled.
	setTerminalLoss(db) {
		this._terminalLoss = Number.isFinite(db) ? Math.max(0, db) : 0;
	}

	// distance in metres; blocked/span straight out of
	// physics.obstructionBetween(). Mutates and returns the same object every
	// frame — this runs at frame rate.
	update({ distance, blocked, span, dt }) {
		// Distance no longer drives the picture (issue #79): flying to the far side
		// of the map in clear air must look exactly like hovering over the pilot,
		// so exploration is never punished. It still shifts the reported RSSI, so
		// the HUD readout stays believable — capped, because that number is
		// cosmetic and should not run away.
		const spreadCosmetic = Math.min(
			SPREAD_COSMETIC_MAX,
			20 * Math.log10(Math.max(distance, D0) / D0),
		);
		const shadow = blocked
			? KNIFE_EDGE_DB + OBSTRUCTION_DB * (1 - Math.exp(-span / OBSTRUCTION_SCALE))
			: 0;
		const target = (shadow + this._baseLoss) * this.severity;

		// Rising loss is the link failing, falling loss is it coming back.
		const tau = target > this._loss ? TAU_FALL : TAU_RISE;
		const k = dt > 0 ? 1 - Math.exp(-dt / tau) : 1;
		this._loss += (target - this._loss) * k;

		// Ornstein-Uhlenbeck-ish wander: pulled back to zero, so it stays bounded
		// instead of drifting off the way a plain random walk would.
		const kn = dt > 0 ? 1 - Math.exp(-dt / NOISE_TAU) : 1;
		this._noise += ((this._rand() * 2 - 1) * NOISE_DB - this._noise) * kn;

		const qualityOf = (l) => 1 - clamp01((l - LOSS_CLEAN) / (LOSS_DEAD - LOSS_CLEAN));
		let quality = qualityOf(Math.max(0, this._loss + this._noise * this.severity));

		// Playability bound (issue #79). A truly dead screen (quality < BLACKOUT_Q)
		// may not last more than BLACKOUT_MAX_S; once that much has piled up the
		// link is pinned to a heavy-glitch-but-flyable floor for COOLDOWN_S before
		// another blackout can arm. Guarantees the player can always keep flying.
		if (this._cooldownT > 0) {
			this._cooldownT -= dt;
			const flooredLoss = LOSS_CLEAN + (1 - COOLDOWN_FLOOR_Q) * (LOSS_DEAD - LOSS_CLEAN);
			if (this._loss > flooredLoss) this._loss = flooredLoss;
			if (quality < COOLDOWN_FLOOR_Q) quality = COOLDOWN_FLOOR_Q;
			this._blackoutT = 0;
		} else if (quality < BLACKOUT_Q) {
			this._blackoutT += dt;
			if (this._blackoutT >= BLACKOUT_MAX_S) {
				this._cooldownT = COOLDOWN_S;
				this._blackoutT = 0;
			}
		} else {
			// Brief dips must not creep the budget toward a trigger over a long flight.
			this._blackoutT = Math.max(0, this._blackoutT - dt * 0.5);
		}

		// The fence is added here, downstream of the playability bound: it is not
		// a nuisance to smooth away, it is the end of the session.
		const loss = Math.max(0, this._loss + this._noise * this.severity) + this._terminalLoss;
		// qualityOf() only reaches 0 at LOSS_DEAD, not after a span of
		// LOSS_DEAD - LOSS_CLEAN counted from zero: that span is the WIDTH of the
		// degradation band, not an absolute budget. qualityOf(loss) would therefore
		// undercount by exactly LOSS_CLEAN for an already clean link (ambient loss
		// near 0), and FENCE_SPAN would only bring quality to about 0.31 instead of
		// 0 — contradicting geofence.js's comment ("any link, however clean") and
		// the band definition above (58 dB measured FROM LOSS_CLEAN). So the
		// argument is offset by LOSS_CLEAN, which makes the cut independent of the
		// ambient noise, as documented.
		if (this._terminalLoss > 0) quality = Math.min(quality, qualityOf(LOSS_CLEAN + this._terminalLoss));

		// Frame drops. Only the digital renderer uses this, but it belongs to the
		// receiver rather than to the shader, so it is decided here. The
		// probability is the fade depth itself: at quality 0 nothing gets through
		// and the last good frame simply stays up, which is what a dead digital
		// link looks like.
		const enter = this._frozen ? FREEZE_LEAVE : FREEZE_ENTER;
		this._frozen = quality < enter && this._rand() > quality / enter;

		this.out.quality = quality;
		this.out.lossDb = loss;
		// Floored at the receiver's sensitivity: below that it reports nothing at
		// all, not an ever more negative number.
		this.out.rssiDbm = Math.max(-100, RSSI_REF_DBM - loss - spreadCosmetic);
		this.out.frozen = this._frozen;
		return this.out;
	}
}

