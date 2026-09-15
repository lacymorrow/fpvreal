// Sticks are normalised to { throttle 0..1, roll/pitch/yaw -1..1 }
// regardless of whether they came from a radio or the keyboard.

import { isTextEntry } from './menu-nav.js';
import {
	CAL_CHANNELS,
	calibrationToMap,
	padSignals,
	normalizeChannel,
	throttleFromCalibrated,
} from './calibration.js';
import {
	KEY_MAP_STORAGE,
	loadKeyMap,
	actionForKey,
} from './key-map.js';
import { loadArmStore, saveArmStore, armStoreGet, armStoreSet, armFromSignals } from './arm-switch.js';

const STORAGE_KEY = 'fpvtp.gamepadMap';
// Measured calibrations, indexed PER DEVICE (issue #277). STORAGE_KEY only ever
// held one mapping for everybody: plugging in a gamepad after remapping a radio
// picked up the radio's mapping.
const CAL_STORAGE_KEY = 'fpvtp.gamepadCal';
// Default deadband, used until the device has been calibrated. A calibration
// replaces it with the noise ACTUALLY measured at rest.
const DEADBAND = 0.06;
// Fixed navigation keys, never in the key map (D13): they are forwarded to
// main.js under their own names.
const PASSTHROUGH_KEYS = ['tab', 'escape', 'enter'];
const GAMEPAD_MOVE_THRESHOLD = 0.15;

// How long a held key takes to reach full stick deflection, in seconds.
//
// A keyboard has no travel: the smallest roll command the hardware can express
// used to be an instant step to +/-1, which at the freestyle rate preset is
// 820 deg/s of roll arriving in a single frame. Nobody can fly that, and most
// people who arrive here have no radio on the desk. Ramping gives back the
// thing a stick has and a key does not — the middle of the range — simply by
// making SHORT taps small and long presses full.
//
// 150 ms is a tap: measured against the throttle integrator, which has been
// 1.2 units/s (0.83 s cut to full) since the beginning and reads as right. A
// roll axis needs to be much quicker than a throttle — it is a correction, not
// a setting — and 150 ms is about the shortest deliberate keypress a human
// makes, so a stab still gives a real fraction of the stick while a hold still
// reaches the stop. It changes nothing a gamepad does: this is the keyboard
// reader, and readGamepad() never comes through here.
//
// Symmetric on release: a spring-return gimbal does not snap to centre either.
const KEY_RAMP_S = 0.15;

// One axis of that ramp. Lands EXACTLY on the target rather than approaching it
// forever, which is what lets the mouse know the keys have finished releasing.
function rampAxis(value, target, dt) {
	if (dt <= 0) return value;
	const step = dt / KEY_RAMP_S;
	const delta = target - value;
	return Math.abs(delta) <= step ? target : value + Math.sign(delta) * step;
}

// -----------------------------------------------------------------------------
// GAMEPAD MAPPINGS
// -----------------------------------------------------------------------------

// EdgeTX radios: friction gimbals, so the left stick's whole travel is useful —
// throttle on FULL travel (see THROTTLE_MODE).
const EDGETX_MAP = {
	roll: { axis: 0, invert: false },
	pitch: { axis: 1, invert: true },
	throttle: { axis: 2, invert: false },
	yaw: { axis: 3, invert: false },
};

// -----------------------------------------------------------------------------
// SELF-CENTRING GAMEPADS (DualShock 4/DualSense, Xbox, generics)
//
// One profile only: in the browser's "standard" mapping, PlayStation and Xbox
// expose exactly the same axis layout.
//
// axis 0 = left stick X    axis 2 = right stick X
// axis 1 = left stick Y    axis 3 = right stick Y
//
// The FPV mapping wanted:
//   left  Y -> throttle (upper half only, see THROTTLE_MODE)
//   left  X -> yaw
//   right X -> roll
//   right Y -> pitch: stick pushed forward = nose drops.
//                     The axis reads -1 forward and `sticks.pitch < 0` pitches
//                     down (flightController: pitch > 0 = pitch up), so NO
//                     inversion. Same convention on the keyboard.
// -----------------------------------------------------------------------------

const GAMEPAD_MAP = {
	throttle: { axis: 1, invert: true },
	yaw: { axis: 0, invert: false },
	roll: { axis: 2, invert: false },
	pitch: { axis: 3, invert: false },
};

// How the throttle axis becomes 0..1:
//   'full': (v+1)/2 — the stick holds its position (radio).
//   'half': max(0, v) — a self-centring stick returns to 0 %, otherwise letting
//           go of the pad would leave 50 % throttle and put the disarm gesture
//           (throttle < 0.08) out of reach at rest.
export const THROTTLE_MODE = { radio: 'full', gamepad: 'half' };

// -----------------------------------------------------------------------------
// DEVICE DETECTION
// -----------------------------------------------------------------------------

// Brand names are not enough: they only cover the radios somebody thought to
// list, and an unrecognised radio falls through to 'generic', hence to
// GAMEPAD_MAP — whose four axes are in a DIFFERENT ORDER from EDGETX_MAP, with
// a half-travel throttle. The pilot does not see "badly mapped", they see "it
// does not work". Reported on a TBS Tango 2, which no word in this list caught.
//
// Hence `4f54`: the USB product id of OpenTX/EdgeTX radios — "OT" in ASCII —
// paired with vendor `1209` (pid.codes). Verified on the project's own
// hardware: the Radiomaster Pocket enumerates as 1209:4f54, and OpenTX-derived
// firmwares (including the Tango 2's FreedomTX) share that id. An id beats a
// name, exactly as 045e and 054c do below for Xbox and PlayStation.
//
// The names stay as a second line of defence, for radios that enumerate under a
// proprietary id.
const RADIO_RE =
	/4f54|edgetx|opentx|freedomtx|radiomaster|frsky|jumper|tx16|taranis|betafpv|flysky|tbs|tango|horus|boxer|zorro|commando/i;

// 045e = vendor Microsoft. "xinput" covers the 360/One pads as seen through
// XInput on Windows.
const XBOX_RE =
	/xbox|xinput|045e/i;

// 054c = vendor Sony, shared by the DS4 and the DualSense. Firefox names the
// DS4 plain "Wireless Controller" — but Chrome names the Xbox pad "Xbox
// Wireless Controller", hence the order of the tests in padKind().
const PLAYSTATION_RE =
	/dualshock|dualsense|wireless controller|054c|playstation|ps[45]/i;

// Returns 'radio' | 'xbox' | 'playstation' | 'generic'. The order matters:
// radio first (a radio can announce itself as "... Controller"), then Xbox
// before PlayStation because of "Wireless Controller".
export function padKind(id) {
	const s = id || '';
	if (RADIO_RE.test(s)) return 'radio';
	if (XBOX_RE.test(s)) return 'xbox';
	if (PLAYSTATION_RE.test(s)) return 'playstation';
	return 'generic';
}

// What the devices screen must SHOW, decided with no DOM (issue #162).
//
// `pads`: the output of listGamepads(). `activeIndex`: the index of the device
// Input is actually reading. Returns one row per device — id, deduced class
// (that class is what decides the default mapping, so it is the thing you need
// to be able to read when "it does not work"), axis and button counts, and
// whether it is active.
//
// An empty list is not "unrecognised": the Gamepad API only exposes a device
// AFTER the user has acted on it. `empty` carries that nuance so the screen can
// say it instead of leaving you to conclude.
export function padListEntries(pads, activeIndex) {
	return (pads ?? []).map((g) => ({
		index: g.index,
		id: g.id,
		kind: padKind(g.id),
		axes: g.axes,
		buttons: g.buttons,
		active: g.index === activeIndex,
		label: `${g.index === activeIndex ? '▌' : ' '} ${g.id} — ${padKind(g.id)} · ${g.axes} axes · ${g.buttons} buttons`,
	}));
}

export const PAD_LIST_EMPTY = 'nothing enumerated — move a stick or press a button on the device, '
	+ 'the browser only reveals it after an input on it';

export function defaultMapForKind(kind) {
	return structuredClone(kind === 'radio' ? EDGETX_MAP : GAMEPAD_MAP);
}

export function throttleModeForKind(kind) {
	return kind === 'radio' ? THROTTLE_MODE.radio : THROTTLE_MODE.gamepad;
}

// A -1..1 axis, inversion already undone -> throttle 0..1.
export function throttleFromAxis(v, mode) {
	const t = mode === THROTTLE_MODE.radio ? (v + 1) / 2 : v;
	return Math.max(0, Math.min(1, t));
}

export const CHANNELS = [
	'throttle',
	'yaw',
	'pitch',
	'roll',
];

// -----------------------------------------------------------------------------
// CALIBRAGE MESURÉ (issue #277)
//
// The calibration produced by src/calibration.js describes the device as it
// actually is: measured centre, travel and noise, observed throttle travel
// mode. It wins over `map` + `throttleMode`, which stay the path for devices
// that were never calibrated.
// -----------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function isValidCalibration(cal) {
	if (!cal || typeof cal !== 'object') return false;
	if (cal.throttleMode !== 'full' && cal.throttleMode !== 'half') return false;
	// Strictly under 1, and not negative: normalizeChannel rescales the travel
	// left over the deadband, so a stored `deadband: 1` divides by zero and the
	// stick reads NaN at full stop — a dead flight, from one bad key. The live
	// calibration never writes such a value (it clamps to DEADBAND_MIN/MAX);
	// a hand-edited or half-written entry can, and this gate is what stands
	// between that entry and the motors.
	if (!isNum(cal.deadband) || cal.deadband < 0 || cal.deadband >= 1) return false;
	const ch = cal.channels;
	if (!ch || typeof ch !== 'object') return false;
	return CAL_CHANNELS.every((name) => {
		const c = ch[name];
		if (!c || typeof c !== 'object' || !isNum(c.axis)) return false;
		return name === 'throttle'
			? isNum(c.lo) && isNum(c.hi)
			: isNum(c.center) && isNum(c.span) && typeof c.invert === 'boolean';
	});
}

// ONE device's calibration, or null. Unreadable storage falls back to null
// rather than throwing: a corrupt key must not stop the boot — same rule as
// loadMap().
export function calStoreGet(store, padId) {
	if (!store || typeof store !== 'object') return null;
	const cal = store[padId];
	return isValidCalibration(cal) ? cal : null;
}

export function calStoreSet(store, padId, cal) {
	return { ...(store && typeof store === 'object' ? store : {}), [padId]: cal };
}

// The four sticks read through the calibration. No assumptions: not "centre is
// at 0", not "travel is +/-1", not "this throttle self-centres", not "a stick is
// on an axis" (#279: `signals` carries the axes THEN the buttons, because a
// radio in "standard" mapping puts its throttle on a trigger).
export function sticksFromCalibration(signals, cal) {
	const c = cal.channels;
	const at = (name) => signals[c[name].axis] ?? 0;
	return {
		throttle: throttleFromCalibrated(at('throttle'), c.throttle),
		yaw: normalizeChannel(at('yaw'), c.yaw, cal.deadband),
		pitch: normalizeChannel(at('pitch'), c.pitch, cal.deadband),
		roll: normalizeChannel(at('roll'), c.roll, cal.deadband),
	};
}

// An "assumed" calibration built from a hand-written profile: this is what a
// manual remap becomes on a device that was never calibrated. Its travel values
// are guesses (centre 0, travel +/-1) — exactly the ones a real calibration
// replaces with measurements.
export function assumedCalibration(map, throttleMode) {
	const channels = {};
	for (const name of CAL_CHANNELS) {
		const m = map[name];
		channels[name] = name === 'throttle'
			? throttleEndpoints(m.axis, m.invert, throttleMode)
			: { axis: m.axis, center: 0, span: 1, invert: !!m.invert };
	}
	return { channels, deadband: DEADBAND, throttleMode };
}

// A manual remap applied to a calibration. The Tab panel still lets you pick
// the axis and the direction by hand: that path has to keep working ON a
// calibrated device, otherwise the "inv" box would have no effect at all.
//
// What is kept and what is thrown away: on the same axis the pilot is disputing
// a DIRECTION, not a measurement — centre and travel stay. On another axis
// nothing was ever measured, so it falls back to the guesses.
export function remapChannel(cal, channel, axis, invert) {
	const previous = cal.channels[channel];
	const sameAxis = previous?.axis === axis;

	let next;
	if (channel === 'throttle') {
		// The floor stays the floor. On a self-centring throttle that is the
		// centre: moving it would leave throttle on with the pad let go.
		next = sameAxis
			? { axis, lo: previous.lo, hi: previous.lo + (invert ? -1 : 1) * Math.abs(previous.hi - previous.lo) }
			: throttleEndpoints(axis, invert, cal.throttleMode);
	} else {
		next = sameAxis
			? { ...previous, invert: !!invert }
			: { axis, center: 0, span: 1, invert: !!invert };
	}

	return { ...cal, channels: { ...cal.channels, [channel]: next } };
}

// Floor and ceiling of a throttle whose direction is all that is known: full
// travel from stop to stop, or half travel from the centre.
function throttleEndpoints(axis, invert, throttleMode) {
	// Full travel: stop to stop, i.e. 2 axis units. Half travel: centre to one
	// stop, i.e. 1.
	const span = throttleMode === THROTTLE_MODE.radio ? 2 : 1;
	const lo = throttleMode === THROTTLE_MODE.radio ? (invert ? 1 : -1) : 0;
	return { axis, lo, hi: lo + (invert ? -span : span) };
}

// -----------------------------------------------------------------------------
// DEADZONE
// -----------------------------------------------------------------------------

function applyDeadband(v) {
	if (Math.abs(v) < DEADBAND) {
		return 0;
	}

	return (
		Math.sign(v) *
		((Math.abs(v) - DEADBAND) / (1 - DEADBAND))
	);
}

// -----------------------------------------------------------------------------
// INPUT
// -----------------------------------------------------------------------------

export class Input {
	constructor() {
		const saved = loadMap();

		this._savedMap = saved !== null;

		this.map =
			saved ??
			defaultMapForKind('generic');

		// Measured calibrations, one per device (issue #277). `calibration` is
		// the ACTIVE device's: while it is null the axes are read as before,
		// through the guessed profile.
		this._calStore = loadCalStore();
		this.calibration = null;

		// The arm switch, one mapping per device (arm-switch.js). null while
		// the device has none: the shell then arms on the pad by itself.
		this._armStore = loadArmStore(globalThis.localStorage);
		this.armMap = null;

		// Re-evaluated when a pad is activated: a radio keeps full travel,
		// everything else goes to half travel.
		this.throttleMode = THROTTLE_MODE.gamepad;

		this.sticks = {
			throttle: 0,
			roll: 0,
			pitch: 0,
			yaw: 0,
			// true/false from a mapped arm switch, null from the keyboard or an
			// unmapped device.
			arm: null,
		};

		this.gamepadIndex = null;
		this.usingGamepad = false;

		this._baseline = new Map();

		// Keyboard
		this.keys = new Set();
		this.kbThrottle = 0;
		// The ramped position of the three keyboard sticks (see KEY_RAMP_S).
		// Throttle is not here: it has always been an integrator, which is a
		// stronger version of the same idea and already right.
		this.kbAxes = { roll: 0, pitch: 0, yaw: 0 };

		// Remappable bindings (D13). The map is the ONLY place a key name
		// appears from here on: nothing below compares a literal.
		this.keyMap = loadStoredKeyMap();

		// Mouse
		this.mouse = {
			x: 0,
			y: 0,
		};

		this.pointerLocked = false;

		this.onAction = () => {};

		// ---------------------------------------------------------------------
		// KEYBOARD
		// ---------------------------------------------------------------------

		window.addEventListener('keydown', (e) => {
			if (e.repeat) return;

			const k = e.key.toLowerCase();

			// A text field keeps its keys (#222): Space there is a space, not a
			// pause — main.js calls preventDefault on the action. Same rule as
			// menu-nav. Escape still goes through: it edits nothing.
			if (isTextEntry(e.target) && k !== 'escape') return;

			this.keys.add(k);

			// Bound keys are dispatched as ACTION IDS ('pause', 'photo',
			// 'benchPanel'...). Bench actions go out unconditionally — main.js
			// decides they only exist at the bench, this module knows no game
			// mode.
			const action = actionForKey(this.keyMap, k);
			if (action) {
				this.onAction(action, e);
			} else if (PASSTHROUGH_KEYS.includes(k)) {
				// Navigation, fixed and out of the map: forwarded raw.
				this.onAction(k, e);
			}

			// Space and the arrows are flight commands: stop the page from
			// scrolling.
			if (k === ' ' || k.startsWith('arrow')) {
				e.preventDefault();
			}
		});

		window.addEventListener('keyup', (e) => {
			this.keys.delete(
				e.key.toLowerCase()
			);
		});

		window.addEventListener('blur', () => {
			this.keys.clear();
		});

		// ---------------------------------------------------------------------
		// GAMEPAD CONNECTED
		// ---------------------------------------------------------------------

		window.addEventListener(
			'gamepadconnected',
			(e) => {
				const pad = e.gamepad;

				this._baseline.set(
					pad.index,
					[...pad.axes]
				);

				console.log(
					'[input] gamepad connected:',
					pad.id
				);

				console.log(
					'[input] axes:',
					[...pad.axes]
				);

				console.log(
					'[input] buttons:',
					pad.buttons.length
				);

				console.log(
					'[input] kind:',
					padKind(pad.id)
				);
			}
		);

		// ---------------------------------------------------------------------
		// GAMEPAD DISCONNECTED
		// ---------------------------------------------------------------------

		window.addEventListener(
			'gamepaddisconnected',
			(e) => {
				this._baseline.delete(
					e.gamepad.index
				);

				if (
					this.gamepadIndex ===
					e.gamepad.index
				) {
					this.gamepadIndex = null;
					this.usingGamepad = false;

					console.log(
						'[input] gamepad disconnected:',
						e.gamepad.id
					);
				}
			}
		);

		// ---------------------------------------------------------------------
		// POINTER LOCK
		// ---------------------------------------------------------------------

		document.addEventListener(
			'pointerlockchange',
			() => {
				this.pointerLocked =
					document.pointerLockElement !== null;
			}
		);

		window.addEventListener(
			'mousemove',
			(e) => {
				if (!this.pointerLocked) {
					return;
				}

				this.mouse.x = Math.max(
					-1,
					Math.min(
						1,
						this.mouse.x +
							e.movementX * 0.004
					)
				);

				this.mouse.y = Math.max(
					-1,
					Math.min(
						1,
						this.mouse.y -
							e.movementY * 0.004
					)
				);
			}
		);
	}

	// ---------------------------------------------------------------------------
	// FIND ACTIVE GAMEPAD
	// ---------------------------------------------------------------------------

	getGamepad() {
		const pads =
			(navigator.getGamepads
				? navigator.getGamepads()
				: []
			).filter(Boolean);

		// Already selected
		const current = pads.find((p) => p.index === this.gamepadIndex);
		if (current) return current;

		for (const p of pads) {
			if (!this._baseline.has(p.index)) {
				this._baseline.set(p.index, [...p.axes]);
			}
		}

		// Only one pad plugged in: the movement threshold is only useful to
		// choose between several candidates ("which one moves first"). With a
		// single pad, demanding it merely prevents detection of a stick at rest
		// or too steady (a radio's Hall gimbal, say) — so adopt it directly.
		if (pads.length === 1) {
			return this._activate(pads[0]);
		}

		for (const p of pads) {
			const base = this._baseline.get(p.index);

			const moved =
				p.axes.some((v, i) => {
					const previous =
						base[i] ?? 0;

					return (
						Math.abs(
							v - previous
						) >
						GAMEPAD_MOVE_THRESHOLD
					);
				});

			if (moved) {
				return this._activate(p);
			}
		}

		return null;
	}

	_activate(p) {
		this.gamepadIndex = p.index;

		const kind = padKind(p.id);

		// Throttle mode always follows the hardware: it describes the stick's
		// physical travel, not a preference — a user remap has no say in it.
		this.throttleMode = throttleModeForKind(kind);

		// Automatically choose the proper map
		// unless the user has explicitly saved one.
		if (!this._savedMap) {
			this.map = defaultMapForKind(kind);
		}

		// A MEASURED calibration for THIS device wins over everything else: it
		// is the only source that guesses nothing. It also fixes the throttle
		// travel mode, which is then no longer deduced from the brand.
		this.applyCalibration(calStoreGet(this._calStore, p.id));
		this.armMap = armStoreGet(this._armStore, p.id);

		console.log('[input] using gamepad:', p.id, `(${kind})`);
		console.log('[input] active map:', this.map, this.throttleMode);
		console.log('[input] calibrated:', this.calibration ? 'yes' : 'no');

		return p;
	}

	// ---------------------------------------------------------------------------
	// CALIBRAGE
	// ---------------------------------------------------------------------------

	// The active device's calibration, or null to fall back to the guessed
	// profile.
	applyCalibration(cal) {
		this.calibration = cal;
		if (!cal) return;
		this.map = calibrationToMap(cal);
		this.throttleMode = cal.throttleMode;
	}

	// End of the wizard: persisted UNDER THE DEVICE ID, so that plugging in the
	// other pad does not pick this calibration up.
	setCalibration(padId, cal) {
		this._calStore = calStoreSet(this._calStore, padId, cal);
		saveCalStore(this._calStore);
		this.applyCalibration(cal);
	}

	// The arm switch found by the setup panel, persisted under the device id
	// like a calibration.
	setArmSwitch(padId, mapping) {
		this._armStore = armStoreSet(this._armStore, padId, mapping);
		saveArmStore(globalThis.localStorage, this._armStore);
		this.armMap = mapping;
	}

	// The active device's id — the storage key for a calibration.
	activePadId() {
		return (navigator.getGamepads?.() ?? [])[this.gamepadIndex]?.id ?? null;
	}

	isCalibrated(padId = this.activePadId()) {
		return padId !== null && calStoreGet(this._calStore, padId) !== null;
	}

	// ---------------------------------------------------------------------------
	// LIST GAMEPADS
	// ---------------------------------------------------------------------------

	listGamepads() {
		return [
			...(navigator.getGamepads?.() ?? []),
		]
			.filter(Boolean)
			.map((p) => ({
				index: p.index,
				id: p.id,
				axes: p.axes.length,
				buttons: p.buttons.length,
			}));
	}

	// ---------------------------------------------------------------------------
	// MANUAL GAMEPAD SELECTION
	// ---------------------------------------------------------------------------

	selectGamepad(index) {
		this.gamepadIndex = index;

		const pad =
			(navigator.getGamepads?.() ?? [])[
				index
			];

		if (pad) {
			const kind = padKind(pad.id);

			this.map = defaultMapForKind(kind);
			this.throttleMode = throttleModeForKind(kind);
			this.applyCalibration(calStoreGet(this._calStore, pad.id));
			this.armMap = armStoreGet(this._armStore, pad.id);

			console.log(
				'[input] manually selected:',
				pad.id
			);

			console.log(
				'[input] map:',
				this.map
			);
		}
	}

	// ---------------------------------------------------------------------------
	// SAVE CUSTOM MAPPING
	// ---------------------------------------------------------------------------

	setMapping(
		channel,
		axis,
		invert
	) {
		this.map[channel] = {
			axis,
			invert,
		};

		this._savedMap = true;

		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify(this.map)
		);

		// On a calibrated device the mapping read in flight comes from the
		// calibration: without this line, changing the axis or ticking "inv"
		// would simply have no effect. The remap follows, and stays attached to
		// THIS device.
		const padId = this.activePadId();
		if (this.calibration && padId) {
			this.setCalibration(padId, remapChannel(this.calibration, channel, axis, invert));
		}
	}

	// ---------------------------------------------------------------------------
	// UPDATE
	// ---------------------------------------------------------------------------

	// `frozen` (issue #33): the simulation is frozen (pause, settings panel,
	// intro, bench) but the frame loop keeps calling update(). Without this
	// flag the keyboard throttle — an INTEGRATOR, like a real stick: it stays
	// where you leave it — climbs while you type in the panel. Typing "z" on
	// the remap page armed full throttle, and the drone shot straight up when
	// the panel closed. The gesture is not flying: it must integrate nothing.
	//
	// Only the INTEGRATION is suspended, not the reading: the pad's sticks are
	// still read (they are absolute, copying them has no side effect) and
	// `this.keys` keeps following the real keyboard state, without which a key
	// released during the freeze would stay down when it thaws.
	update(dt, { frozen = false } = {}) {
		const pad =
			this.getGamepad();

		if (
			pad &&
			this.readGamepad(pad)
		) {
			this.usingGamepad = true;
		} else {
			this.usingGamepad = false;
			this.sticks.arm = null;
			this.readKeyboard(frozen ? 0 : dt);
		}

		return this.sticks;
	}

	// ---------------------------------------------------------------------------
	// STANDARD GAMEPAD / RADIO
	// ---------------------------------------------------------------------------

	readStandardGamepad(pad) {
		// A calibrated device: its axes are read through its own measurements —
		// centre, travel and noise taken on THIS hardware. The path below stays
		// the one for never-calibrated devices, with its guesses.
		if (this.calibration) {
			const signals = padSignals(pad);
			Object.assign(this.sticks, sticksFromCalibration(signals, this.calibration));
			this.sticks.arm = armFromSignals(this.armMap, signals);
			return true;
		}

		const raw = (channel) => {
			const m =
				this.map[channel];

			if (!m) {
				return null;
			}

			// The same index space as the calibration: the axes, then the
			// buttons (#279). A manual remap has to be able to name a trigger,
			// otherwise it cannot fix what a calibration fixes.
			const v =
				padSignals(pad)[m.axis];

			if (v === undefined) {
				return null;
			}

			return m.invert
				? -v
				: v;
		};

		const t =
			raw('throttle');

		if (t === null) {
			return false;
		}

		this.sticks.throttle =
			throttleFromAxis(
				t,
				this.throttleMode
			);

		this.sticks.yaw =
			applyDeadband(
				raw('yaw') ?? 0
			);

		this.sticks.pitch =
			applyDeadband(
				raw('pitch') ?? 0
			);

		this.sticks.roll =
			applyDeadband(
				raw('roll') ?? 0
			);

		this.sticks.arm = armFromSignals(this.armMap, padSignals(pad));

		return true;
	}

	// ---------------------------------------------------------------------------
	// GAMEPAD READER
	// ---------------------------------------------------------------------------

	// One reading path for everybody: radio, PlayStation, Xbox and generic pads
	// differ only in `this.map` and `this.throttleMode`. That is what makes the
	// Settings panel's remap effective on EVERY pad (it writes into
	// `this.map`).
	readGamepad(pad) {
		return this.readStandardGamepad(pad);
	}

	// ---------------------------------------------------------------------------
	// KEYBOARD
	// ---------------------------------------------------------------------------

	readKeyboard(dt) {
		const has = (action) =>
			this.isHeld(action);

		// Throttle
		if (has('throttleUp')) {
			this.kbThrottle +=
				dt * 1.2;
		} else if (has('throttleDown')) {
			this.kbThrottle -=
				dt * 1.2;
		}

		this.kbThrottle =
			Math.max(
				0,
				Math.min(
					1,
					this.kbThrottle
				)
			);

		let roll = 0;
		let pitch = 0;
		let yaw = 0;

		// Yaw
		if (has('yawLeft')) {
			yaw -= 1;
		}

		if (has('yawRight')) {
			yaw += 1;
		}

		// Roll
		if (has('rollLeft')) {
			roll -= 1;
		}

		if (has('rollRight')) {
			roll += 1;
		}

		// Pitch — same convention as the pad: "forward" drops the nose.
		if (has('pitchDown')) {
			pitch -= 1;
		}

		if (has('pitchUp')) {
			pitch += 1;
		}

		// Everything above is the TARGET: which way the key says to go. What the
		// machine actually gets is the ramp toward it (KEY_RAMP_S), so a tap is
		// a nudge and a hold still reaches the stop.
		this.kbAxes.roll = rampAxis(this.kbAxes.roll, roll, dt);
		this.kbAxes.pitch = rampAxis(this.kbAxes.pitch, pitch, dt);
		this.kbAxes.yaw = rampAxis(this.kbAxes.yaw, yaw, dt);

		let outRoll = this.kbAxes.roll;
		let outPitch = this.kbAxes.pitch;

		// Mouse. A deliberate exception to the convention above: the mouse is
		// not a stick you push, it is an aim. Mouse up = look up = pitch up, as
		// everywhere else.
		//
		// It takes over only once the keys have finished releasing — the ramp
		// lands exactly on zero, so this is the same "no arrow held" rule as
		// before, 150 ms later. Deliberately outside the ramp: the mouse is
		// already proportional and already self-centres (the decay below), and
		// smoothing it twice would only make aiming mushy.
		if (
			this.pointerLocked &&
			roll === 0 &&
			pitch === 0 &&
			this.kbAxes.roll === 0 &&
			this.kbAxes.pitch === 0
		) {
			outRoll = this.mouse.x;
			outPitch = this.mouse.y;

			const decay =
				Math.exp(-dt * 3.5);

			this.mouse.x *= decay;
			this.mouse.y *= decay;
		}

		this.sticks.throttle =
			this.kbThrottle;

		this.sticks.roll = outRoll;
		this.sticks.pitch = outPitch;
		this.sticks.yaw = this.kbAxes.yaw;
	}

	// ---------------------------------------------------------------------------
	// KEY MAP
	// ---------------------------------------------------------------------------

	// Settings hands over a whole map; it goes through loadKeyMap so a
	// half-built one can never leave an action unbound.
	setKeyMap(map) {
		this.keyMap = loadKeyMap(map);
		return this.keyMap;
	}

	getKeyMap() {
		return this.keyMap;
	}

	// Is any key bound to this action currently down?
	isHeld(actionId) {
		const keys = this.keyMap[actionId];
		if (!keys) return false;
		return keys.some((k) => this.keys.has(k));
	}

	// ---------------------------------------------------------------------------
	// RESET
	// ---------------------------------------------------------------------------

	resetKeyboardThrottle() {
		this.kbThrottle = 0;
		this.mouse.x = 0;
		this.mouse.y = 0;
		// A respawn must not inherit the stick the last life died holding: the
		// ramp is a position, exactly like the throttle integrator above.
		this.kbAxes.roll = 0;
		this.kbAxes.pitch = 0;
		this.kbAxes.yaw = 0;
	}
}

// -----------------------------------------------------------------------------
// LOAD SAVED MAP
// -----------------------------------------------------------------------------

// Bindings saved by the KEYBOARD tab. Same defensive rule as the calibration
// store: an unreadable key falls back to the defaults instead of breaking boot.
function loadStoredKeyMap() {
	try {
		return loadKeyMap(localStorage.getItem(KEY_MAP_STORAGE));
	} catch {
		return loadKeyMap(null);
	}
}

// Every measured calibration, all devices together. Unreadable -> {}: a corrupt
// key must not stop the sim from booting.
function loadCalStore() {
	try {
		const saved = JSON.parse(localStorage.getItem(CAL_STORAGE_KEY));
		if (saved && typeof saved === 'object') return saved;
	} catch {
		// Ignore invalid saved data.
	}
	return {};
}

function saveCalStore(store) {
	try {
		localStorage.setItem(CAL_STORAGE_KEY, JSON.stringify(store));
	} catch {
		// Full or refused storage must not break the end of the wizard: the
		// calibration stays active for the current session.
	}
}

function loadMap() {
	try {
		const saved =
			JSON.parse(
				localStorage.getItem(
					STORAGE_KEY
				)
			);

		if (
			saved &&
			CHANNELS.every(
				(channel) =>
					saved[channel] &&
					typeof saved[channel].axis ===
						'number'
			)
		) {
			return saved;
		}
	} catch {
		// Ignore invalid saved data.
	}

	return null;
}
