// The JUKEBOX screen (issue #120). A VIEW onto src/radio.js, nothing more: it
// subscribes, it repaints, and it never owns playback. Closing this screen does
// not stop the radio — that is the whole point of the feature.
//
// Same grammar as src/session-log.js: a list of real buttons, the cursor IS
// native focus, Escape goes back up. Two deliberate differences:
//
//   1. ←/→ pilotent la TRANSPORT et non le filtre. C'est l'idiome radio, et
//      that is what "like a radio" means. The pool filter stays a row of
//      buttons reached with the cursor.
//   2. draw() and paint() are separate. The automatic hand-over happens while
//      the operator is scrolling the list: a replaceChildren() at that moment
//      would tear the cursor out of their hands mid-scroll. paint() only
//      rewrites text.
import { screen, button, keyHints, emptyState } from './terminal.js';
import { menuNav } from './menu-nav.js';
import { radio } from './radio.js';
import {
	libraryFilters, filterLibrary, jukeboxRow, nowPlayingLine, librarySummary,
} from '../tools/jukebox-model.mjs';

// Resolves when going back up to the mode choice. Returns nothing: there is
// nothing to report from listening.
export function runJukebox(root) {
	return new Promise((resolve) => {
		let done = false;
		let nav = null;
		let off = () => {};
		let library = [];
		let shown = [];
		let filter = 'ALL';
		let rowEls = [];
		let nowEl = null;
		let toggleEl = null;

		const s = screen(root, 'terminal-jukebox');

		const finish = () => {
			if (done) return;
			done = true;
			nav?.detach();
			// Without this unsubscribe, closing would leave a callback holding a
			// detached DOM tree for the rest of the session.
			off();
			s.remove();
			resolve();
		};

		// On air: the radio knows it, the screen does not.
		const onAir = (track) => radio.owns && radio.current?.id === track.id;

		// Rewrites ONLY text — no node is created or replaced.
		const paint = () => {
			if (done) return;
			if (nowEl) nowEl.textContent = nowPlayingLine(radio.owns ? radio.current : null);
			if (toggleEl) toggleEl.textContent = radio.playing ? 'STOP' : 'PLAY';
			shown.forEach((track, i) => {
				const el = rowEls[i];
				if (el) el.textContent = jukeboxRow(track, { playing: onAir(track) });
			});
		};

		const draw = (focusIdx = 0) => {
			shown = filterLibrary(library, filter);
			s.box.replaceChildren();

			const title = document.createElement('pre');
			title.textContent = 'JUKEBOX';
			s.box.appendChild(title);

			const summary = document.createElement('pre');
			summary.className = 'terminal-foot';
			summary.textContent = librarySummary(library);
			s.box.appendChild(summary);

			// terminal-log already carries the DATA level and tabular figures: the
			// on-air line lines up with the rows without one more rule.
			nowEl = document.createElement('pre');
			nowEl.className = 'terminal-log';
			s.box.appendChild(nowEl);

			const wrap = document.createElement('div');
			wrap.className = 'terminal-list';
			if (shown.length) {
				shown.forEach((track, i) => {
					wrap.appendChild(button(
						jukeboxRow(track, { playing: onAir(track) }),
						// The DISPLAYED list becomes the programme: filtering on
						// RACE5 puis lancer donne une radio race5.
						() => { radio.playAt(i, shown).catch(() => {}); },
						'terminal-row',
					));
				});
			} else {
				wrap.appendChild(emptyState(library.length ? 'NO TRACK IN THIS POOL' : 'NO MUSIC LIBRARY'));
			}
			s.box.appendChild(wrap);
			rowEls = wrap.querySelectorAll('.terminal-row');

			const filters = document.createElement('div');
			filters.className = 'terminal-nav';
			libraryFilters(library).forEach((f, i) => {
				if (i) filters.appendChild(document.createTextNode(' · '));
				const label = f.toUpperCase();
				// The active filter is written in reverse video, like every active
				// state in the game. It used to read in brackets — typographically
				// identical to a keyboard key quoted in a hint (keyHints).
				const b = button(label, () => {
					filter = f;
					draw();
				});
				if (f === filter) b.dataset.on = 'true';
				filters.appendChild(b);
			});
			s.box.appendChild(filters);

			const transport = document.createElement('div');
			transport.className = 'terminal-nav';
			transport.appendChild(button('PREV', () => { radio.prev().catch(() => {}); }));
			transport.appendChild(document.createTextNode(' · '));
			toggleEl = button('PLAY', () => { radio.toggle().catch(() => {}); });
			transport.appendChild(toggleEl);
			transport.appendChild(document.createTextNode(' · '));
			transport.appendChild(button('NEXT', () => { radio.next().catch(() => {}); }));
			s.box.appendChild(transport);

			s.box.appendChild(button('BACK', () => finish(), 'terminal-cta'));
			// The JUKEBOX sits directly under the root: Escape goes back up there,
			// and it says so — like the bench (src/bench.js).
			s.box.appendChild(keyHints([['ESC', 'OPERATION MODE'], ['←/→', 'PREV / NEXT']]));

			paint();
			(rowEls[Math.min(focusIdx, rowEls.length - 1)] ?? s.box.querySelector('button'))?.focus();
		};

		nav = menuNav(s.el, {
			back: () => finish(),
			// The transport controls, wherever the cursor is.
			onDir: (dir) => {
				if (dir === 'right') radio.next().catch(() => {});
				else if (dir === 'left') radio.prev().catch(() => {});
				else return false;
				return true;
			},
			focusFirst: false,   // draw() places the cursor itself
		});

		off = radio.onChange(paint);

		draw();
		// The library is almost always already there (the menu music loaded the
		// manifest on the first gesture): ready() is memoised and hands back in a
		// microtask. The first draw() avoids the empty screen in the
		// cas contraire.
		radio.ready().then((lib) => {
			if (done) return;
			library = lib;
			draw();
		});
	});
}
