// SESSION LOG (PHASE 17, Bible §28 and §30). Pure client screens:
// `screen`/`button` from terminal.js, no Three/Rapier dependency. All the
// formatting lives in tools/session-log-model.mjs — here, nothing but DOM.
//
// terminal.js imports this module ON DEMAND (`await import`), as it already
// does for the scanner: a static import would close a cycle, since this file
// imports screen/button from terminal.js.
import { screen, button, backRow, fetchScenes, emptyState } from './terminal.js';
import { menuNav, blockNav } from './menu-nav.js';
import * as operatorApi from './operator.js';
import { armConfirm } from './confirm-button.js';
// The portrait is inline SVG (issue #264): it opens no WebGL context, and this
// screen stays the pure client its header announces.
import { dronePortrait } from './drone-portrait.js';
import { targetLivery } from '../tools/target-build.mjs';
import { liveryLabel } from '../tools/target-livery.mjs';
// The TARGET LOG screen left with issue #26: the FAMILIES section of DATA is
// where the targets met are read now, grouped by the family they belong to.
// `targetLogEntries()` stays in the model — it feeds that graph and the Home
// counters.
import {
	SESSION_FILTERS, filterSessions, sessionRow, sessionDetail,
} from '../tools/session-log-model.mjs';

// Capture thumbnails. `dataUrl` only exists on the dedicated route's response
// (spec D4) — hence the guard: a session read from the operator cache simply
// shows nothing.
function gallery(photos) {
	const wrap = document.createElement('div');
	wrap.className = 'session-shots';
	for (const p of photos ?? []) {
		if (!p.dataUrl) continue;
		const img = document.createElement('img');
		img.src = p.dataUrl;
		img.alt = 'CAPTURE';
		wrap.appendChild(img);
	}
	return wrap;
}

// The machine, redrawn from `family` + `buildSeed` — the two fields the server
// has persisted in clear on the session since PHASE 07. Nothing to migrate:
// the whole logged history knows how to draw itself. A session that has
// neither (dev paths, NOMINAL override, logs from before the target) renders
// NOTHING — not an empty frame holding the space.
//
// Returns `null` or `{ el, stop }`: the caller must keep `stop` and call it
// when leaving the screen, otherwise the portrait keeps spinning on a detached
// tree.
function portraitOf(target, { caption = null } = {}) {
	const p = dronePortrait({ family: target?.family, buildSeed: target?.buildSeed });
	if (!p) return null;
	const wrap = document.createElement('div');
	wrap.className = 'session-portrait';
	if (caption) {
		const head = document.createElement('pre');
		head.textContent = caption;
		wrap.appendChild(head);
	}
	wrap.appendChild(p.el);
	return { el: wrap, stop: p.stop };
}

// SESSION LOG (Bible §28). Filterable list, ↑/↓ cursor, ←/→ changes filter,
// Enter opens the record, Escape goes back — the same grammar as TARGET SCAN.
// That grammar lives in menu-nav.js (issue #123): every row is a real button,
// the cursor is native focus — clickable, tabbable, readable by assistive
// technology, and drivable with a gamepad.
//
// Resolves `undefined` (back to the terminal) or an area slug (REVISIT AREA
// coming back up from the record).
export function runSessionLog(root, { operator, scenes = null } = {}) {
	// Most recent on top: that is what the operator has just lived through. A
	// local copy, because a deletion changes it without touching the cache.
	const all = [...(operator?.sessions ?? [])].reverse();

	return new Promise((resolve) => {
		let filter = 'ALL';
		let busy = false; // a record is open: the list stops responding
		let done = false;
		let nav = null;

		const s = screen(root);
		const rows = () => filterSessions(all, filter);

		const finish = (value) => {
			if (done) return;
			done = true;
			nav?.detach();
			s.remove();
			resolve(value);
		};

		// `focusIdx`: the row to put the cursor back on after the re-render — the
		// one you came from when closing a record, the first one otherwise.
		const draw = (focusIdx = 0) => {
			const list = rows();
			// createElement rather than innerHTML, like the rest of the house:
			// that is what makes the screen mountable on the fake DOM.
			s.box.replaceChildren();
			const title = document.createElement('pre');
			title.textContent = 'SESSION LOG';
			s.box.appendChild(title);

			const wrap = document.createElement('div');
			wrap.className = 'terminal-list';
			if (list.length) {
				list.forEach((sess, i) => wrap.appendChild(button(sessionRow(sess), () => openAt(i), 'terminal-row')));
			} else {
				wrap.appendChild(emptyState('NO SESSIONS MATCH THIS FILTER'));
			}
			s.box.appendChild(wrap);

			const filters = document.createElement('div');
			filters.className = 'terminal-nav';
			SESSION_FILTERS.forEach((f, i) => {
				if (i) filters.appendChild(document.createTextNode(' · '));
				// The active filter is written in reverse video, like every active
				// state in the game: in brackets it was indistinguishable from a
				// keyboard key quoted in a hint (keyHints).
				const b = button(f, () => {
					filter = f;
					draw();
				});
				if (f === filter) b.dataset.on = 'true';
				filters.appendChild(b);
			});
			s.box.appendChild(filters);

			backRow(s.box, () => finish(undefined));

			const rowEls = wrap.querySelectorAll('.terminal-row');
			(rowEls[Math.min(focusIdx, rowEls.length - 1)] ?? s.box.querySelector('button'))?.focus();
		};

		const openAt = async (i) => {
			if (busy || done) return;
			const sess = rows()[i];
			if (!sess) return;
			busy = true;
			s.el.hidden = true;
			const r = await runSessionDetail(root, sess.id, { scenes });
			if (r?.revisit) return finish(r.revisit);
			if (r?.deleted) {
				const k = all.findIndex((x) => x.id === r.deleted);
				if (k >= 0) all.splice(k, 1);
			}
			busy = false;
			s.el.hidden = false;
			draw(i);
		};

		nav = menuNav(s.el, {
			back: () => finish(undefined),
			// ←/→ changes filter wherever the cursor is, as before.
			onDir: (dir) => {
				const d = dir === 'right' ? 1 : -1;
				const i = SESSION_FILTERS.indexOf(filter);
				filter = SESSION_FILTERS[(i + d + SESSION_FILTERS.length) % SESSION_FILTERS.length];
				draw();
				return true;
			},
			focusFirst: false, // draw() places the cursor itself
		});

		draw();
	});
}

// A session's record (Bible §28). Loads the COMPLETE session through the
// dedicated route: this is the only place in the game that fetches the images.
//
// Resolves `undefined` (back), `{ revisit: slug }` or `{ deleted: sessionId }`.
export async function runSessionDetail(root, sessionId, { scenes = null } = {}) {
	const s = screen(root);
	const head = document.createElement('pre');
	head.textContent = 'SESSION\n\nREADING LOG…';
	s.box.appendChild(head);

	// While loading, this record has nothing to navigate yet but screens left
	// visible underneath do: blocking the stack stops an arrow key or a gamepad
	// button acting behind READING LOG… (issue #123).
	const unblock = blockNav(s.el);

	let session = null;
	let error = null;
	try { session = await operatorApi.getSession(sessionId); }
	catch (e) { error = e; }

	// The screen may have been unmounted during the request.
	if (!s.el.isConnected) { unblock(); return undefined; }

	if (error) {
		unblock();
		head.textContent = `SESSION\n\nLOG UNREADABLE — ${error.message}`;
		return new Promise((resolve) => {
			const close = () => { nav.detach(); s.remove(); resolve(undefined); };
			backRow(s.box, close);
			const nav = menuNav(s.el, { back: close });
		});
	}

	// REVISIT is only offered if the area is still on disk. `scenes` is `null`
	// when the caller does not already have it: we then ask for it ourselves.
	const known = scenes ?? await fetchScenes().catch(() => null);
	const areaKnown = Array.isArray(known) && known.some((sc) => sc.slug === session.area);
	if (!s.el.isConnected) { unblock(); return undefined; }
	unblock();

	return new Promise((resolve) => {
		let done = false;
		let nav = null;
		// Held here so that `finish` can stop it: a closed record must not leave
		// an animation running on a detached tree.
		let portrait = null;
		const finish = (value) => {
			if (done) return;
			done = true;
			portrait?.stop();
			nav?.detach();
			s.remove();
			resolve(value);
		};

		// `sessionDetail()` carries the operator's own note, typed by a player,
		// and the weather regime, which comes off the wire. Interpolated into
		// innerHTML that was a stored injection: on a shared server one player's
		// note renders in another operator's browser, in the origin that holds
		// their bearer key (src/operator.js). It is text — so it goes in as text.
		const detail = document.createElement('pre');
		detail.textContent = sessionDetail(session);
		s.box.replaceChildren(detail);
		// The machine before its images: the record speaks of what flew, the
		// captures of what it saw.
		// Its livery as a caption (issue #284): the portrait is monochrome — this
		// is the terminal — but the record can SAY what colours the machine wore.
		// Derived from the seed, like the portrait: no migration.
		portrait = portraitOf(session.target, { caption: session.target?.buildSeed ? liveryLabel(targetLivery({ seed: session.target.buildSeed, family: session.target.family })) : null });
		if (portrait) s.box.appendChild(portrait.el);
		if (session.photos?.length) s.box.appendChild(gallery(session.photos));

		if (areaKnown) {
			// REVISIT AREA does NOT replay the session (issue #54): it hands the
			// slug back to the terminal, which leaves by the normal flight path —
			// fresh TARGET SCAN, current weather, new entry state, terrain read
			// again from disk.
			s.box.appendChild(button('REVISIT AREA', () => finish({ revisit: session.area }), 'terminal-cta'));
		}
		// A session is the only record of a flight, and it was deleted on one
		// press. Same guard as every other destructive action (#213): the first
		// press arms the button, the second one deletes, and the arming lapses
		// on its own if the cursor leaves.
		const del = button('DELETE SESSION', null, 'terminal-cta');
		armConfirm(del, async () => {
			if (done) return;
			try { await operatorApi.deleteSession(session.id); }
			catch (e) {
				console.warn('[session-log] deletion refused', e);
				const warn = document.createElement('pre');
				warn.textContent = `\nDELETE REFUSED — ${e.message}`;
				s.box.appendChild(warn);
				return;
			}
			finish({ deleted: session.id });
		});
		s.box.appendChild(del);
		backRow(s.box, () => finish(undefined));

		nav = menuNav(s.el, { back: () => finish(undefined) });
	});
}
