// Selftest for the pure logic of src/input.js. Almost no I/O: the exported
// helpers (pad detection, default profile, throttle axis conversion) test bare.
// The Input class itself needs `window` — the fake DOM provides it, and this is
// the ONLY place it is mounted (issue #33: the keyboard throttle is an
// integrator, and its integration has state worth checking).
// Run: node tools/input-selftest.mjs
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';

const dom = installFakeDom();

const {
	padKind,
	defaultMapForKind,
	throttleModeForKind,
	throttleFromAxis,
	THROTTLE_MODE,
	CHANNELS,
	padListEntries,
	PAD_LIST_EMPTY,
	calStoreGet,
	calStoreSet,
	sticksFromCalibration,
	remapChannel,
	Input,
} = await import('../src/input.js');
const { padSignals } = await import('../src/calibration.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// --- padKind ----------------------------------------------------------------

t('padKind: real Xbox ids (Chrome, Firefox, XInput)', () => {
	assert.equal(padKind('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b12)'), 'xbox');
	assert.equal(padKind('045e-02fd-Xbox Wireless Controller'), 'xbox');
	assert.equal(padKind('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'xbox');
});

t('padKind: real PlayStation ids (DS4 and DualSense)', () => {
	assert.equal(padKind('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'), 'playstation');
	assert.equal(padKind('054c-09cc-Wireless Controller'), 'playstation');
	assert.equal(padKind('DualSense Wireless Controller'), 'playstation');
	assert.equal(padKind('Sony DualShock 4'), 'playstation');
});

t('padKind: "Xbox Wireless Controller" does not fall through to playstation', () => {
	// PLAYSTATION_RE contains "wireless controller" (Firefox's name for the
	// DS4): without the Xbox test first, the Xbox pad landed on the wrong side.
	assert.equal(padKind('Xbox Wireless Controller'), 'xbox');
});

t('padKind: EdgeTX radios before anything else', () => {
	assert.equal(padKind('RadioMaster TX16S Joystick'), 'radio');
	assert.equal(padKind('OpenTX FrSky Taranis'), 'radio');
});

t('padKind: a radio is recognised by its USB ID, not only by its brand', () => {
	// 1209:4f54 — pid.codes / "OT" — is the shared id of OpenTX/EdgeTX radios.
	// Observed on the project's own hardware: the Radiomaster Pocket enumerates
	// this way. The two browsers format the id differently, and both must
	// pass.
	assert.equal(padKind('EdgeTX Radiomaster Pocket Joystick (Vendor: 1209 Product: 4f54)'), 'radio');
	assert.equal(padKind('1209-4f54-EdgeTX Radiomaster Pocket Joystick'), 'radio');
	// The case that motivated the fix: no brand word in the original list
	// caught a TBS Tango 2, which therefore fell to 'generic' — that is, to
	// GAMEPAD_MAP, whose axis order is different.
	assert.equal(padKind('TBS Tango 2 (Vendor: 1209 Product: 4f54)'), 'radio');
	assert.equal(padKind('TBS TANGO 2 Joystick'), 'radio');
});

t('padKind: classing a radio as generic gives WRONG axes, not a cosmetic flaw', () => {
	// Why a misclassification is experienced as "it does not work": the two
	// maps do not assign the same axes.
	const radio = defaultMapForKind('radio'), generic = defaultMapForKind('generic');
	const differing = ['throttle', 'yaw', 'roll', 'pitch'].filter((c) => radio[c].axis !== generic[c].axis);
	assert.equal(differing.length, 4, `all 4 channels must differ, ${differing.length} do`);
	assert.notEqual(throttleModeForKind('radio'), throttleModeForKind('generic'));
});

t('padKind: unknown / empty -> generic', () => {
	assert.equal(padKind('Some No-Name Pad'), 'generic');
	assert.equal(padKind(''), 'generic');
	assert.equal(padKind(undefined), 'generic');
});

// --- profiles ---------------------------------------------------------------

t('defaultMapForKind: Xbox, PlayStation and generic share one profile', () => {
	assert.deepEqual(defaultMapForKind('xbox'), defaultMapForKind('playstation'));
	assert.deepEqual(defaultMapForKind('generic'), defaultMapForKind('playstation'));
});

t('defaultMapForKind: the radio has its own profile', () => {
	assert.notDeepEqual(defaultMapForKind('radio'), defaultMapForKind('xbox'));
	assert.equal(defaultMapForKind('radio').throttle.axis, 2);
});

t('defaultMapForKind: every channel is defined, and it is a copy', () => {
	for (const kind of ['radio', 'xbox', 'playstation', 'generic']) {
		const m = defaultMapForKind(kind);
		for (const ch of CHANNELS) {
			assert.equal(typeof m[ch].axis, 'number', `${kind}.${ch}.axis`);
			assert.equal(typeof m[ch].invert, 'boolean', `${kind}.${ch}.invert`);
		}
	}
	const a = defaultMapForKind('xbox');
	a.roll.axis = 99;
	assert.equal(defaultMapForKind('xbox').roll.axis, 2);
});

t('gamepad profile: pushing the right stick forward drops the nose', () => {
	// Axis 3 = -1 with the stick forward; with no inversion sticks.pitch goes
	// negative, and flightController treats pitch > 0 as "pitch up".
	const m = defaultMapForKind('xbox');
	assert.equal(m.pitch.axis, 3);
	const forward = m.pitch.invert ? 1 : -1;
	assert.ok(forward < 0, 'stick forward must give a negative pitch (nose down)');
});

// --- throttle ---------------------------------------------------------------

t('throttleModeForKind: half travel except on a radio', () => {
	assert.equal(throttleModeForKind('radio'), THROTTLE_MODE.radio);
	assert.equal(throttleModeForKind('xbox'), THROTTLE_MODE.gamepad);
	assert.equal(throttleModeForKind('playstation'), THROTTLE_MODE.gamepad);
	assert.equal(throttleModeForKind('generic'), THROTTLE_MODE.gamepad);
});

t('throttleFromAxis half: a self-centring stick at rest = 0 % throttle', () => {
	// The point of the choice: at centre the pad must command no throttle,
	// otherwise the disarm gesture (throttle < 0.08) is out of reach.
	assert.equal(throttleFromAxis(0, THROTTLE_MODE.gamepad), 0);
	assert.equal(throttleFromAxis(-1, THROTTLE_MODE.gamepad), 0);
	assert.equal(throttleFromAxis(1, THROTTLE_MODE.gamepad), 1);
	assert.equal(throttleFromAxis(0.5, THROTTLE_MODE.gamepad), 0.5);
});

t('throttleFromAxis full: the radio keeps its full travel', () => {
	assert.equal(throttleFromAxis(-1, THROTTLE_MODE.radio), 0);
	assert.equal(throttleFromAxis(0, THROTTLE_MODE.radio), 0.5);
	assert.equal(throttleFromAxis(1, THROTTLE_MODE.radio), 1);
});

t('throttleFromAxis: clamped into 0..1 even on an axis that overshoots', () => {
	for (const mode of [THROTTLE_MODE.radio, THROTTLE_MODE.gamepad]) {
		assert.equal(throttleFromAxis(-3, mode), 0);
		assert.equal(throttleFromAxis(3, mode), 1);
	}
});

// --- the devices screen (issue #162) ----------------------------------------

// Brand-name detection left a TBS Tango 2 as `generic` — and that is not
// cosmetic: ALL FOUR channels differ between EDGETX_MAP and GAMEPAD_MAP, and
// the throttle mode goes from full travel to half. The pilot does not perceive
// "badly mapped", they perceive "it does not work". Detection therefore goes
// through the USB id, and a SCREEN makes name recognition incidental — that
// screen is what is tested below.

t('#162: an OpenTX/EdgeTX radio is recognised by its USB id', () => {
	// 1209:4f54 — "OT" in ASCII at pid.codes. OpenTX-derived firmwares
	// (including FreedomTX, the Tango 2's) share it.
	assert.equal(padKind('1209-4f54-RadioMaster Pocket Joystick'), 'radio');
	assert.equal(padKind('Unknown Gamepad (Vendor: 1209 Product: 4f54)'), 'radio');
	// And by name, as a second line of defence, for what does not enumerate
	// that way.
	assert.equal(padKind('TBS TANGO 2'), 'radio');
	assert.equal(padKind('FreedomTX Joystick'), 'radio');
});

t('#162: a radio does not pass itself off as a game controller', () => {
	// The heart of the report: classed `generic`, it was given GAMEPAD_MAP.
	const radio = defaultMapForKind('radio');
	const generic = defaultMapForKind('generic');
	const diff = CHANNELS.filter((c) => radio[c].axis !== generic[c].axis);
	assert.equal(diff.length, CHANNELS.length, 'all four channels really do differ between the two profiles');
	assert.notEqual(throttleModeForKind('radio'), throttleModeForKind('generic'),
		'and so does the throttle mode: full travel against half');
});

t('#162: the list shows WHAT THE BROWSER SEES, not a guess', () => {
	// listGamepads() and selectGamepad() existed and were called NOWHERE: there
	// was no screen to see what is detected, nor to choose when two devices are
	// plugged in. That is what padListEntries now decides, and what the Settings
	// panel merely paints.
	const pads = [
		{ index: 0, id: 'Xbox Wireless Controller (045e:02fd)', axes: 4, buttons: 16 },
		{ index: 1, id: 'TBS TANGO 2 (1209:4f54)', axes: 8, buttons: 0 },
	];
	const rows = padListEntries(pads, 1);
	assert.equal(rows.length, 2, 'one row per enumerated device');

	// The deduced class, which is what DECIDES the mapping: without it, "it does
	// not work" stays impossible to diagnose.
	assert.equal(rows[0].kind, 'xbox');
	assert.equal(rows[1].kind, 'radio');

	// The numbers you ask a user for when their radio does not answer.
	assert.match(rows[1].label, /8 axes/);
	assert.match(rows[1].label, /0 buttons/);
	assert.match(rows[1].label, /TBS TANGO 2/);

	// And which one is active, marked the way the menu cursor is.
	assert.equal(rows[1].active, true);
	assert.equal(rows[0].active, false);
	assert.match(rows[1].label, /^▌/);
});

t('#162: an empty enumeration SAYS SO, instead of leaving you to conclude', () => {
	// The Gamepad API only exposes a device after an action ON IT: "nothing
	// listed" is not "not recognised". A radio with no buttons at all cannot
	// satisfy that condition by moving its sticks alone.
	assert.deepEqual(padListEntries([], 0), []);
	assert.deepEqual(padListEntries(null, 0), [], 'no enumeration at all: no crash');
	assert.match(PAD_LIST_EMPTY, /only reveals it after an input/);
});

// --- calibration stored PER DEVICE (issue #277) -----------------------------
//
// The flaw this fixes: `_savedMap` was one global boolean and the mapping one
// localStorage entry. A remap made for a radio therefore stayed stuck when you
// plugged in a DualShock 4 — whose axes are in a different order AND whose
// throttle is half travel.

const RADIO_CAL = {
	channels: {
		throttle: { axis: 2, lo: -1, hi: 1 },
		yaw: { axis: 3, center: 0, span: 1, invert: false },
		pitch: { axis: 1, center: 0, span: 1, invert: true },
		roll: { axis: 0, center: 0, span: 1, invert: false },
	},
	deadband: 0.02,
	throttleMode: 'full',
};

const DS4_CAL = {
	channels: {
		throttle: { axis: 1, lo: 0, hi: -1 },
		yaw: { axis: 0, center: 0, span: 1, invert: false },
		pitch: { axis: 3, center: 0, span: 1, invert: false },
		roll: { axis: 2, center: 0, span: 1, invert: false },
	},
	deadband: 0.03,
	throttleMode: 'half',
};

t('#277: calibrating a gamepad does not touch the radio calibration', () => {
	let store = calStoreSet({}, 'EdgeTX Radiomaster Pocket', RADIO_CAL);
	store = calStoreSet(store, 'Wireless Controller (054c)', DS4_CAL);

	assert.equal(calStoreGet(store, 'EdgeTX Radiomaster Pocket').throttleMode, 'full');
	assert.equal(calStoreGet(store, 'Wireless Controller (054c)').throttleMode, 'half');
	assert.equal(calStoreGet(store, 'EdgeTX Radiomaster Pocket').channels.throttle.axis, 2);
});

t('#277: a never-calibrated device does not pick up another one\'s', () => {
	const store = calStoreSet({}, 'EdgeTX Radiomaster Pocket', RADIO_CAL);
	assert.equal(calStoreGet(store, 'Xbox Wireless Controller'), null);
});

t('#277: corrupt storage does not bring the boot down', () => {
	// Same rule as loadMap(): an unreadable key falls back to the default
	// behaviour, it does not stop the sim from booting.
	assert.equal(calStoreGet(null, 'x'), null);
	assert.equal(calStoreGet({ x: 'not an object' }, 'x'), null);
	assert.equal(calStoreGet({ x: { channels: {} } }, 'x'), null, 'four channels or nothing');
	assert.equal(calStoreGet({ x: { ...DS4_CAL, channels: { ...DS4_CAL.channels, roll: null } } }, 'x'), null);
});

t('#277: the sticks come out of the calibration, not out of guesses', () => {
	// Radio: a friction throttle parked at the bottom -> 0 % throttle, not 50 %.
	assert.deepEqual(sticksFromCalibration([0, 0, -1, 0], RADIO_CAL), {
		throttle: 0, yaw: 0, pitch: 0, roll: 0,
	});

	const full = sticksFromCalibration([0, 0, 1, 0], RADIO_CAL);
	assert.equal(full.throttle, 1);

	// DS4: stick let go -> 0 % throttle. That is what keeps the disarm gesture
	// (throttle < 0.08) reachable at rest.
	assert.equal(sticksFromCalibration([0, 0, 0, 0], DS4_CAL).throttle, 0);
	assert.equal(sticksFromCalibration([0, -1, 0, 0], DS4_CAL).throttle, 1);
});

t('#277: calibrated pitch keeps the "pulled towards you = pitch up" convention', () => {
	// flightController: pitch > 0 = pitch up. On the radio the axis reads -1
	// when the stick is pulled towards you, hence invert:true.
	assert.ok(sticksFromCalibration([0, -1, -1, 0], RADIO_CAL).pitch > 0.9);
	// On the DS4 the same gesture puts the right Y axis at +1, no inversion.
	assert.ok(sticksFromCalibration([0, 0, 0, 1], DS4_CAL).pitch > 0.9);
});

t('#277: a manual remap on the SAME axis keeps the measured travel', () => {
	// The pilot inverts pitch by hand: they are disputing a DIRECTION, not a
	// measurement. Throwing away the measured travel at that moment would take
	// back what the calibration had just given them.
	const cal = {
		...DS4_CAL,
		channels: { ...DS4_CAL.channels, pitch: { axis: 3, center: 0.05, span: 0.8, invert: false } },
	};
	const out = remapChannel(cal, 'pitch', 3, true);
	assert.equal(out.channels.pitch.span, 0.8);
	assert.equal(out.channels.pitch.center, 0.05);
	assert.equal(out.channels.pitch.invert, true);
});

t('#277: a manual remap to ANOTHER axis does not invent a measurement', () => {
	// Nothing was ever measured on axis 2 for this channel: it falls back to the
	// guesses (centre 0, travel +/-1), not to axis 3's numbers.
	const cal = {
		...DS4_CAL,
		channels: { ...DS4_CAL.channels, pitch: { axis: 3, center: 0.05, span: 0.8, invert: false } },
	};
	const out = remapChannel(cal, 'pitch', 2, false);
	assert.deepEqual(out.channels.pitch, { axis: 2, center: 0, span: 1, invert: false });
});

t('#277: inverting a half-travel throttle does NOT leave throttle on at rest', () => {
	// The dangerous case. The floor of a self-centring throttle is the centre:
	// THAT is what has to stay put when it is inverted, otherwise pad let go =
	// full throttle, and the disarm gesture becomes unreachable.
	const out = remapChannel(DS4_CAL, 'throttle', 1, false);
	assert.equal(sticksFromCalibration([0, 0, 0, 0], out).throttle, 0);
	assert.equal(sticksFromCalibration([0, 1, 0, 0], out).throttle, 1);
});

t('#279: a Pocket whose throttle is on the trigger flies correctly', () => {
	// The whole path, exactly as readStandardGamepad() takes it: the browser's
	// Gamepad object -> padSignals() -> sticksFromCalibration(). On a
	// Radiomaster Pocket that Firefox maps as "standard", the throttle comes out
	// on buttons[6].value and the fourth axis is dead — measured, see #279.
	const pocket = (roll, pitch, yaw, btn6) => ({
		axes: [roll, pitch, yaw, 0, 0, 0, 0, 0],
		buttons: Array.from({ length: 28 }, (_, i) => ({ value: i === 6 ? btn6 : 0 })),
	});
	// Button 6 becomes signal 8 + 6 = 14, travelling -1..1 like an axis.
	const cal = {
		channels: {
			throttle: { axis: 14, lo: -1, hi: 0.994 },
			yaw: { axis: 2, center: 0, span: 1, invert: false },
			pitch: { axis: 1, center: 0, span: 1, invert: true },
			roll: { axis: 0, center: 0, span: 1, invert: false },
		},
		deadband: 0.02,
		throttleMode: 'full',
		axisCount: 8,
	};

	const atRest = sticksFromCalibration(padSignals(pocket(0, 0, 0, 0)), cal);
	assert.equal(atRest.throttle, 0, 'throttle down = 0, otherwise disarm is unreachable');
	assert.equal(atRest.yaw, 0);

	const wideOpen = sticksFromCalibration(padSignals(pocket(0, 0, 0, 0.997)), cal);
	assert.ok(wideOpen.throttle > 0.99, `throttle wide open = ${wideOpen.throttle}`);

	// And a throttle on a button bleeds into none of the other three channels.
	assert.equal(wideOpen.roll, 0);
	assert.equal(wideOpen.pitch, 0);
	assert.equal(wideOpen.yaw, 0);

	const right = sticksFromCalibration(padSignals(pocket(1, 0, 0, 0)), cal);
	assert.ok(right.roll > 0.97, `roll right = ${right.roll}`);
	assert.equal(right.throttle, 0, 'moving a stick does not add throttle');
});


// --- keyboard throttle: an integrator, and what is allowed to integrate it (#33)
//
// The keyboard throttle is NOT a button: like a real stick, it stays where you
// leave it. That is deliberate, and the OSD shows it as a percentage. What was
// not deliberate is that it climbed while the simulation was frozen — typing
// "z" on the remap page armed full throttle, and the drone shot straight up
// when the panel closed.

const freshInput = () => {
	const input = new Input();
	input.keys.clear();
	input.kbThrottle = 0;
	return input;
};

// A second of holding, in 100 ms steps: the frame loop, only slower.
const holdFor = (input, key, seconds, opts) => {
	input.keys.add(key);
	for (let i = 0; i < seconds * 10; i++) input.update(0.1, opts);
	input.keys.delete(key);
};

t('#33: holding "z" raises the throttle — it is a stick, not a button', () => {
	const input = freshInput();
	holdFor(input, 'z', 0.5);
	assert.ok(input.kbThrottle > 0.5, `throttle ${input.kbThrottle} after 0.5 s`);
});

t('#33: releasing "z" LEAVES the throttle where it is — a stick does not fall back', () => {
	const input = freshInput();
	holdFor(input, 'z', 0.5);
	const held = input.kbThrottle;
	for (let i = 0; i < 20; i++) input.update(0.1);   // no key at all any more
	assert.equal(input.kbThrottle, held, 'the throttle moved with no input');
});

t('#33: "s" brings the throttle back down', () => {
	const input = freshInput();
	holdFor(input, 'z', 1);
	assert.ok(input.kbThrottle > 0.9);
	holdFor(input, 's', 1);
	assert.ok(input.kbThrottle < 0.1, `throttle ${input.kbThrottle} after a second coming down`);
});

t('#33: with the simulation frozen, "z" integrates NOTHING', () => {
	// The heart of the bug: settings panel open, the frame loop still running
	// and calling update() without saying that nothing was flying any more.
	const input = freshInput();
	holdFor(input, 'z', 2, { frozen: true });
	assert.equal(input.kbThrottle, 0, `throttle ${input.kbThrottle} armed while frozen`);
});

t('#33: freezing does not DAMAGE the throttle already set', () => {
	// Freezing does not reset: pausing mid-flight must not cut the throttle when
	// it thaws.
	const input = freshInput();
	holdFor(input, 'z', 0.5);
	const before = input.kbThrottle;
	for (let i = 0; i < 20; i++) input.update(0.1, { frozen: true });
	assert.equal(input.kbThrottle, before);
});

t('#33: once thawed, "z" integrates again', () => {
	// The guard must not lock the input into the frozen state.
	const input = freshInput();
	holdFor(input, 'z', 1, { frozen: true });
	assert.equal(input.kbThrottle, 0);
	holdFor(input, 'z', 0.5);
	assert.ok(input.kbThrottle > 0.5, `throttle ${input.kbThrottle} after the thaw`);
});

t('#33: with no option, update() integrates — the default stays flying', () => {
	const input = freshInput();
	holdFor(input, 'z', 0.5, undefined);
	assert.ok(input.kbThrottle > 0.5);
});

t('#33: a key released while frozen really is released when it thaws', () => {
	// The freeze suspends the INTEGRATION, not the keyboard tracking: otherwise
	// a key let go with the panel open would stay down when it closes.
	const input = freshInput();
	input.keys.add('z');
	for (let i = 0; i < 5; i++) input.update(0.1, { frozen: true });
	input.keys.delete('z');
	for (let i = 0; i < 5; i++) input.update(0.1);
	assert.equal(input.kbThrottle, 0, 'the throttle climbed with no key held');
});

// --- keyboard stick ramp (B4) -----------------------------------------------
//
// A keyboard has no travel. Roll, pitch and yaw used to step straight to +/-1,
// so the smallest command an arrow key could express was FULL deflection —
// 820 deg/s of roll at the freestyle preset, arriving in one frame. That is not
// a hard control scheme, it is an unflyable one, and it is what most people
// arriving on launch day have in front of them.
//
// The ramp (KEY_RAMP_S = 0.15 s) gives back the middle of the range: a tap is
// small, a hold still reaches the stop. Nothing about a gamepad changes — this
// is readKeyboard(), and readGamepad() never comes through here.

// Steps of `dt` seconds, like the frame loop but slower and exact.
const stepFor = (input, key, seconds, dt = 0.01, opts) => {
	input.keys.add(key);
	for (let i = 0; i < Math.round(seconds / dt); i++) input.update(dt, opts);
	input.keys.delete(key);
	return input.sticks;
};

t('B4: a TAP on the roll key is a nudge, not a full-deflection command', () => {
	const input = freshInput();
	// 30 ms — about the shortest keypress a human makes by accident.
	stepFor(input, 'arrowright', 0.03);
	assert.ok(input.sticks.roll > 0 && input.sticks.roll < 0.35,
		`roll ${input.sticks.roll} after a 30 ms tap — used to be 1`);
});

t('B4: a HELD key still reaches full deflection, and stays there', () => {
	const input = freshInput();
	stepFor(input, 'arrowright', 0.15);
	assert.ok(input.sticks.roll > 0.99, `roll ${input.sticks.roll} after the ramp time`);
	input.keys.add('arrowright');
	for (let i = 0; i < 50; i++) input.update(0.01);
	input.keys.delete('arrowright');
	assert.equal(input.sticks.roll, 1, 'and it does not overshoot past it');
});

t('B4: the ramp is symmetric — releasing centres over the same time', () => {
	const input = freshInput();
	stepFor(input, 'arrowright', 0.2);
	assert.equal(input.sticks.roll, 1);
	for (let i = 0; i < 7; i++) input.update(0.01);
	assert.ok(input.sticks.roll > 0 && input.sticks.roll < 1, 'on the way back, not snapped');
	for (let i = 0; i < 20; i++) input.update(0.01);
	assert.equal(input.sticks.roll, 0, 'lands exactly on centre');
});

t('B4: reversing does not jump through the middle', () => {
	const input = freshInput();
	stepFor(input, 'arrowright', 0.2);
	input.keys.add('arrowleft');
	input.update(0.01);
	assert.ok(input.sticks.roll > 0.8, `still on the right side: ${input.sticks.roll}`);
	for (let i = 0; i < 30; i++) input.update(0.01);
	input.keys.delete('arrowleft');
	assert.equal(input.sticks.roll, -1);
});

t('B4: pitch and yaw ramp too, and each axis is its own', () => {
	const input = freshInput();
	input.keys.add('arrowup');
	input.keys.add('d');
	for (let i = 0; i < 5; i++) input.update(0.01);
	assert.ok(input.sticks.pitch < 0 && input.sticks.pitch > -1, `pitch ${input.sticks.pitch}`);
	assert.ok(input.sticks.yaw > 0 && input.sticks.yaw < 1, `yaw ${input.sticks.yaw}`);
	assert.equal(input.sticks.roll, 0, 'an axis nobody touched stays at rest');
	input.keys.clear();
});

t('B4: frozen, the ramp does not creep either', () => {
	// Same rule as the throttle integrator: a keystroke typed in the settings
	// panel does not fly the machine.
	const input = freshInput();
	stepFor(input, 'arrowright', 1, 0.01, { frozen: true });
	assert.equal(input.sticks.roll, 0, `roll ${input.sticks.roll} built up while frozen`);
});

t('B4: a respawn does not inherit the stick the last life died holding', () => {
	const input = freshInput();
	stepFor(input, 'arrowright', 0.2);
	assert.equal(input.sticks.roll, 1);
	input.resetKeyboardThrottle();
	input.update(0.01);
	assert.equal(input.sticks.roll, 0);
});

t('B4: the mouse takes over once the keys have finished releasing', () => {
	const input = freshInput();
	input.pointerLocked = true;
	input.mouse.x = 0.5;
	stepFor(input, 'arrowright', 0.2);
	// Still ramping down: the keys own the axis, the mouse waits.
	input.update(0.01);
	assert.ok(input.sticks.roll > 0.5, 'the key value is still what flies');
	for (let i = 0; i < 30; i++) input.update(0.01);
	// The mouse now owns the axis: what flies is the aim as it stood at the top
	// of the frame, and it self-centres on its own decay, not on the ramp.
	const aim = input.mouse.x;
	input.update(0.01);
	assert.ok(Math.abs(input.sticks.roll - aim) < 1e-12, 'the stick IS the aim');
	assert.ok(input.mouse.x < aim, 'and the aim keeps falling back to centre');
});

console.log(`input-selftest: ${n} tests ok`);
