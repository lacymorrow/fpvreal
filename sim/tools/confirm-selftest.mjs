// Selftest of the terminal's confirmation gesture (src/confirm-button.js, #213).
//
// It replaces the last two browser confirm() calls — REMOVE TERRAIN and
// RESET SETTINGS. What matters: the FIRST press destroys nothing, the SECOND
// one does, and an armed button does not stay armed forever.
//
// Run: node tools/confirm-selftest.mjs

import assert from 'node:assert/strict';
import { installFakeDom } from './lib/fake-dom.mjs';
import { nextConfirmState, confirmLabel, CONFIRM_TIMEOUT_MS } from '../src/confirm-button.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

// --- the state machine, without a DOM ---------------------------------------

t('nextConfirmState: a press on a neutral button ARMS, without acting', () => {
	assert.deepEqual(nextConfirmState(false), { armed: true, fire: false });
});

t('nextConfirmState: a press on an armed button ACTS, and disarms', () => {
	assert.deepEqual(nextConfirmState(true), { armed: false, fire: true });
});

t('confirmLabel: the armed label says what is about to happen', () => {
	assert.equal(confirmLabel('[ REMOVE TERRAIN ]'), '[ REMOVE TERRAIN — CONFIRM ]');
});

t('confirmLabel: CONFIRM stays INSIDE the brackets (screen.js bracket convention)', () => {
	// `[ X ] — CONFIRM` read as a button followed by a loose word. The brackets
	// enclose the whole label of a CTA, so they must enclose this one too.
	assert.equal(confirmLabel('[ RESET SETTINGS ]'), '[ RESET SETTINGS — CONFIRM ]');
	assert.ok(!confirmLabel('[ RESET SETTINGS ]').includes('] —'));
});

t('confirmLabel: a bracket-less label — an inline link — just takes the suffix', () => {
	assert.equal(confirmLabel('REMOVE TERRAIN'), 'REMOVE TERRAIN — CONFIRM');
});

// --- the wiring, on the fake DOM --------------------------------------------

const dom = installFakeDom();
const { armConfirm } = await import('../src/confirm-button.js');

const mkButton = (label) => {
	const b = document.createElement('button');
	b.textContent = label;
	dom.root.appendChild(b);
	return b;
};

await ta('the first press destroys nothing and relabels the button', async () => {
	let fired = 0;
	const b = mkButton('[ REMOVE TERRAIN ]');
	armConfirm(b, () => { fired++; });
	b.click();
	assert.equal(fired, 0, 'nothing fired on the first press');
	assert.equal(b.textContent, '[ REMOVE TERRAIN — CONFIRM ]');
});

await ta('the second press acts, exactly once', async () => {
	let fired = 0;
	const b = mkButton('[ RESET ]');
	armConfirm(b, () => { fired++; });
	b.click();
	b.click();
	assert.equal(fired, 1, 'the action fires exactly once');
	assert.equal(b.textContent, '[ RESET ]', 'and the button is back to neutral');
});

await ta('a third press re-arms instead of acting again', async () => {
	// Without the return to neutral, a button left armed would turn the next
	// press — arriving for something else entirely — into a second destruction.
	let fired = 0;
	const b = mkButton('[ RESET ]');
	armConfirm(b, () => { fired++; });
	b.click(); b.click(); b.click();
	assert.equal(fired, 1, 'still a single action');
	assert.equal(b.textContent, '[ RESET — CONFIRM ]', 'the third press re-arms');
});

await ta('leaving the button disarms it (mouse as well as focus)', async () => {
	let fired = 0;
	const b = mkButton('[ REMOVE TERRAIN ]');
	armConfirm(b, () => { fired++; });
	b.click();
	b.dispatchEvent({ type: 'mouseleave' });
	assert.equal(b.textContent, '[ REMOVE TERRAIN ]', 'cursor gone, the button disarms');
	b.click();
	assert.equal(fired, 0, 'the next press re-arms, it does not destroy');
});

await ta('arming lapses on its own after the timeout', async () => {
	let fired = 0;
	const b = mkButton('[ REMOVE TERRAIN ]');
	armConfirm(b, () => { fired++; }, { timeoutMs: 30 });
	b.click();
	assert.equal(b.textContent, '[ REMOVE TERRAIN — CONFIRM ]');
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(b.textContent, '[ REMOVE TERRAIN ]', 'back to neutral with no intervention');
	b.click();
	assert.equal(fired, 0, 'and a distracted press destroys nothing');
});

await ta('the default timeout leaves time to read, without being forever', async () => {
	assert.ok(CONFIRM_TIMEOUT_MS >= 2000 && CONFIRM_TIMEOUT_MS <= 10000, `unreasonable timeout: ${CONFIRM_TIMEOUT_MS}`);
});

await ta('detaching makes the button inert', async () => {
	let fired = 0;
	const b = mkButton('[ RESET ]');
	const off = armConfirm(b, () => { fired++; });
	off();
	b.click(); b.click();
	assert.equal(fired, 0, 'nothing fires any more');
	assert.equal(b.textContent, '[ RESET ]');
});

dom.restore();
console.log(`\n${n} confirm tests OK`);
