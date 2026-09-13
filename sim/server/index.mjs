// The standalone server: the game without Vite (issue #259).
//
//   node server/index.mjs [--data <dir>] [--port 8080] [--host 127.0.0.1]
//                         [--mode local|shared] [--open] [--dist <dir>]
//   node server/index.mjs key <operatorId> [--data <dir>]
//
// Equivalent environment variables: FPVTP_DATA_DIR, FPVTP_PORT, FPVTP_HOST,
// FPVTP_MODE. The command-line option wins. FPVTP_ACQUIRE (issue #60) has no
// command-line equivalent on purpose: it is not a launch setting, it is an
// environment switch that CI and electron-builder never set — see
// server/auth.mjs.
//
// The API (server/api.mjs) is mounted first, the file server
// (server/static.mjs) behind it: anything that does not start with /__operator
// or /__map-api is a file.
//
// startServer() is exported because the Electron main process (T2) will start
// it in its own Node context, without going through this CLI.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM_ROOT = path.dirname(HERE);

const MODES = new Set(['local', 'shared']);
// `localhost` is only an alias of the other two: it resolves nowhere but the
// loopback.
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const USAGE = `usage: node server/index.mjs [--data <dir>] [--port <n>] [--host <addr>]
                            [--mode local|shared] [--dist <dir>] [--open]
       node server/index.mjs key <operatorId> [--data <dir>]`;

export function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--open') { out.open = true; continue; }
		if (a === '--help' || a === '-h') { out.help = true; continue; }
		const key = { '--data': 'dataDir', '--port': 'port', '--host': 'host', '--mode': 'mode', '--dist': 'distDir' }[a];
		if (!key) throw new Error(`unknown option: ${a}\n${USAGE}`);
		const v = argv[++i];
		if (v === undefined) throw new Error(`${a} expects a value\n${USAGE}`);
		out[key] = v;
	}
	return out;
}

// Merges CLI, environment and defaults. The default data directory is the
// repository's one (tools/lib/paths.mjs): it is the installed app that will
// set the platform directory, through --data, once T2 brings it.
export function resolveOptions(cli = {}) {
	const port = cli.port ?? process.env.FPVTP_PORT ?? 8080;
	const opts = {
		dataDir: cli.dataDir ?? process.env.FPVTP_DATA_DIR ?? null,
		port: Number(port),
		host: cli.host ?? process.env.FPVTP_HOST ?? '127.0.0.1',
		mode: cli.mode ?? process.env.FPVTP_MODE ?? 'local',
		distDir: cli.distDir ?? path.join(SIM_ROOT, 'dist'),
		open: cli.open === true,
	};
	if (!MODES.has(opts.mode)) throw new Error(`unknown mode: ${opts.mode} (local or shared)`);
	if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
		throw new Error(`invalid port: ${port}`);
	}
	// THE guard rail: in `local` the security boundary is the loopback socket,
	// the same one the dev server has always had. Opening the listener has to
	// be said explicitly, because `shared` is the mode with authentication
	// (auth.mjs, operator keys) and nothing must be able to expose itself by
	// accident without it.
	if (opts.mode === 'local' && !LOOPBACK.has(opts.host)) {
		throw new Error(`--host ${opts.host} refused in local mode: outside 127.0.0.1/::1, pass --mode shared`);
	}
	return opts;
}

// Resolves the data directory like startServer(), and for the same reason:
// tools/lib/paths.mjs reads FPVTP_DATA_DIR at ITS import, so it has to be set
// beforehand. Hence the dynamic import.
async function resolvePaths(cli = {}) {
	const dataDir = cli.dataDir ?? process.env.FPVTP_DATA_DIR ?? null;
	if (dataDir) process.env.FPVTP_DATA_DIR = path.resolve(dataDir);
	const { paths } = await import('../tools/lib/paths.mjs');
	return paths;
}

export async function startServer(cli = {}) {
	const opts = resolveOptions(cli);

	// tools/lib/paths.mjs reads FPVTP_DATA_DIR at ITS import, and add-map-core
	// as well as providers/google-earth derive their constants from it at
	// theirs: the variable must be set before the first import of any of them.
	// Hence the dynamic import below — and the check that follows, so that a
	// second startServer() on another directory fails outright instead of
	// silently serving the first one's data.
	if (opts.dataDir) process.env.FPVTP_DATA_DIR = path.resolve(opts.dataDir);
	const { paths } = await import('../tools/lib/paths.mjs');
	const wanted = opts.dataDir ? path.resolve(opts.dataDir) : paths.DATA_DIR;
	if (paths.DATA_DIR !== wanted) {
		throw new Error(`data directory already frozen on ${paths.DATA_DIR}: ${wanted} comes too late`);
	}

	const { createApi } = await import('./api.mjs');
	const { createStatic } = await import('./static.mjs');

	const api = createApi({ paths, mode: opts.mode, logger: console });
	const serveStatic = createStatic({ distDir: opts.distDir, paths });

	const { applyBaseline } = await import('./headers.mjs');

	const server = http.createServer((req, res) => {
		// Before anything writes: the API and the file server both answer with
		// writeHead(code, {...}), which Node merges over what setHeader() has
		// already put on the response. One place, so no route can forget.
		applyBaseline(res);
		api(req, res, () => serveStatic(req, res));
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(opts.port, opts.host, () => { server.off('error', reject); resolve(); });
	});

	const addr = server.address();
	// An IPv6 address is written between brackets in a URL.
	const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
	const url = `http://${host}:${addr.port}/`;

	return {
		server, url, port: addr.port, paths, mode: opts.mode, distDir: opts.distDir,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

// No npm dependency for this: a detached spawn of the platform opener is
// enough, and its failure must not take the server down with it.
function openBrowser(url) {
	const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
		: process.platform === 'darwin' ? ['open', [url]]
			: ['xdg-open', [url]];
	try {
		const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
		child.on('error', () => {});
		child.unref();
	} catch { /* no browser: not a reason to stop the server */ }
}

// `key <operatorId>`: hands a fresh key to an existing operator. The only
// recovery path — a lost key is not read back, it is replaced — and the
// migration of the files from before #60, which have none. Printed ONCE on
// stdout: the server only keeps its digest.
async function keyCommand(argv) {
	const id = argv[0];
	if (!id || id.startsWith('-')) { console.error(`key expects an operator id\n${USAGE}`); process.exit(2); }
	let cli;
	try { cli = parseArgs(argv.slice(1)); }
	catch (e) { console.error(e.message); process.exit(2); }
	const paths = await resolvePaths(cli);
	const { issueKey } = await import('./auth.mjs');
	let key;
	try { key = issueKey(paths.OPERATOR_DIR, id); }
	catch (e) { console.error(`fpvtp: ${e.message}`); process.exit(1); }
	console.log(key);
	console.error(`fpvtp: new key for "${id}" — write it down, it will never be shown again.`);
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv[0] === 'key') return keyCommand(argv.slice(1));

	let cli;
	try { cli = parseArgs(argv); }
	catch (e) { console.error(e.message); process.exit(2); }

	if (cli.help) { console.log(USAGE); return; }

	let started;
	try { started = await startServer(cli); }
	catch (e) { console.error(`fpvtp: ${e.message}`); process.exit(1); }

	const { version } = JSON.parse(fs.readFileSync(path.join(SIM_ROOT, 'package.json'), 'utf8'));
	const { acquireEnabled } = await import('./auth.mjs');
	const acquire = acquireEnabled(started.mode) ? 'acquisition open' : 'acquisition closed';
	console.log(`FPVTP! v${version} — mode ${started.mode} — ${acquire} — data ${started.paths.DATA_DIR} — ${started.url}`);
	if (!fs.existsSync(started.distDir)) {
		console.warn(`fpvtp: ${started.distDir} does not exist — run "npm run build", or pass --dist`);
	}
	if (cli.open) openBrowser(started.url);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
