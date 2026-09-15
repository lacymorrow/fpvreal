// The setup panel, on Tab: radio, arm switch, rates, camera tilt. One panel,
// four rows. The calibration wizard is upstream's state machine
// (calibration.js); this file only paints what it returns.

import { RATE_PRESETS } from './flightController.js';
import {
	beginCalibration, feedSample, calibrationResult, calProgress, calSummaryLines, padSignals,
} from './calibration.js';
import { beginArmDetect, feedArmDetect } from './arm-switch.js';

const TILT_KEY = 'fpvreal.cameraTilt';
const RATES_KEY = 'fpvreal.rates';
const FEEL_KEY = 'fpvreal.feel';

// 'smooth' is the default: no propwash shake, a filtered camera, a short
// shutter. 'real' is the measured airframe, camera bolted to the frame.
export const FEELS = ['smooth', 'real'];
export function loadFeel() {
	try { const v = localStorage.getItem(FEEL_KEY); return FEELS.includes(v) ? v : 'smooth'; } catch { return 'smooth'; }
}
export function saveFeel(v) {
	try { localStorage.setItem(FEEL_KEY, v); } catch { /* private mode */ }
}

export function loadTilt(fallback) {
	const v = Number(localStorage.getItem(TILT_KEY));
	return Number.isFinite(v) && v >= 0 && v <= 60 && localStorage.getItem(TILT_KEY) !== null ? v : fallback;
}

// Rates follow the device, the way a calibration does: the race quad's rates
// on the race radio, the whoop's on the gamepad.
export function loadRates(deviceId) {
	try {
		const store = JSON.parse(localStorage.getItem(RATES_KEY)) ?? {};
		const name = store[deviceId ?? 'keyboard'];
		return RATE_PRESETS[name] ? name : null;
	} catch { return null; }
}

export function saveRates(deviceId, name) {
	try {
		const store = JSON.parse(localStorage.getItem(RATES_KEY)) ?? {};
		store[deviceId ?? 'keyboard'] = name;
		localStorage.setItem(RATES_KEY, JSON.stringify(store));
	} catch { /* private mode */ }
}

export class Setup {
	// onTilt(deg), onRates(name), onFeel(name), getController() -> the live controller or null.
	constructor(root, input, { onTilt, onRates, onFeel, getController, tilt, feel }) {
		this.input = input;
		this.onTilt = onTilt;
		this.onRates = onRates;
		this.onFeel = onFeel;
		this.feel = feel;
		this.getController = getController;
		this.open = false;
		this._cal = null;
		this._arm = null;
		this._raf = null;

		root.insertAdjacentHTML('beforeend', `
			<div id="setup" hidden>
				<div id="setup-box">
					<p class="setup-title">SETUP <span class="setup-close">TAB TO CLOSE</span></p>

					<section>
						<h2>Radio</h2>
						<p id="setup-pad" class="setup-line"></p>
						<div id="setup-bars"></div>
						<div class="setup-row">
							<button id="setup-cal" type="button">CALIBRATE</button>
							<button id="setup-arm" type="button">ARM SWITCH</button>
							<span id="setup-radio-note" class="setup-note"></span>
						</div>
						<div id="setup-wizard" hidden>
							<p id="wiz-step" class="setup-note"></p>
							<p id="wiz-prompt"></p>
							<p id="wiz-hint" class="setup-note"></p>
							<div class="wiz-track"><div id="wiz-bar"></div></div>
							<p id="wiz-message" class="setup-note"></p>
							<button id="wiz-cancel" type="button">CANCEL</button>
						</div>
						<pre id="setup-summary" hidden></pre>
					</section>

					<section>
						<h2>Feel</h2>
						<div id="setup-feel" class="setup-row"></div>
						<p class="setup-note">Smooth: no propwash shake, a steadied camera. Real: the measured airframe, camera bolted to the frame.</p>
					</section>

					<section>
						<h2>Rates</h2>
						<div id="setup-rates" class="setup-row"></div>
					</section>

					<section>
						<h2>Camera tilt</h2>
						<div class="setup-row">
							<input id="setup-tilt" type="range" min="0" max="60" step="1" value="${tilt}">
							<span id="setup-tilt-val">${tilt}°</span>
						</div>
					</section>

					<section>
						<h2>Keys</h2>
						<p class="setup-note">W S throttle · A D yaw · arrows roll and pitch · R respawn · V view · M mode · P rates · Space pause</p>
					</section>
				</div>
			</div>`);
		const q = (s) => root.querySelector(s);
		this.el = {
			panel: q('#setup'), pad: q('#setup-pad'), bars: q('#setup-bars'),
			cal: q('#setup-cal'), arm: q('#setup-arm'), note: q('#setup-radio-note'),
			wizard: q('#setup-wizard'), step: q('#wiz-step'), prompt: q('#wiz-prompt'), hint: q('#wiz-hint'),
			bar: q('#wiz-bar'), message: q('#wiz-message'), cancel: q('#wiz-cancel'),
			summary: q('#setup-summary'), rates: q('#setup-rates'), feel: q('#setup-feel'),
			tilt: q('#setup-tilt'), tiltVal: q('#setup-tilt-val'),
		};

		for (const name of FEELS) {
			const b = document.createElement('button');
			b.type = 'button';
			b.dataset.feel = name;
			b.textContent = name;
			b.addEventListener('click', () => { this.feel = name; saveFeel(name); this.onFeel(name); });
			this.el.feel.appendChild(b);
		}

		for (const [name, preset] of Object.entries(RATE_PRESETS)) {
			const b = document.createElement('button');
			b.type = 'button';
			b.dataset.preset = name;
			b.textContent = preset.label ?? name;
			b.addEventListener('click', () => this.onRates(name));
			this.el.rates.appendChild(b);
		}

		this.el.tilt.addEventListener('input', () => {
			const v = Number(this.el.tilt.value);
			this.el.tiltVal.textContent = `${v}°`;
			try { localStorage.setItem(TILT_KEY, String(v)); } catch { /* private mode */ }
			this.onTilt(v);
		});

		this.el.cal.addEventListener('click', () => this.startCalibration());
		this.el.arm.addEventListener('click', () => this.startArmDetect());
		this.el.cancel.addEventListener('click', () => this.stopWizard());
	}

	toggle(force) {
		this.open = force ?? !this.open;
		this.el.panel.hidden = !this.open;
		if (this.open) this._loop(); else this.stopWizard();
	}

	// The panel has its own loop: it opens before the flight loop exists.
	_loop() {
		if (this._raf) return;
		let last = performance.now();
		const tick = () => {
			if (!this.open) { this._raf = null; return; }
			this._raf = requestAnimationFrame(tick);
			const now = performance.now();
			const dt = Math.min(100, now - last);
			last = now;
			const pad = this.input.getGamepad();
			if (this._cal && pad) this._stepCalibration(pad, dt);
			if (this._arm && pad) this._stepArmDetect(pad);
			this.render(pad);
		};
		this._raf = requestAnimationFrame(tick);
	}

	render(pad) {
		const controller = this.getController();
		for (const b of this.el.feel.children) b.classList.toggle('on', b.dataset.feel === this.feel);
		for (const b of this.el.rates.children) {
			b.classList.toggle('on', !!controller && b.dataset.preset === controller.preset);
		}
		if (!pad) {
			this.el.pad.textContent = 'No radio seen. Plug one in and move a stick. EdgeTX and OpenTX radios need Joystick mode on the USB menu.';
			this.el.bars.replaceChildren();
			this.el.cal.disabled = true;
			this.el.arm.disabled = true;
			this.el.note.textContent = '';
			return;
		}
		const wizard = this._cal || this._arm;
		this.el.cal.disabled = !!wizard;
		this.el.arm.disabled = !!wizard;
		this.el.pad.textContent = `${pad.id}. ${pad.axes.length} axes, ${pad.buttons.length} buttons.`;
		const calibrated = this.input.isCalibrated(pad.id);
		const arm = this.input.armMap;
		this.el.note.textContent = wizard ? ''
			: `${calibrated ? 'calibrated' : 'not calibrated, using a guessed mapping'} · arm switch ${arm ? `on signal ${arm.signal}` : 'not set, arming on the pad'}`;

		// Live bars: every signal, so a pilot can see which one is which.
		const signals = padSignals(pad);
		if (this.el.bars.children.length !== signals.length) {
			this.el.bars.replaceChildren(...signals.map((_, i) => {
				const row = document.createElement('div');
				row.className = 'bar-row';
				row.innerHTML = `<span class="bar-label">${i < pad.axes.length ? `axis ${i}` : `btn ${i - pad.axes.length}`}</span><div class="bar-track"><div class="bar-fill"></div></div>`;
				return row;
			}));
		}
		signals.forEach((v, i) => {
			const fill = this.el.bars.children[i].lastElementChild.firstElementChild;
			fill.style.left = `${((v + 1) / 2) * 100}%`;
		});
	}

	// Calibration: upstream's wizard, verbatim in behaviour.
	startCalibration() {
		const pad = this.input.getGamepad();
		if (!pad) return;
		this._calPadId = pad.id;
		this._cal = beginCalibration(padSignals(pad).length, pad.axes.length);
		this.el.summary.hidden = true;
		this.el.wizard.hidden = false;
	}

	_stepCalibration(pad, dt) {
		this._cal = feedSample(this._cal, padSignals(pad), dt);
		const result = calibrationResult(this._cal);
		const { step, total } = calProgress(this._cal);
		this.el.step.textContent = `STEP ${step}/${total}`;
		this.el.prompt.textContent = this._cal.prompt;
		this.el.hint.textContent = this._cal.hint;
		this.el.message.textContent = this._cal.message ?? '';
		const signals = padSignals(pad);
		const centers = this._cal.centers;
		let best = 0;
		for (let i = 0; i < signals.length; i++) {
			if (Math.abs(signals[i] - (centers?.[i] ?? 0)) > Math.abs(signals[best] - (centers?.[best] ?? 0))) best = i;
		}
		this.el.bar.style.left = `${(((signals[best] ?? 0) + 1) / 2) * 100}%`;
		if (result) {
			this.input.setCalibration(this._calPadId, result);
			this.el.summary.textContent = calSummaryLines(result).join('\n');
			this.el.summary.hidden = false;
			this.stopWizard();
		}
	}

	// The arm switch: snapshot with the switch off, then wait for the flip.
	startArmDetect() {
		const pad = this.input.getGamepad();
		if (!pad) return;
		this._armPadId = pad.id;
		this._arm = beginArmDetect(padSignals(pad));
		this.el.summary.hidden = true;
		this.el.wizard.hidden = false;
		this.el.step.textContent = 'ARM SWITCH';
		this.el.prompt.textContent = 'FLIP YOUR ARM SWITCH';
		this.el.hint.textContent = 'hands off the sticks, switch was off when you pressed the button';
		this.el.message.textContent = '';
	}

	_stepArmDetect(pad) {
		this._arm = feedArmDetect(this._arm, padSignals(pad));
		const m = this._arm.found;
		if (m) {
			this.input.setArmSwitch(this._armPadId, m);
			this.el.summary.textContent = `arm switch  signal ${m.signal}  armed ${m.armedAbove ? 'above' : 'below'} ${m.threshold.toFixed(2)}\nflip it off, then on, to arm on the pad`;
			this.el.summary.hidden = false;
			this.stopWizard();
		}
	}

	stopWizard() {
		this._cal = null;
		this._arm = null;
		this._calPadId = null;
		this._armPadId = null;
		this.el.wizard.hidden = true;
	}
}
