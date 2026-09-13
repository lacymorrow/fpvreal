#!/usr/bin/env node
// Cuts a version (issue #257).
//
//   npm run release -- patch|minor|major|X.Y.Z [--dry-run] [--date=YYYY-MM-DD]
//
// Effects, in this order: bump sim/package.json (and the lockfile), date the
// CHANGELOG's open section (the UNRELEASED heading, named in
// release-model.mjs), commit `chore(release): vX.Y.Z`, annotated tag. Pushing
// stays manual — pushing the tag is what triggers
// .github/workflows/release.yml, so it is never done behind the back of
// whoever runs the command.
//
// Every decision lives in release-model.mjs; here, only the side effects.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpVersion, releaseChangelog, tagOf } from './release-model.mjs';

const SIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SIM, '..');
const PKG = path.join(SIM, 'package.json');
const LOCK = path.join(SIM, 'package-lock.json');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

function git(...args) {
	return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function die(message) {
	console.error(`release: ${message}`);
	process.exit(1);
}

function today() {
	return new Date().toISOString().slice(0, 10);
}

// The version field is rewritten line by line: the rest of package.json keeps
// its formatting, and an `npm install` does not come and reshuffle everything
// afterwards.
function writePackageVersion(file, version) {
	const raw = fs.readFileSync(file, 'utf8');
	if (!/^\s*"version":\s*"[^"]*"/m.test(raw)) {
		die(`${path.relative(ROOT, file)} has no "version" field`);
	}
	fs.writeFileSync(file, raw.replace(/^(\s*)"version":\s*"[^"]*"/m, `$1"version": "${version}"`));
}

function writeLockVersion(file, version) {
	if (!fs.existsSync(file)) return false;
	const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
	if (!('version' in lock) && !lock.packages?.['']) return false;
	lock.version = version;
	if (lock.packages?.['']) lock.packages[''].version = version;
	fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
	return true;
}

const args = process.argv.slice(2);
const kind = args.find((a) => !a.startsWith('-'));
const dryRun = args.includes('--dry-run');
const dateArg = args.find((a) => a.startsWith('--date='))?.slice('--date='.length);

if (!kind) die('usage: npm run release -- patch|minor|major|X.Y.Z [--dry-run]');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (!pkg.version) die('sim/package.json has no "version" field');

let next;
try {
	next = bumpVersion(pkg.version, kind);
} catch (err) {
	die(err.message);
}
const tag = tagOf(next);

const dirty = git('status', '--porcelain');
if (dirty && !dryRun) die(`the working tree is not clean:\n${dirty}`);

const tagged = execFileSync('git', ['tag', '--list', tag], { cwd: ROOT, encoding: 'utf8' }).trim();
if (tagged) die(`tag ${tag} already exists`);

let changelog;
try {
	changelog = releaseChangelog(fs.readFileSync(CHANGELOG, 'utf8'), next, dateArg || today());
} catch (err) {
	die(err.message);
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
console.log(`release: ${pkg.version} → ${next} (tag ${tag}, branch ${branch})`);

if (dryRun) {
	console.log('release: --dry-run, nothing was written.');
	process.exit(0);
}

fs.writeFileSync(CHANGELOG, changelog);
writePackageVersion(PKG, next);
const lockUpdated = writeLockVersion(LOCK, next);

const staged = ['CHANGELOG.md', 'sim/package.json'];
if (lockUpdated) staged.push('sim/package-lock.json');
git('add', '--', ...staged);
git('commit', '-m', `chore(release): ${tag}`);
git('tag', '-a', tag, '-m', tag);

console.log(`release: commit and tag ${tag} created. To publish:`);
console.log(`  git push -u origin ${branch}`);
console.log(`  git push origin ${tag}`);
console.log('release: pushing the tag triggers the GitHub Release.');
