// Operator-key authentication — the `shared` mode (VPS), issue #60.
//
// TWO mechanisms live here, and they do not touch each other:
//
//   1. the operator key — WHO speaks to the server. A 128-bit secret handed
//      out only once at creation, stored hashed, sent in `Authorization:
//      Bearer`. In `local` mode it is never looked at: the security boundary
//      there stays the loopback socket, the same one the dev server has.
//   2. FPVTP_ACQUIRE — WHO may bring a scene into existence on disk.
//      Independent of the first, and closed by default.
//
// Conflating them would be the design mistake the spec names explicitly
// (sim/docs/superpowers/specs/2026-09-07-dual-mode-deployment-design.md, D2).
//
// No dependency: node:crypto and node:fs.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// Crockford base32: no I, no L, no O, no U. A key can be read out loud and
// typed back without confusing 0/O or 1/I/L — it is the only recovery path for
// an operator, and it will go through a notebook.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_BYTES = 16;
const GROUP = 4;

export function generateKey() {
	const bits = [...randomBytes(KEY_BYTES)].map((b) => b.toString(2).padStart(8, '0')).join('');
	let out = '';
	// 128 bits do not divide by 5: the last symbol carries 3 bits of padding.
	// Nothing is truncated — all 128 bits are there.
	for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
	return out.match(new RegExp(`.{1,${GROUP}}`, 'g')).join('-');
}

// Tolerant to typing: case, dashes, spaces, and the confusions the alphabet
// precisely left out (O→0, I/L→1).
export function normalizeKey(raw) {
	return String(raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')
		.replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function hashKey(raw) {
	return createHash('sha256').update(normalizeKey(raw)).digest('hex');
}

const HASH_RE = /^[0-9a-f]{64}$/;

export function bearerOf(req) {
	const h = req?.headers?.authorization ?? '';
	const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
	return m ? m[1].trim() : null;
}

// --- the key index ----------------------------------------------------------
//
// `/__map-api/*` has no operator id in its path: the key is what says who
// speaks, so it must be possible to go back from a digest to an operator.
// Re-reading the user's 142 files (~170 kB each) on every request would cost
// tens of megabytes of I/O; the index is kept in memory and rebuilt when the
// directory moves. The mtime of the DIRECTORY is signal enough because
// _writeOperator() (api.mjs) and issueKey() below both write through rename()
// — which touches the directory entry, including for a file that already
// existed.
let index = null;
let indexStamp = null;
let indexDir = null;

export function invalidateKeyIndex() { index = null; }

// The hash is a TOP-level field written by JSON.stringify(…, '\t'): a line
// with a single tab. It is read from the raw text rather than parsing
// megabytes of sessions — and anchoring on the indentation puts a homonym
// string an operator might have typed in a note out of reach (a quote would be
// escaped there, and the indentation is deeper). The JSON.parse fallback only
// costs on a file that REALLY contains the word: no file from before #60 has
// it.
const KEY_HASH_LINE = /^\t"keyHash": "([0-9a-f]{64})",?$/m;

function keyHashOf(text) {
	const m = KEY_HASH_LINE.exec(text);
	if (m) return m[1];
	if (!text.includes('keyHash')) return null;
	try {
		const h = JSON.parse(text).keyHash;
		return HASH_RE.test(String(h ?? '')) ? h : null;
	} catch { return null; }
}

function buildIndex(dir) {
	const map = new Map();
	let names = [];
	try { names = fs.readdirSync(dir); } catch { return map; }
	for (const f of names) {
		if (!f.endsWith('.json')) continue;
		let text;
		try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
		const h = keyHashOf(text);
		if (h) map.set(h, f.slice(0, -5));
	}
	return map;
}

function keyIndex(dir) {
	let stamp = null;
	try { stamp = fs.statSync(dir).mtimeMs; } catch { stamp = null; }
	if (!index || indexDir !== dir || indexStamp !== stamp) {
		index = buildIndex(dir);
		indexStamp = stamp;
		indexDir = dir;
	}
	return index;
}

export function operatorIdForKey(dir, key) {
	if (!key) return null;
	return keyIndex(dir).get(hashKey(key)) ?? null;
}

// --- the guard --------------------------------------------------------------
//
// Returns `null` when the request passes, otherwise { status, error }. `id` is
// the operator the path names (/__operator/:id/*); for /__map-api/*, which
// names none, the key alone identifies. A file from before #60 has no key: no
// key leads to it, hence 403 — until the `key` command.
export function checkKey({ mode, dir, req, id = null }) {
	if (mode !== 'shared') return null;
	const key = bearerOf(req);
	if (!key) return { status: 401, error: 'operator key required' };
	const owner = operatorIdForKey(dir, key);
	if (!owner || (id && owner !== id)) return { status: 403, error: 'invalid operator key' };
	return null;
}

// --- FPVTP_ACQUIRE ----------------------------------------------------------
//
// The terrain provider (kh.google.com) is an undocumented internal endpoint,
// with no key, no account, no terms accepted of any kind: acquisition stays in
// the repository, intact, but is active in NO distributed build. Switch CLOSED
// by default, and closed in `shared` whatever happens — two independent
// guards, because a scene must never be born on a server that receives
// strangers.
//
// Convention: FPVTP_ACQUIRE=1 or FPVTP_ACQUIRE=true (case insensitive).
// Everything else, absence included, closes it.
const TRUTHY = new Set(['1', 'true']);

export function acquireEnabled(mode) {
	if (mode === 'shared') return false;
	return TRUTHY.has(String(process.env.FPVTP_ACQUIRE ?? '').trim().toLowerCase());
}

// --- self-service signup, and its two ceilings ------------------------------
//
// On the VPS, the nominal case is a stranger who lands on the domain and
// leaves with a profile, without the server owner doing anything. That is
// intended — and it is what makes these two ceilings necessary. Both apply
// ONLY in `shared`: in `local` there is a single person, behind a loopback
// socket, and nothing changes.

// The requester's address. In `shared` the server sits behind Caddy and only
// listens on 127.0.0.1: `remoteAddress` is always the loopback there, and
// `x-forwarded-for` is the only usable source. In `local` that header would be
// forgeable by the client: it is not read at all.
//
// TAKE THE LAST HOP, NOT THE FIRST. This is the whole point, and the obvious
// reading is the wrong one. `X-Forwarded-For` is a trail written left to right,
// oldest first, and a reverse proxy APPENDS the peer it is actually talking to
// — Caddy's `reverse_proxy` does, as does nginx's `proxy_add_x_forwarded_for`.
// It does not verify what was already in the header, and deploy/Caddyfile sets
// no `trusted_proxies` and strips nothing. So a client that sends
// `X-Forwarded-For: 203.0.113.9` makes the server see
// `203.0.113.9, <its real address>`: every entry but the last is text the
// client chose. Reading the first entry hands the client its own rate-limit
// key, which it can rotate at will — which is to say, no rate limit at all.
// The last entry is the only one written by something we trust.
//
// This assumes EXACTLY ONE appending proxy in front (the deployment in
// deploy/Caddyfile). Put a second one there — a CDN in front of Caddy — and
// the last hop becomes the CDN's edge address, collapsing every visitor onto a
// handful of keys; that deployment must strip inbound `X-Forwarded-For` at the
// outermost proxy and count hops from the right instead.
export function clientIp(req, mode) {
	if (mode === 'shared') {
		const hops = String(req?.headers?.['x-forwarded-for'] ?? '')
			.split(',').map((s) => s.trim()).filter(Boolean);
		if (hops.length) return hops[hops.length - 1];
	}
	return req?.socket?.remoteAddress ?? 'unknown';
}

// Five signups per hour and per address. A real person signs up once; five
// leaves room for a shared NAT, for a family and for a bootstrap resumed after
// a mistyped name, while bringing a scripted flood down to something the
// per-operator byte ceiling (below) bounds in turn. In memory, with no
// dependency and no state on disk: the server is single-process —
// `jobs`/`current` in api.mjs already assume that — and a restart that resets
// the counter is not a hole, just a restart.
export const SIGNUP_MAX = 5;
export const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

const signups = new Map();

export function _resetSignups() { signups.clear(); }

export function checkSignup({ mode, req, now = Date.now() }) {
	if (mode !== 'shared') return null;
	const ip = clientIp(req, mode);
	const seen = (signups.get(ip) ?? []).filter((t) => now - t < SIGNUP_WINDOW_MS);
	if (seen.length >= SIGNUP_MAX) {
		signups.set(ip, seen);
		const minutes = Math.max(1, Math.ceil((SIGNUP_WINDOW_MS - (now - seen[0])) / 60000));
		return { status: 429, error: `too many signups from this address — try again in ${minutes} min` };
	}
	seen.push(now);
	signups.set(ip, seen);
	// Addresses with nothing left in the window do not stay in memory.
	if (signups.size > 10000) {
		for (const [k, v] of signups) if (!v.some((t) => now - t < SIGNUP_WINDOW_MS)) signups.delete(k);
	}
	return null;
}

// The per-operator byte ceiling, MEASURED on the user's real files on
// 2026-09-07:
//
//   303 sessions, 14 captures → 7,638,405 B, of which 6,897,334 B of captures
//    15 sessions,  0 capture  →    43,651 B
//
// That is ~2.4 kB per session and ~493 kB per capture: the capture is what
// weighs, all the rest is noise. 16 MB leaves a factor 2 above the biggest
// real profile (7.6 MB) — of the order of 30 more captures, or thousands of
// sessions without a capture — and bounds what a stranger can write on the
// VPS's disk. The FLIGHT is never blocked by this ceiling: only adding
// captures is, because it is the only write whose size depends on the client.
export const OPERATOR_BYTES_MAX = 16 * 1024 * 1024;

// Flight tracks (issue #24, D5) live BESIDE the operator file, in
// <dir>/tracks/<id>/, so that growing them does not make every operator write
// quadratic. They still count against the same ceiling: 200 tracks × ~15 kB is
// ~3 MB a client can write, and a quota that ignored them would be a lie.
function tracksBytes(dir, id) {
	let total = 0;
	const d = path.join(dir, 'tracks', id);
	let names;
	try { names = fs.readdirSync(d); } catch { return 0; }
	for (const f of names) {
		try { total += fs.statSync(path.join(d, f)).size; } catch { /* raced a prune */ }
	}
	return total;
}

// Returns `null` if the operator still has room, otherwise { status, error }.
export function checkOperatorQuota({ mode, dir, id }) {
	if (mode !== 'shared') return null;
	let size = 0;
	try { size = fs.statSync(path.join(dir, `${id}.json`)).size; } catch { return null; }
	size += tracksBytes(dir, id);
	if (size < OPERATOR_BYTES_MAX) return null;
	return {
		status: 413,
		error: `quota reached for this operator (${Math.round(size / 1e6)} MB) — delete sessions to free space`,
	};
}

// --- the `key` command ------------------------------------------------------
//
// The only recovery path: no password, no email account, a lost key is a lost
// operator. Also the migration of the files from before #60, which have no
// key: they stay perfectly usable in `local` and become usable again in
// `shared` as soon as they are given one.
export function issueKey(dir, id) {
	const file = path.join(dir, `${id}.json`);
	if (!fs.existsSync(file)) throw new Error(`no operator "${id}" in ${dir}`);
	const state = JSON.parse(fs.readFileSync(file, 'utf8'));
	const key = generateKey();
	state.keyHash = hashKey(key);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, '\t'));
	fs.renameSync(tmp, file);
	invalidateKeyIndex();
	return key;
}

// The hash never leaves the server: the key is a client secret, the server
// only keeps what it takes to recognise it.
export function publicOperator(state) {
	if (!state || typeof state !== 'object') return state;
	const { keyHash: _drop, ...rest } = state;
	return rest;
}
