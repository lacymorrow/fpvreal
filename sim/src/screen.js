// Mounting a full-frame screen, once for all of them (#139).
//
// bootstrap.js and terminal.js each mounted their own: same div, same box,
// same watchReveal(). Only one of the two copies had ended up with `close()`
// — the inverse of #67 — and the bootstrap chain stayed the only place in the
// game whose screens leave in one hard cut.
//
// This module knows nothing but the furniture: the classes come from the
// caller, because they are what says which screen this is.
import { watchReveal, exitScreen } from './motion.js';

// `createElement` rather than `innerHTML`: rigorously the same tree, but
// without going through the HTML parser — which makes the screen mountable on
// the fake DOM of tools/lib/fake-dom.mjs, the way the fake AudioContext makes
// the sound testable without a browser.
export function mountScreen(root, { cls = '', boxCls = '' } = {}) {
	const el = document.createElement('div');
	el.className = `bootstrap ${cls}`.trim();
	const box = document.createElement('div');
	box.className = `bootstrap-box ${boxCls}`.trim();
	el.appendChild(box);
	root.appendChild(el);
	// The screen prints from top to bottom (issue #224): every block added to
	// the box — now or after a fetch — gets its delay.
	const unwatch = watchReveal(box);
	const remove = () => { unwatch(); el.remove(); };
	// `close()`: the same thing, but the screen prints backwards first and the
	// promise only hands back once it is gone (#67). That is what allows two
	// screens to be CHAINED without the second one's cascade starting in the
	// frame where the first disappears. `remove()` stays synchronous: most
	// screens unmount because the menu is being left, and there is nothing to
	// watch fade out then.
	//
	// `close({ revealBehind: true })` for the last screen of a chain, the one
	// that opens onto the flight: it alone takes its black background with it.
	// By default the background holds until unmount, otherwise the 3D scene
	// loaded underneath shows between two screens.
	const close = (opts) => exitScreen(el, opts).then(remove);
	return { el, box, remove, close };
}

// A screen button. The brackets belong to the CTA and to it alone: that is
// what tells them apart from a keyboard key quoted in a hint (terminal.js,
// keyHints). No `title`: the native tooltip is browser furniture, which
// Bible §44 refuses everywhere else — a button says what it does in its label,
// or the hint line under it says it.
export function screenButton(label, onClick, cls = 'terminal-link') {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = cls;
	b.textContent = cls.split(' ').some((c) => c === 'terminal-cta' || c === 'bootstrap-btn')
		? `[ ${label} ]`
		: label;
	b.onclick = onClick;
	return b;
}

// The one escape used by every screen that still composes markup as a string.
//
// The rule comes first: an untrusted value goes in through `textContent`, or
// through a node built with the DOM API. Nothing in this game NEEDS to build
// a fragment by hand. But a few call sites legitimately assemble a static
// skeleton as a string, and a value slipped into one of those is a stored
// injection in the very origin that holds the operator bearer key
// (src/operator.js) — a player's session note, or a scene name auto-filled
// from a Nominatim `display_name`, i.e. from a third party's HTTP response.
//
// So: one helper, exported from here rather than re-open-coded per module,
// because five slightly different escapes are how one of them ends up missing
// a character.
export function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
