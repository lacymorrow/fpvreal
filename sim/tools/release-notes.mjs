#!/usr/bin/env node
// Prints the notes for one version, exactly as written in CHANGELOG.md (#257).
//
//   node tools/release-notes.mjs 0.1.0   →  the body of section [0.1.0]
//   node tools/release-notes.mjs v0.1.0  →  same, the tag prefix is tolerated
//
// This is what .github/workflows/release.yml pushes into the body of the
// GitHub Release: the notes are written by hand, once, here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseNotes } from './release-model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = process.argv[2];

if (!arg) {
	console.error('usage: node tools/release-notes.mjs <version|tag>');
	process.exit(1);
}

try {
	const version = arg.replace(/^v/, '');
	console.log(releaseNotes(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version));
} catch (err) {
	console.error(`release-notes: ${err.message}`);
	process.exit(1);
}
