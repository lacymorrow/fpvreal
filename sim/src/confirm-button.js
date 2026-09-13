// The terminal's confirmation gesture (issue #213).
//
// Bible §44 refuses browser UI: a `confirm()` is a system modal, it breaks the
// terminal fiction and it navigates neither with the game's keyboard nor with
// a gamepad. But a destructive action cannot fire on a single distracted press
// either. #211 laid down the answer for acquisition, and this generalises it:
//
//     [ REMOVE TERRAIN ]  →  [ REMOVE TERRAIN — CONFIRM ]  →  done
//
// The second press IS the confirmation. Arming lapses on its own: after
// TIMEOUT_MS, or as soon as the cursor leaves the button — otherwise an armed
// button would wait forever for the next press, which could arrive for a
// completely unrelated reason.
//
// The decision logic is pure and tested without a DOM (tools/confirm-selftest.mjs):
// `nextConfirmState` says what a press must produce, `armConfirm` only wires it
// onto a real button.

export const CONFIRM_TIMEOUT_MS = 4000;

// The brackets belong to the CTA and enclose the WHOLE label (src/screen.js):
// `[ REMOVE TERRAIN — CONFIRM ]`, never `[ REMOVE TERRAIN ] — CONFIRM`, which
// would read as a bracketed button followed by a loose word. A label without
// brackets — an inline link — simply takes the suffix.
const BRACKETED = /^\[\s([\s\S]*)\s\]$/;
export const confirmLabel = (label) => {
	const inner = String(label).match(BRACKETED);
	return inner ? `[ ${inner[1]} — CONFIRM ]` : `${label} — CONFIRM`;
};

// The state machine, in one function. `armed` is the button's current state;
// the return says the next state and whether the action must fire now.
export function nextConfirmState(armed) {
	return armed ? { armed: false, fire: true } : { armed: true, fire: false };
}

// Wires the gesture onto an existing button.
// - `button`: the element. Its current label becomes the neutral label.
// - `onConfirm`: called on the SECOND press only. May be async; the button
//   stays disarmed meanwhile, and a rejection does not leave it armed.
// - `timeoutMs`: return to the neutral state without a further press.
// Returns a function that disarms and detaches the lapse listeners.
export function armConfirm(button, onConfirm, { timeoutMs = CONFIRM_TIMEOUT_MS } = {}) {
	const neutral = button.textContent;
	let armed = false;
	let timer = 0;

	const disarm = () => {
		if (timer) { clearTimeout(timer); timer = 0; }
		if (!armed) return;
		armed = false;
		button.textContent = neutral;
		button.classList?.remove('cta-armed');
	};

	const onClick = async () => {
		const next = nextConfirmState(armed);
		if (!next.fire) {
			armed = true;
			button.textContent = confirmLabel(neutral);
			button.classList?.add('cta-armed');
			timer = setTimeout(disarm, timeoutMs);
			return;
		}
		disarm();
		await onConfirm();
	};

	button.addEventListener('click', onClick);
	// Leaving the button disarms it: with the cursor as with the focus, because
	// the terminal is navigated with the arrow keys as much as with the mouse.
	button.addEventListener('mouseleave', disarm);
	button.addEventListener('blur', disarm);

	return () => {
		disarm();
		button.removeEventListener('click', onClick);
		button.removeEventListener('mouseleave', disarm);
		button.removeEventListener('blur', disarm);
	};
}
