// The game's file server: Vite's `dist/` at the root, and the installation
// data (`scenes.json`, `scenes/<slug>/*`) from the data directory — not from
// `dist/`, because the catalogue belongs to each installation and starts
// empty, whereas the one in `public/` is only the dev's.
//
// Written by hand, with no dependency: that is the repository's server-side
// rule.
//
// NO SPA FALLBACK. A missing file returns a JSON 404, never index.html: that
// is exactly what issue #275 cost on the client side (a missing scene and a
// present scene both returned 200 text/html, and `res.ok` no longer said
// anything). The guard rail in src/loader.js stays, but it no longer has to do
// the work.

import fs from 'node:fs';
import path from 'node:path';
import { paths as defaultPaths } from '../tools/lib/paths.mjs';
import { securityHeaders, BASELINE } from './headers.mjs';

// Only the extra headers an HTML document gets; the baseline is already set.
function documentPolicy(type) {
	const all = securityHeaders(type);
	const extra = {};
	for (const [k, v] of Object.entries(all)) if (!(k in BASELINE)) extra[k] = v;
	return extra;
}

// What the game actually serves, nothing more.
const TYPES = {
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.wasm': 'application/wasm',
	'.jpg': 'image/jpeg',
	'.png': 'image/png',
	'.bin': 'application/octet-stream',
	'.opus': 'audio/ogg',
	'.woff2': 'font/woff2',
	'.svg': 'image/svg+xml',
	// Font licences travel in the build: readable, not downloaded.
	'.txt': 'text/plain; charset=utf-8',
};

// Types served compressed when a precomputed `.br`/`.gz` sits next to the
// file (tools/precompress.mjs, run by `npm run build`, #21). Nothing is
// compressed on the fly: this server also runs inside Electron's main process,
// without dependencies, and compressing 2.9 MB of JavaScript per request would
// cost CPU there for an identical result every time. The types absent from
// here (.bin chunks, JPEG, Opus) are already compressed by nature.
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.txt', '.wasm']);
// Preference order when the browser accepts both.
const ENCODINGS = [['br', '.br'], ['gzip', '.gz']];

// A scene never changes under its slug (REMOVE then re-acquisition yields the
// same slug, but then the whole content is rewritten).
const IMMUTABLE = 'public, max-age=31536000, immutable';
// The manifest is re-read at every boot: it alone must be revalidated.
const REVALIDATE = 'no-cache';

const SLUG_RE = /^[a-z0-9-]+$/;

function jsonError(res, code, message) {
	const s = JSON.stringify({ error: message });
	res.writeHead(code, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(s),
		'cache-control': 'no-store',
	});
	res.end(s);
}

// A path coming from the network never escapes its root, whatever it holds.
//
// TWO gates, because a lexical one is not enough. Resolving the string catches
// `..`, `%2e%2e`, backslashes and doubled slashes — but `path.resolve` knows
// nothing of the filesystem, and `statSync`/`createReadStream` follow symlinks.
// A link at `scenes/<slug>/pwn.json` pointing at /etc/passwd is lexically
// impeccable and was served with a 200. Nothing the server exposes can create
// such a link, but the scenes directory is filled by unpacking third-party
// terrain archives and by deploy.sh copying a release tarball, and `dist/` is
// build output: one crafted archive turns a local file read into an HTTP one.
//
// So: the lexical check first, because it is free and rejects the common case;
// then one `realpathSync` to ask the filesystem where the path really lands.
// That is ONE extra syscall per request, on the hot path for every tile and
// chunk — and it is a resolve of the full path, not one per segment.
//
// `base` must ALREADY be real (see `realRoot`): the deployed tree is reached
// through /opt/fpvtp/current, itself a symlink, so comparing a resolved
// candidate against an unresolved root would reject every legitimate request.
function safeJoin(base, rel) {
	const full = path.resolve(base, '.' + (rel.startsWith('/') ? rel : '/' + rel));
	if (full !== base && !full.startsWith(base + path.sep)) return null;
	let real;
	// ENOENT is the ordinary "no such file": hand back the lexical path and let
	// the caller's statSync produce the usual 404, with the usual message.
	try { real = fs.realpathSync(full); } catch { return full; }
	if (real !== base && !real.startsWith(base + path.sep)) return null;
	return real;
}

// The roots, resolved once and remembered. A root is a fixed property of the
// process: the deploy script repoints /opt/fpvtp/current and then restarts the
// service, so there is no live rug-pull to defend against, and resolving per
// request would pay for it on every tile.
//
// Only SUCCESSES are cached. A data directory can be empty at boot and gain
// its scenes/ later, so a failed resolve must be retried rather than frozen
// into a lexical path that would not match once the directory shows up behind
// a symlink.
const rootCache = new Map();

function realRoot(dir) {
	const abs = path.resolve(dir);
	const hit = rootCache.get(abs);
	if (hit) return hit;
	let real;
	try { real = fs.realpathSync(abs); } catch { return abs; }
	rootCache.set(abs, real);
	return real;
}

// Weak ETag: size + modification date are enough for files nobody rewrites in
// place, and they do not cost reading the 40 MB of a chunk.
function etagOf(st) {
	return `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

// A single range, the only form a browser sends to resume a download. A
// multiple or unreadable range is ignored (full response), which the RFC
// allows; out of bounds returns 416.
function parseRange(header, size) {
	const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
	if (!m) return null;
	const [, a, b] = m;
	if (a === '' && b === '') return null;
	let start, end;
	if (a === '') {
		const n = Number(b);
		if (!n) return { unsatisfiable: true };
		start = Math.max(0, size - n);
		end = size - 1;
	} else {
		start = Number(a);
		end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
	}
	if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
		return { unsatisfiable: true };
	}
	return { start, end };
}

// The precompressed variant to serve for `file`, or null: encoding accepted
// by the client (Accept-Encoding, bare token or with a non-zero q),
// compressible type, `.br`/`.gz` file present AND not older than its source —
// otherwise a partial build that left an old `.br` next to a fresh asset would
// serve code from another version under an immutable name.
function precompressedVariant(req, file, st) {
	const ext = path.extname(file).toLowerCase();
	if (!COMPRESSIBLE.has(ext)) return null;
	const accepted = new Set();
	for (const part of String(req.headers['accept-encoding'] ?? '').split(',')) {
		const [token, ...params] = part.trim().split(';').map((s) => s.trim());
		if (!token) continue;
		const q = params.find((p) => p.startsWith('q='));
		if (q && Number(q.slice(2)) === 0) continue;
		accepted.add(token.toLowerCase());
	}
	for (const [encoding, suffix] of ENCODINGS) {
		if (!accepted.has(encoding)) continue;
		let cst;
		try { cst = fs.statSync(file + suffix); } catch { continue; }
		if (!cst.isFile() || cst.mtimeMs < st.mtimeMs) continue;
		return { encoding, file: file + suffix, st: cst };
	}
	return null;
}

function sendFile(req, res, file, st, cacheControl) {
	const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
	// Never compress a range: a Range's offsets apply to the representation
	// served, and the only use of a Range here (resuming a scene chunk)
	// concerns no compressible type anyway.
	const variant = req.headers.range ? null : precompressedVariant(req, file, st);
	// One ETag per representation (RFC 9110 §8.8.3): the same value for the
	// plain and the brotli one would return a 304 to a client whose cache holds
	// the other encoding.
	const etag = variant ? etagOf(st).replace(/"$/, `-${variant.encoding}"`) : etagOf(st);
	const head = {
		'content-type': type,
		'cache-control': cacheControl,
		etag,
		'accept-ranges': 'bytes',
		'last-modified': new Date(st.mtimeMs).toUTCString(),
		// The document policy rides on documents only — see server/headers.mjs.
		// The always-on headers are already on the response (server/index.mjs).
		...documentPolicy(type),
	};
	// `Vary` as soon as the response CAN depend on Accept-Encoding, compressed
	// or not: an intermediate cache that saw the plain version must not serve
	// it to a client that accepts brotli, nor the other way round.
	if (COMPRESSIBLE.has(path.extname(file).toLowerCase())) head.vary = 'accept-encoding';
	if (variant) head['content-encoding'] = variant.encoding;

	if (req.headers['if-none-match'] === etag) {
		res.writeHead(304, { etag, 'cache-control': cacheControl, ...(head.vary ? { vary: head.vary } : {}) });
		return res.end();
	}

	if (variant) {
		res.writeHead(200, { ...head, 'content-length': variant.st.size });
		if (req.method === 'HEAD') return res.end();
		return fs.createReadStream(variant.file).pipe(res);
	}

	const range = req.headers.range ? parseRange(req.headers.range, st.size) : null;
	if (range?.unsatisfiable) {
		res.writeHead(416, { ...head, 'content-range': `bytes */${st.size}` });
		return res.end();
	}

	if (range) {
		const length = range.end - range.start + 1;
		res.writeHead(206, {
			...head,
			'content-length': length,
			'content-range': `bytes ${range.start}-${range.end}/${st.size}`,
		});
		if (req.method === 'HEAD') return res.end();
		return fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
	}

	res.writeHead(200, { ...head, 'content-length': st.size });
	if (req.method === 'HEAD') return res.end();
	return fs.createReadStream(file).pipe(res);
}

export function createStatic({ distDir, paths = defaultPaths } = {}) {
	const dist = path.resolve(distDir);

	return function serveStatic(req, res) {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			return jsonError(res, 405, `${req.method} not supported on a file`);
		}

		let pathname;
		try {
			pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
		} catch {
			return jsonError(res, 400, 'unreadable URL');
		}
		if (pathname.includes('\0')) return jsonError(res, 400, 'unreadable URL');

		// scenes.json lives in the data directory, and a fresh installation does
		// not have one yet: an empty catalogue is the right answer, not a 404 —
		// which is what readScenes() already returns on the API side.
		if (pathname === '/scenes.json') {
			if (!fs.existsSync(paths.SCENES_JSON)) {
				const s = '[]';
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'content-length': Buffer.byteLength(s),
					'cache-control': REVALIDATE,
				});
				return res.end(req.method === 'HEAD' ? undefined : s);
			}
			const st = fs.statSync(paths.SCENES_JSON);
			return sendFile(req, res, paths.SCENES_JSON, st, REVALIDATE);
		}

		let file, cacheControl;
		if (pathname.startsWith('/scenes/')) {
			const rel = pathname.slice('/scenes/'.length);
			const slug = rel.split('/')[0];
			if (!SLUG_RE.test(slug)) return jsonError(res, 404, `invalid scene path: ${pathname}`);
			file = safeJoin(realRoot(paths.SCENES_DIR), rel);
			cacheControl = path.basename(rel) === 'manifest.json' ? REVALIDATE : IMMUTABLE;
		} else {
			file = safeJoin(realRoot(dist), pathname === '/' ? '/index.html' : pathname);
			// Vite hashes the names of its assets; the rest of the build
			// (index.html first) must be revalidated, otherwise an update is
			// never seen.
			cacheControl = pathname.startsWith('/assets/') ? IMMUTABLE : REVALIDATE;
		}
		if (!file) return jsonError(res, 404, `outside the root: ${pathname}`);

		let st;
		try { st = fs.statSync(file); }
		catch { return jsonError(res, 404, `${pathname} not found`); }
		if (!st.isFile()) return jsonError(res, 404, `${pathname} not found`);

		return sendFile(req, res, file, st, cacheControl);
	};
}
