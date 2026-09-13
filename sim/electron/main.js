// Electron's main process: it IS the game server (issue #259, slice T2).
//
// Electron already bundles Node and Chromium in a single binary: no second
// runtime alongside, no subprocess. `server/index.mjs` (slice T1) is imported
// here and started in this Node context, on 127.0.0.1 port 0 — an ephemeral
// port cannot collide with anything, and the loopback stays the security
// boundary of `local` mode. Once the server listens, a BrowserWindow loads the
// resolved URL; the renderer is the unchanged `dist/`.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, shell } from 'electron';
import electronUpdater from 'electron-updater';

import { startServer } from '../server/index.mjs';

const { autoUpdater } = electronUpdater;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.dirname(HERE);

// The repository is public, so the baked feed is `provider: github` and needs
// no server of ours. This guard survives for a fork that points the feed at a
// host it has not stood up yet: `.invalid` is reserved by RFC 2606 and will
// never resolve, so the check is skipped rather than failing in a loop behind
// the player's back. FPVTP_UPDATE_URL replaces the feed without a rebuild.
const PLACEHOLDER_MARK = '.invalid';

// Schemes `shell.openExternal` may be handed. Everything else — file:, smb:,
// and every OS-registered handler — is refused.
const SAFE_EXTERNAL = new Set(['https:', 'http:', 'mailto:']);

let serverHandle = null;

function log(line) {
	console.log(`fpvtp: ${line}`);
}

// electron-builder writes app-update.yml next to the resources; that file
// carries the provider and the URL baked at build time.
function bakedFeed() {
	try {
		return fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
	} catch { return null; }
}

function wireUpdater() {
	// electron-updater refuses to run outside a packaged app, and rightly so:
	// `npm run electron` must not go looking for a release.
	if (!app.isPackaged) return;

	// FPVTP_UPDATE_URL exists so a self-hoster can point installed clients at
	// their own feed. It replaces GitHub's TLS with whatever the variable says,
	// and nothing in this chain is code-signed, so an http: feed would be a
	// remote-code-execution primitive for anyone on the path. HTTPS or nothing.
	const override = process.env.FPVTP_UPDATE_URL?.trim();
	if (override) {
		let feed = null;
		try {
			const u = new URL(override);
			if (u.protocol === 'https:') feed = u.toString();
			else log(`updates disabled: FPVTP_UPDATE_URL must be https, got ${u.protocol}`);
		} catch {
			log('updates disabled: FPVTP_UPDATE_URL is not a URL');
		}
		if (!feed) return;
		log(`update feed overridden: ${feed}`);
		autoUpdater.setFeedURL({ provider: 'generic', url: feed });
	} else {
		const baked = bakedFeed();
		if (!baked) return void log('updates disabled: no app-update.yml');
		if (baked.includes(PLACEHOLDER_MARK)) {
			return void log('updates disabled: the feed is still a placeholder host');
		}
	}

	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;
	autoUpdater.on('error', (e) => log(`update: ${e?.message ?? e}`));
	autoUpdater.on('update-available', (i) => log(`update ${i?.version} available, downloading`));
	autoUpdater.on('update-downloaded', async (info) => {
		const { response } = await dialog.showMessageBox({
			type: 'info',
			buttons: ['Restart now', 'Later'],
			defaultId: 0,
			cancelId: 1,
			title: 'Update ready',
			message: `FPVTP! ${info?.version ?? ''} has been downloaded.`,
			detail: 'It will install on the next start.',
		});
		if (response === 0) autoUpdater.quitAndInstall();
	});
	autoUpdater.checkForUpdates().catch((e) => log(`update: ${e?.message ?? e}`));
}

function createWindow(url) {
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 960,
		minHeight: 600,
		show: false,
		autoHideMenuBar: true,
		// The operator terminal's background: without it the window flashes
		// white before the first frame.
		backgroundColor: '#121110',
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			// Both are the current Electron defaults. They are pinned so that a
			// preload added later cannot silently flip one.
			sandbox: true,
			webSecurity: true,
			// The game runs on requestAnimationFrame; Chromium throttles the
			// frames of a background window, which would drop the physics on the
			// first alt-tab.
			backgroundThrottling: false,
		},
	});

	win.once('ready-to-show', () => win.show());

	// A black window says nothing by itself: without these relays, a failure of
	// the bundle, of a worker or of the WebGL context stays in a console nobody
	// opens. Everything therefore surfaces on the main process's output.
	const wc = win.webContents;
	// Electron >= 36 passes a single event object; `level` is a string.
	wc.on('console-message', (e) => {
		if (e.level === 'warning' || e.level === 'error') log(`renderer: ${e.message} (${e.sourceId}:${e.lineNumber})`);
	});
	wc.on('did-fail-load', (_e, code, desc, url) => log(`load failed ${code} ${desc} — ${url}`));
	wc.on('render-process-gone', (_e, details) => log(`renderer lost: ${details.reason}`));
	wc.on('unresponsive', () => log('renderer frozen'));
	// Nothing in the game opens a second window: an external link leaves for the
	// system browser. The scheme allowlist is what keeps that from being a hole
	// straight out of the sandbox — contextIsolation and nodeIntegration contain
	// a compromised renderer, but `shell.openExternal` hands the string to the
	// OS protocol handler, which on Windows will happily take a file:// path, a
	// UNC share or any registered URI scheme.
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		try {
			if (SAFE_EXTERNAL.has(new URL(target).protocol)) shell.openExternal(target);
		} catch { /* unparsable: refuse */ }
		return { action: 'deny' };
	});

	// The renderer is the local server and nothing else. Without this the main
	// window itself can be navigated off-origin, which loses the origin the
	// whole local-mode security boundary is drawn around.
	const appOrigin = new URL(url).origin;
	wc.on('will-navigate', (e, to) => {
		let sameOrigin = false;
		try { sameOrigin = new URL(to).origin === appOrigin; } catch { /* refuse */ }
		if (!sameOrigin) { e.preventDefault(); log(`navigation refused: ${to}`); }
	});
	// The game embeds no webview; one appearing means something else did it.
	wc.on('will-attach-webview', (e) => e.preventDefault());

	win.loadURL(url);
	return win;
}

async function boot() {
	// The data directory is the platform's own, outside the program folder: an
	// update replaces the app and touches none of the scenes, the sessions or
	// the operator state.
	const dataDir = app.getPath('userData');

	try {
		serverHandle = await startServer({
			dataDir,
			host: '127.0.0.1',
			port: 0,
			mode: 'local',
			distDir: path.join(APP_ROOT, 'dist'),
		});
	} catch (e) {
		dialog.showErrorBox('FPVTP! could not start', String(e?.stack ?? e));
		app.exit(1);
		return;
	}

	log(`v${app.getVersion()} — data ${dataDir} — ${serverHandle.url}`);
	createWindow(serverHandle.url);
	wireUpdater();
}

// On Windows, `userData` falls by default into %APPDATA% — the roaming
// profile, which some domains synchronise over the network. A scene weighs
// hundreds of megabytes: the spec (#259, D3) names %LOCALAPPDATA%\FPVTP, and
// that is where this must live.
if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
	app.setPath('userData', path.join(process.env.LOCALAPPDATA, app.getName()));
}

// A player double-clicks the icon twice: the second instance hands over to the
// first instead of opening a second server.
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		const [win] = BrowserWindow.getAllWindows();
		if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
	});

	app.whenReady().then(boot);

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0 && serverHandle) createWindow(serverHandle.url);
	});

	app.on('window-all-closed', () => app.quit());

	// Close the socket before handing back. server.close() waits for in-flight
	// connections to end: a keep-alive left by the renderer, or the download of
	// a 40 MB scene chunk, would hold the process alive indefinitely. So the
	// connections are cut, and a guard delay makes sure that closing the window
	// always closes the app.
	app.on('will-quit', (e) => {
		if (!serverHandle) return;
		const handle = serverHandle;
		serverHandle = null;
		e.preventDefault();
		handle.server.closeAllConnections?.();
		const quit = () => app.quit();
		const guard = setTimeout(quit, 2000);
		handle.close().finally(() => { clearTimeout(guard); quit(); });
	});
}
