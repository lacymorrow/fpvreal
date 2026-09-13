import { stackedLockup } from './brand-lockup.js';

// The loading screen. The map menu became the operator terminal
// (terminal.js), the Tab panel moved into settings.js, and the flight OSD split
// into two layers at PHASE 12 (drone-osd.js and fpvtp-osd.js). All that is left
// here is loading — PHASE 13 moves it behind the TARGET SCAN.

export class Hud {
	constructor(root) {
		// The boot is a splash: docs/brand.md requires the STACKED lockup there,
		// symbol included. The long name in capitalised Departure Mono that used
		// to hold this spot rendered as "FPVTHEPLANET!" — a composition the
		// document allows nowhere.
		root.insertAdjacentHTML('beforeend', `
			<div id="loading" hidden><div class="box">
				${stackedLockup({ extra: 'loading-lockup' })}
				<p id="loading-status">LOADING…</p>
				<div class="bar"><div id="loading-bar"></div></div>
				<p id="loading-detail"></p>
				<p id="loading-clock"></p>
			</div></div>`);

		this.el = {
			loading: root.querySelector('#loading'),
			status: root.querySelector('#loading-status'),
			bar: root.querySelector('#loading-bar'),
			detail: root.querySelector('#loading-detail'),
			clock: root.querySelector('#loading-clock'),
		};
	}

	progress(text, fraction) {
		this.el.status.textContent = text;
		if (fraction !== undefined) this.el.bar.style.width = `${Math.round(fraction * 100)}%`;
	}

	detail(text) {
		this.el.detail.textContent = text;
	}

	show() { this.el.loading.hidden = false; }

	// A ticking clock is the cheapest way to tell "slow" apart from "hung", and
	// naming the current step says which part is the slow one.
	startClock() {
		const t0 = performance.now();
		this._stage = { name: '', at: t0 };
		this._clock = setInterval(() => {
			const total = (performance.now() - t0) / 1000;
			const inStage = (performance.now() - this._stage.at) / 1000;
			this.el.clock.textContent = this._stage.name
				? `${total.toFixed(0)} s — ${this._stage.name.toUpperCase()} FOR ${inStage.toFixed(0)} s`
				: `${total.toFixed(0)} s`;
		}, 250);
	}

	setStage(name) {
		if (this._stage) this._stage = { name, at: performance.now() };
	}

	// A failure used to be a dead end: a swapped text node on a stopped loading
	// screen, no button, no key, nothing but F5. Every boot failure lands here —
	// a blocked tile server, a refused WebAssembly chunk, a bad ?scene= slug —
	// and a stranger who has just been told something went wrong needs the next
	// gesture to be on screen, not in a habit they do not have.
	//
	// The way out is a reload of the bare page: location.pathname drops the
	// query string, so a ?scene= that does not exist is not retried for ever,
	// and the intro is already marked seen in sessionStorage, so it lands on
	// SELECT OPERATION MODE rather than replaying the whole ceremony.
	fail(err) {
		clearInterval(this._clock);
		// Error text is data, never markup: a message that carried user input
		// (an unknown ?scene= slug) used to run through innerHTML.
		const span = document.createElement('span');
		span.className = 'err';
		span.textContent = String(err);
		this.el.status.replaceChildren(span);
		this.el.bar.style.width = '0%';
		this.el.detail.textContent = '';
		this.el.clock.textContent = '';
		this.show();
		this._offerReload();
	}

	// Idempotent: two failures in a row (the boot chain can reject more than
	// once) must not stack two buttons or two key listeners.
	_offerReload() {
		if (this._failed) return;
		this._failed = true;
		const reload = () => { location.href = location.pathname; };
		const btn = document.createElement('button');
		// .bootstrap-btn is the global CTA of the whole product (style.css); the
		// loading screen has no button of its own to be consistent with.
		btn.className = 'bootstrap-btn';
		btn.type = 'button';
		btn.textContent = '[ RELOAD ]';
		btn.addEventListener('click', reload);
		this._keys = (e) => {
			if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); reload(); }
		};
		// Capture: nothing else is listening this early, but a failure during a
		// flight teardown could be, and this gesture must not be eaten.
		window.addEventListener('keydown', this._keys, { capture: true });
		const hint = document.createElement('p');
		hint.className = 'fail-hint';
		hint.textContent = 'ESC OR ENTER';
		this.el.status.parentElement.append(btn, hint);
		// Focus makes Enter work through the button itself and puts the ▌ cursor
		// on it, which is how every other screen marks where you are.
		try { btn.focus(); } catch { /* focus is never load-bearing */ }
	}

	ready() {
		clearInterval(this._clock);
		this.el.loading.hidden = true;
	}
}
