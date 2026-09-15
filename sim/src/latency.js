// The input latency bench. What the browser adds between a stick and the
// physics, measured, so the README can carry a number instead of a claim.
//
// Three things are measured:
//   1. how often the Gamepad API hands the page a new snapshot of the radio
//      (pad.timestamp changes), polled as fast as the browser allows;
//   2. how often the display refreshes (requestAnimationFrame);
//   3. the hold between a new snapshot and the physics step that consumes it,
//      which with per-substep sampling at 250 Hz is at most 4 ms.
// What it cannot measure is the radio's own USB latency or the gimbal: that
// needs a camera pointed at the stick and the screen.

import { padSignals } from './calibration.js';

const el = (id) => document.getElementById(id);
const PHYSICS_HZ = 250;

function stats(samples) {
	if (samples.length < 2) return null;
	const s = [...samples].sort((a, b) => a - b);
	const mean = s.reduce((a, b) => a + b, 0) / s.length;
	return { n: s.length, mean, p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
}

const fmt = (x) => (x === null || x === undefined ? '' : x.toFixed(1));

const snapshotGaps = [];
const frameGaps = [];
let lastTs = null;
let lastFrame = null;
let padSeen = null;
let movedFrames = 0;

// Poll as fast as the event loop allows, not just at frame rate: a snapshot
// that changes between frames is only visible this way.
const channel = new MessageChannel();
channel.port1.onmessage = poll;
function poll() {
	const pad = (navigator.getGamepads?.() ?? []).find(Boolean);
	if (pad) {
		padSeen = pad;
		if (lastTs !== null && pad.timestamp !== lastTs) {
			const gap = pad.timestamp - lastTs;
			if (gap > 0 && gap < 1000) snapshotGaps.push(gap);
		}
		lastTs = pad.timestamp;
	}
	channel.port2.postMessage(null);
}
channel.port2.postMessage(null);

function frame(now) {
	requestAnimationFrame(frame);
	if (lastFrame !== null) frameGaps.push(now - lastFrame);
	lastFrame = now;
	if (frameGaps.length > 600) frameGaps.splice(0, frameGaps.length - 600);
	if (snapshotGaps.length > 2000) snapshotGaps.splice(0, snapshotGaps.length - 2000);

	if (!padSeen) {
		el('pad').textContent = 'No radio seen. Plug one in and move a stick.';
		return;
	}
	const signals = padSignals(padSeen);
	const active = signals.some((v, i) => Math.abs(v - (window.__rest?.[i] ?? v)) > 0.05);
	window.__rest ??= [...signals];
	if (active) movedFrames++;

	const snap = stats(snapshotGaps);
	const fr = stats(frameGaps);
	el('pad').textContent = `${padSeen.id}. ${padSeen.axes.length} axes, ${padSeen.buttons.length} buttons.`;
	el('moving').textContent = active ? 'stick moving, measuring' : 'move a stick continuously for ten seconds';
	if (snap) {
		el('snap-hz').textContent = `${(1000 / snap.mean).toFixed(0)} Hz`;
		el('snap-mean').textContent = fmt(snap.mean);
		el('snap-p95').textContent = fmt(snap.p95);
		el('snap-max').textContent = fmt(snap.max);
		el('snap-n').textContent = snap.n;
	}
	if (fr) {
		el('frame-hz').textContent = `${(1000 / fr.mean).toFixed(0)} Hz`;
		el('frame-mean').textContent = fmt(fr.mean);
		el('frame-p95').textContent = fmt(fr.p95);
	}
	// Worst case added by the sim itself: a snapshot arriving just after a
	// substep waits one substep; the render then shows it at the next frame.
	const hold = 1000 / PHYSICS_HZ;
	el('hold').textContent = fmt(hold);
	if (snap && fr) {
		const worst = snap.p95 + hold + fr.p95;
		el('total').textContent = fmt(worst);
		el('report').value = [
			`FPV Real input latency bench, ${new Date().toISOString().slice(0, 10)}`,
			`radio: ${padSeen.id}`,
			`browser: ${navigator.userAgent}`,
			`gamepad snapshot: ${(1000 / snap.mean).toFixed(0)} Hz, mean ${fmt(snap.mean)} ms, p95 ${fmt(snap.p95)} ms, max ${fmt(snap.max)} ms, n=${snap.n}`,
			`display: ${(1000 / fr.mean).toFixed(0)} Hz, frame p95 ${fmt(fr.p95)} ms`,
			`physics hold: ${fmt(hold)} ms (250 Hz substep sampling)`,
			`worst case stick to pixel added by the browser and the sim: ${fmt(worst)} ms`,
		].join('\n');
	}
}
requestAnimationFrame(frame);

el('reset').addEventListener('click', () => {
	snapshotGaps.length = 0;
	frameGaps.length = 0;
	window.__rest = null;
	movedFrames = 0;
});
