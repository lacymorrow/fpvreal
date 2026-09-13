// Pure logic of the Operator Terminal (PHASE 02). No I/O, no DOM: importable
// by the browser-side terminal and by the selftest.

import { countersOf, currentBuild } from './buildnotes-model.mjs';
import { asText } from './lib/as-text.mjs';

// Readable size of a scene directory. Decimal (1 GB = 1e9), to stay consistent
// with bootstrap.js (storageString) and with what the system displays.
export function formatBytes(n) {
	if (!Number.isFinite(n) || n <= 0) return '—';
	if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
	if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
	if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
	return `${Math.round(n)} B`;
}

// `scenes`: an array of { slug, name, bytes } when the terrain cache is known;
// `null` when /__map-api/scenes is unreachable (the list then shows an error
// state).
// `shared` : whether the server runs in `shared` mode (V1). The footer says
// WHERE the game runs, which is the server's mode — not whether acquisition is
// open. Every distributed desktop build ships with acquisition closed, and a
// footer keyed on it called the desktop client a SHARED SERVER (D1).
export function terminalModel({ operator, scenes, shared = false }) {
	// asText(), not String(): the operator file is read, not written, here, and
	// `{"name": {"toString": null}}` is valid JSON that String() throws on —
	// FIELD is the first screen after boot and it has to mount whatever the file
	// holds (fuzzing finding 3, tools/lib/as-text.mjs).
	const name = asText(operator?.name).toUpperCase() || 'UNKNOWN';
	const sessions = Array.isArray(operator?.sessions) ? operator.sessions : [];
	const known = Array.isArray(scenes);

	const areas = known
		? scenes.map((s) => ({ slug: s.slug, name: s.name, size: formatBytes(s.bytes) }))
		: [];

	// Build number shown in the footer (PHASE 21, BUILD NOTES): derived from the
	// operator counters, never from a separate state.
	const build = currentBuild(countersOf(operator));
	// D1: two words, and nothing else. The operator name and their counters are
	// rendered by ARCHIVE > OPERATOR, which is where they belong — repeating them
	// under every screen turned FIELD into a dashboard (Bible section 30).
	const footer = [
		shared ? 'SHARED SERVER' : 'LOCAL INSTALLATION',
		`BUILD ${build}`,
	].join(' · ');

	return {
		operatorName: name,
		areas,
		areasKnown: known,
		footer,
		build,
		lastSession: sessions.length ? sessions[sessions.length - 1] : null,
	};
}
