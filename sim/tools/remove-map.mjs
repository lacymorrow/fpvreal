// Undo of add-map.mjs: removes a map from public/scenes.json and deletes its
// prepped scene directory. The raw downloaded tile is left alone by default
// (it's the slow part to re-fetch) — pass --raw to delete it too.
//
//   node tools/remove-map.mjs <slug> [--raw]
//
// The raw cache is resolved at THE PROVIDER of the entry, through
// rawTileDirFor (issue #154). This file used to keep its own Flyover constant
// instead of importing it: deleting a google-earth scene with --raw left its
// sim/.cache/google-earth/ cache orphaned, while claiming it had looked for
// it. The GUI (DELETE ?raw=1) already went through that path; the CLI now
// shares it instead of having a second one.

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './lib/paths.mjs';
import { rawTileDirFor, providerOf } from './lib/add-map-core.mjs';
import * as providers from './lib/providers/index.mjs';

const { SCENES_DIR, SCENES_JSON } = paths;

function parseArgs(argv) {
	const positional = [];
	const opts = { raw: false };
	for (const a of argv) {
		if (a === '--raw') opts.raw = true;
		else positional.push(a);
	}
	if (positional.length !== 1) {
		console.error('usage: remove-map.mjs <slug> [--raw]');
		process.exit(1);
	}
	opts.slug = positional[0];
	return opts;
}

async function main() {
	const { slug, raw } = parseArgs(process.argv.slice(2));

	const scenes = fs.existsSync(SCENES_JSON) ? JSON.parse(fs.readFileSync(SCENES_JSON, 'utf8')) : [];
	const i = scenes.findIndex((s) => s.slug === slug);
	if (i < 0) {
		console.error(`No map with slug "${slug}" in scenes.json. Available maps: ${scenes.map((s) => s.slug).join(', ')}`);
		process.exit(1);
	}
	const [entry] = scenes.splice(i, 1);
	fs.writeFileSync(SCENES_JSON, JSON.stringify(scenes, null, '\t') + '\n');
	console.log(`Removed from the menu: "${entry.name}" (${slug})`);

	const outDir = path.join(SCENES_DIR, slug);
	if (fs.existsSync(outDir)) {
		fs.rmSync(outDir, { recursive: true, force: true });
		console.log(`Deleted: ${outDir}`);
	}

	if (raw) {
		const providerId = entry.provider ?? providers.DEFAULT_PROVIDER_ID;
		let label = providerId;
		try { label = providerOf(providerId).label; }
		catch { /* unknown provider: name it in the message anyway */ }
		try {
			const dir = await rawTileDirFor(entry);
			if (fs.existsSync(dir)) {
				fs.rmSync(dir, { recursive: true, force: true });
				console.log(`Deleted (raw, ${label}): ${dir}`);
			} else {
				console.log(`No raw ${label} tile at ${dir} (already gone).`);
			}
		} catch (e) {
			// An unknown provider must not let the cache deletion pass for a
			// success: SAY it, and exit in failure.
			console.error(`Raw cache not resolved (${label}): ${e.message}`);
			process.exitCode = 1;
		}
	}

	console.log(`\n✓ "${entry.name}" removed.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
