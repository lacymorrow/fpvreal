// Selftest of the persistent world / weather (PHASE 04). No network, no disk:
// the Open-Meteo API is stubbed, like the fetch in src/operator.selftest.mjs.
// Run with: node tools/weather-selftest.mjs
import assert from 'node:assert/strict';
import * as W from './lib/weather.mjs';
import { resolveWeather, RETRY_FALLBACK_MS, MAX_ZONES } from './weather-source.mjs';
import { MAX_RATE } from '../src/rain.js';
import { rangeFor } from '../src/fog.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

const TOKYO = { lat: 35.6762, lon: 139.6503 };
const PARIS = { lat: 48.8582, lon: 2.297 };

// ---------------------------------------------------------------------------
// Keys

t('zoneKey quantises to about 1 km and normalises the longitude', () => {
	assert.equal(W.zoneKey(35.6762, 139.6503), '35.68,139.65');
	// Two points in the same district: same zone.
	assert.equal(W.zoneKey(35.6762, 139.6503), W.zoneKey(35.6801, 139.6549));
	// Two cities: never the same one.
	assert.notEqual(W.zoneKey(TOKYO.lat, TOKYO.lon), W.zoneKey(PARIS.lat, PARIS.lon));
	// -0.00 and 0.00 are the same zone, and 180 = -180.
	assert.equal(W.zoneKey(0, -0.001), W.zoneKey(0, 0.001));
	assert.equal(W.zoneKey(0, 180), W.zoneKey(0, -180));
	assert.throws(() => W.zoneKey(NaN, 0), /invalid zone/);
});

t('dayKey / dayAfter / dayIndex', () => {
	assert.equal(W.dayKey(new Date(2026, 7, 29, 23, 59)), '2026-08-29');
	assert.equal(W.dayAfter('2026-08-29', 0), '2026-08-29');
	assert.equal(W.dayAfter('2026-08-29', 3), '2026-09-01');
	assert.equal(W.dayAfter('2026-12-31', 1), '2027-01-01');
	// A leap year, so the shift is not a naive "+86400000".
	assert.equal(W.dayAfter('2028-02-28', 1), '2028-02-29');
	assert.equal(W.dayIndex('2026-08-30') - W.dayIndex('2026-08-29'), 1);
});

// ---------------------------------------------------------------------------
// Temporal consistency -- the heart of the acceptance criterion

t('two draws of the same day on the same zone are identical', () => {
	const a = W.proceduralForecast({ ...TOKYO, day: '2026-08-29' });
	const b = W.proceduralForecast({ ...TOKYO, day: '2026-08-29' });
	assert.deepEqual(a, b);
});

t('today\'s "+1" is tomorrow\'s "TODAY"', () => {
	const a = W.proceduralForecast({ ...TOKYO, day: '2026-08-29' });
	const b = W.proceduralForecast({ ...TOKYO, day: '2026-08-30' });
	assert.deepEqual(a[1], b[0]);
	assert.deepEqual(a[6], b[5]);
});

t('the next day may differ', () => {
	// Over one zone, at least one day of the week changes regime: the weather is
	// consistent, not frozen.
	const days = W.proceduralForecast({ ...TOKYO, day: '2026-08-29' });
	assert.ok(new Set(days.map((d) => d.regime)).size > 1);
});

t('two zones do not share a sequence', () => {
	const a = W.proceduralForecast({ ...TOKYO, day: '2026-08-29' }).map((d) => d.regime);
	const b = W.proceduralForecast({ ...PARIS, day: '2026-08-29' }).map((d) => d.regime);
	assert.notDeepEqual(a, b);
});

t('the sequence is not a fixed cycle', () => {
	// Over fifty zones the same run of seven regimes must never come up twice:
	// the order of the conditions is not predetermined.
	const seen = new Set();
	for (let i = 0; i < 50; i++) {
		const s = W.proceduralForecast({ lat: 10 + i * 1.1, lon: -30 + i * 2.3, day: '2026-08-29' })
			.map((d) => d.regime).join('|');
		seen.add(s);
	}
	assert.ok(seen.size >= 45, `${seen.size} distinct sequences out of 50`);
});

// ---------------------------------------------------------------------------
// Distribution -- measured, not guessed

t('extreme regimes stay rare and the wind follows a plausible law', () => {
	const counts = {};
	const speeds = [];
	let total = 0;
	for (let i = 0; i < 120; i++) {
		const lat = -60 + (i * 7919 % 1200) / 10;
		const lon = -180 + (i * 104729 % 3600) / 10;
		for (let d = 0; d < 120; d++) {
			const e = W.proceduralDay(lat, lon, W.dayAfter('2026-01-01', d));
			counts[e.regime] = (counts[e.regime] ?? 0) + 1;
			speeds.push(e.windSpeed);
			total++;
		}
	}
	const pct = (k) => 100 * (counts[k] ?? 0) / total;
	speeds.sort((a, b) => a - b);
	const q = (p) => speeds[Math.floor(p * speeds.length)];

	// A gale is an event, not every other Tuesday.
	assert.ok(pct('GALE') + pct('STORM') < 3, `gales ${(pct('GALE') + pct('STORM')).toFixed(1)} %`);
	// Nor is it fine every day.
	assert.ok(pct('CLEAR') > 8 && pct('CLEAR') < 35, `CLEAR ${pct('CLEAR').toFixed(1)} %`);
	// It rains, in one form or another, between one day in five and one in two.
	const rainy = pct('LIGHT RAIN') + pct('RAIN') + pct('HEAVY RAIN') + pct('STORM');
	assert.ok(rainy > 18 && rainy < 50, `rain ${rainy.toFixed(1)} %`);
	// Fog is rare everywhere.
	assert.ok(pct('FOG') < 8, `FOG ${pct('FOG').toFixed(1)} %`);
	// Daily peak wind: median around 5-6 m/s, 99th percentile under 20.
	assert.ok(q(0.5) > 3 && q(0.5) < 8, `median ${q(0.5).toFixed(1)} m/s`);
	assert.ok(q(0.99) < 20, `p99 ${q(0.99).toFixed(1)} m/s`);
	assert.ok(q(0.1) < 4, `p10 ${q(0.1).toFixed(1)} m/s`);
});

// ---------------------------------------------------------------------------
// Guard rails

t('sanitize: the gust brackets the mean wind', () => {
	assert.equal(W.sanitize({ windSpeed: 10, windGust: 4 }).windGust, 10);
	assert.equal(W.sanitize({ windSpeed: 10, windGust: 99 }).windGust, 30);
});

t('sanitize: wind clears fog, rain does not', () => {
	// Pea soup plus storm: impossible, the mechanical mixing dissipates it.
	const blown = W.sanitize({ windSpeed: 18, windGust: 24, visibilityM: 80 });
	assert.ok(blown.visibilityM >= 1500);
	assert.notEqual(blown.regime, 'FOG');
	// Under rain, poor visibility is water and not an inversion: it stays.
	const wet = W.sanitize({ windSpeed: 18, windGust: 24, rateMmH: 12, visibilityM: 600 });
	assert.ok(wet.visibilityM < 1500);
});

t('sanitize: it does not rain under a blue sky', () => {
	const d = W.sanitize({ rateMmH: 3, cloudPct: 0 });
	assert.ok(d.cloudPct >= 70);
	assert.equal(d.regime, 'RAIN');
});

t('sanitize: visibility never contradicts the rain rate', () => {
	// rain.js gives about 1.7 km at 25 mm/h; announcing 30 km would be a lie the
	// engine would contradict on the first frame.
	const d = W.sanitize({ rateMmH: 25, visibilityM: 30000 });
	assert.ok(d.visibilityM < 2500, `${d.visibilityM} m`);
});

t('sanitize: bounds and absurd values', () => {
	const d = W.sanitize({ windSpeed: 1e6, windGust: NaN, windDir: -30, rateMmH: -5, visibilityM: 0, cloudPct: 500 });
	assert.ok(d.windSpeed <= 40);
	assert.equal(d.windDir, 330);
	assert.equal(d.rateMmH, 0);
	assert.ok(d.visibilityM >= 30);
	assert.equal(d.cloudPct, 100);
	assert.ok(W.REGIMES.includes(d.regime));
});

t('every generated day passes its own guard rails', () => {
	for (let i = 0; i < 60; i++) {
		const day = W.proceduralDay(-50 + i * 1.7, -170 + i * 5.3, W.dayAfter('2026-03-01', i));
		assert.deepEqual(W.sanitize(day), day, `day ${i} is not stable under sanitize`);
		assert.ok(W.REGIMES.includes(day.regime));
	}
});

// ---------------------------------------------------------------------------
// Translation to wind.js / rain.js / fog.js

t('toSimParams stays inside the three models\' domains', () => {
	for (let i = 0; i < 200; i++) {
		const d = W.proceduralDay(-60 + i * 0.6, -180 + i * 1.8, W.dayAfter('2026-05-01', i % 30));
		const p = W.toSimParams(d);
		assert.ok(p.wind.speed >= 0 && p.wind.speed <= 25);
		assert.ok(p.wind.direction >= 0 && p.wind.direction < 360);
		assert.ok(p.wind.gust >= 0 && p.wind.gust <= 1);
		assert.ok(p.wind.turbulence >= 0 && p.wind.turbulence <= 2);
		for (const k of ['rain', 'fog']) {
			assert.ok(p[k].intensity >= 0 && p[k].intensity <= 1, `${k}.intensity`);
			assert.ok(p[k].variability >= 0 && p[k].variability <= 1, `${k}.variability`);
		}
	}
});

t('a clear, calm day gives a neutral world', () => {
	const p = W.toSimParams({ windSpeed: 0, windGust: 0, windDir: 0, rateMmH: 0, visibilityM: 30000, cloudPct: 5 });
	assert.equal(p.wind.speed, 0);
	assert.equal(p.rain.intensity, 0);
	assert.equal(p.fog.intensity, 0);
});

t('rain is not counted twice in the visibility', () => {
	// A shower in clear air must not produce fog: rain.js already adds its own
	// extinction on top of fog.js's.
	const d = W.sanitize({ windSpeed: 3, rateMmH: 10, visibilityM: 30000, cloudPct: 90 });
	const p = W.toSimParams(d);
	assert.ok(p.fog.intensity < 0.05, `fog ${p.fog.intensity}`);
	assert.ok(Math.abs(p.rain.intensity - 10 / MAX_RATE) < 1e-9);
});

t('a real fog bank does reach fog.js', () => {
	const d = W.sanitize({ windSpeed: 1, rateMmH: 0, visibilityM: 200, cloudPct: 90 });
	assert.equal(d.regime, 'FOG');
	const p = W.toSimParams(d);
	// fog.js reasons in range: the 200 m asked for come back.
	assert.ok(Math.abs(rangeFor(p.fog.intensity) - 200) < 5, `${rangeFor(p.fog.intensity)} m`);
});

// ---------------------------------------------------------------------------
// Open-Meteo

t('openMeteoUrl carries no key', () => {
	const u = new URL(W.openMeteoUrl(35.6762, 139.6503));
	assert.equal(u.origin + u.pathname, 'https://api.open-meteo.com/v1/forecast');
	assert.equal(u.searchParams.get('latitude'), '35.6762');
	assert.equal(u.searchParams.get('wind_speed_unit'), 'ms');
	assert.equal(u.searchParams.get('forecast_days'), '7');
	for (const k of [...u.searchParams.keys()]) {
		assert.ok(!/key|token|apikey|secret/i.test(k), `suspicious parameter: ${k}`);
	}
});

const OM = {
	daily: {
		time: ['2026-08-29', '2026-08-30'],
		weather_code: [61, 0],
		precipitation_sum: [6, 0],
		precipitation_hours: [3, 0],
		wind_speed_10m_max: [4.2, 1.1],
		wind_gusts_10m_max: [8.0, 2.4],
		wind_direction_10m_dominant: [210, 40],
	},
	hourly: {
		time: ['2026-08-29T00:00', '2026-08-29T01:00', '2026-08-30T00:00'],
		visibility: [8000, 6000, 24000],
		cloud_cover: [90, 100, 10],
	},
};

t('fromOpenMeteo reads the hourly rate, not the total', () => {
	const days = W.fromOpenMeteo(OM);
	assert.equal(days.length, 2);
	assert.equal(days[0].date, '2026-08-29');
	assert.equal(days[0].precipMm, 6);
	assert.equal(days[0].rateMmH, 2);          // 6 mm over 3 h
	assert.equal(days[0].regime, 'RAIN');
	assert.equal(days[0].windDir, 210);
	assert.equal(days[0].cloudPct, 95);        // mean over the day's hours
	assert.equal(days[1].regime, 'CLEAR');
	assert.equal(days[1].rateMmH, 0);
});

t('fromOpenMeteo falls back on the WMO code when the hourly series is missing', () => {
	const noHourly = { daily: { ...OM.daily, weather_code: [45, 0] } };
	const days = W.fromOpenMeteo(noHourly);
	assert.ok(days[0].visibilityM < 5000);     // code 45 = fog
	assert.ok(days[1].cloudPct < 40);          // code 0 = clear sky
});

t('fromOpenMeteo refuses an unusable answer', () => {
	assert.throws(() => W.fromOpenMeteo({}), /unusable/);
	assert.throws(() => W.fromOpenMeteo({ daily: { time: [] } }), /unusable/);
});

// ---------------------------------------------------------------------------
// Confidence

t('confidence decays with the horizon and with the quality of the source', () => {
	assert.ok(W.confidence('open-meteo', 0) > W.confidence('open-meteo', 6));
	assert.ok(W.confidence('open-meteo', 0) > W.confidence('procedural', 0));
	assert.ok(W.confidence('stale', 0) > W.confidence('procedural', 0));
	// A full bar would mean "certain": no forecast is.
	assert.notEqual(W.confidenceBar(W.confidence('open-meteo', 0)), '█'.repeat(12));
	assert.equal(W.confidenceBar(0).length, 12);
});

// ---------------------------------------------------------------------------
// Rendering

t('formatForecast shows the six required fields', () => {
	const snap = W.makeSnapshot({ ...TOKYO, day: '2026-08-29', source: 'procedural',
		days: W.proceduralForecast({ ...TOKYO, day: '2026-08-29' }) });
	const txt = W.formatForecast(snap, { title: 'Tokyo' });
	assert.match(txt, /^TOKYO/);
	assert.match(txt, /\nTODAY /);
	for (let i = 1; i < 7; i++) assert.match(txt, new RegExp(`\\n\\+${i} `));
	for (const field of ['WIND', 'VIS', 'RAIN', 'FOG', 'CONFIDENCE']) {
		assert.match(txt, new RegExp(`\\n${field} `), `field ${field} missing`);
	}
	// The day's regime really is the first line of the forecast.
	assert.ok(txt.includes(W.headline(snap.days[0])));
});

// ---------------------------------------------------------------------------
// The TARGET SCAN CONDITIONS block (issue #76)

const snapWith = (day) => W.makeSnapshot({
	...TOKYO, day: '2026-08-29', source: 'procedural',
	days: [W.sanitize({ ...W.proceduralForecast({ ...TOKYO, day: '2026-08-29' })[0], ...day })],
});

t('conditionsBlock: three fields, no alert in calm weather', () => {
	const b = W.conditionsBlock(snapWith({
		windSpeed: 2, windGust: 3, windDir: 315, rateMmH: 0, visibilityM: 40000,
	}));
	const txt = b.join('\n');
	assert.equal(b[0], 'CONDITIONS');
	assert.match(txt, /\nWIND +2\.0 m\/s +NW +LOW WIND/);
	assert.match(txt, /\nRAIN +NONE/);
	assert.match(txt, /\nVISIBILITY +40 km/);
	assert.ok(!txt.includes('MARGINAL'), 'no alert in calm weather');
});

t('conditionsBlock: an alert when the regime is marginal', () => {
	const b = W.conditionsBlock(snapWith({
		windSpeed: 12, windGust: 18, windDir: 90, rateMmH: 0, visibilityM: 20000,
	}));
	const txt = b.join('\n');
	assert.ok(txt.includes('>>> MARGINAL CONDITIONS'));
	assert.match(txt, /STRONG WIND/);
});

t('conditionsBlock / conditionsLine: null without a snapshot', () => {
	assert.equal(W.conditionsBlock(null), null);
	assert.equal(W.conditionsLine(undefined), null);
});

t('conditionsLine: a one-line summary, prefixed when marginal', () => {
	const calm = W.conditionsLine(snapWith({
		windSpeed: 2, windGust: 3, rateMmH: 0, visibilityM: 40000,
	}));
	assert.equal(calm, 'LOW WIND · VIS 40 km');
	const bad = W.conditionsLine(snapWith({
		windSpeed: 12, windGust: 18, rateMmH: 3, visibilityM: 6000,
	}));
	assert.match(bad, /^>>> /);
	assert.ok(bad.includes('RAIN'));
});

// ---------------------------------------------------------------------------
// Server-side resolution: cache, fallback, eviction

const okFetch = (calls) => async () => {
	calls.n++;
	return { ok: true, json: async () => OM };
};
const deadFetch = (calls) => async () => { calls.n++; throw new Error('offline'); };

await ta('one acquisition writes the snapshot, the next reads it back', async () => {
	const world = {};
	const calls = { n: 0 };
	const a = await resolveWeather(world, { ...TOKYO, day: '2026-08-29', fetchImpl: okFetch(calls) });
	assert.equal(a.changed, true);
	assert.equal(a.snapshot.source, 'open-meteo');
	assert.equal(calls.n, 1);

	// Immediately after: no network call, no new draw.
	const b = await resolveWeather(world, { ...TOKYO, day: '2026-08-29', fetchImpl: okFetch(calls) });
	assert.equal(calls.n, 1, 'the network was called again');
	assert.equal(b.changed, false);
	assert.deepEqual(b.snapshot, a.snapshot);
	assert.deepEqual(Object.keys(world.weather), [W.zoneKey(TOKYO.lat, TOKYO.lon)]);
});

await ta('offline with nothing cached: deterministic procedural', async () => {
	const calls = { n: 0 };
	const w1 = {}, w2 = {};
	const a = await resolveWeather(w1, { ...PARIS, day: '2026-08-29', fetchImpl: deadFetch(calls) });
	const b = await resolveWeather(w2, { ...PARIS, day: '2026-08-29', fetchImpl: deadFetch(calls) });
	assert.equal(a.snapshot.source, 'procedural');
	assert.deepEqual(a.snapshot.days, b.snapshot.days);
});

await ta('offline with yesterday\'s snapshot: last known, re-dated', async () => {
	const world = {};
	await resolveWeather(world, { ...TOKYO, day: '2026-08-29', fetchImpl: okFetch({ n: 0 }) });
	const r = await resolveWeather(world, { ...TOKYO, day: '2026-08-30', fetchImpl: deadFetch({ n: 0 }) });
	assert.equal(r.snapshot.source, 'stale');
	assert.equal(r.snapshot.day, '2026-08-30');
	// The window slid by one day, it was not replayed.
	assert.equal(r.snapshot.days[0].date, '2026-08-30');
	assert.ok(r.snapshot.days[0].confidence < W.confidence('open-meteo', 0));
});

await ta('a fallback allows a network retry, a reading does not', async () => {
	const world = {};
	const calls = { n: 0 };
	await resolveWeather(world, { ...TOKYO, day: '2026-08-29', fetchImpl: deadFetch(calls) });
	const before = calls.n;
	// Right after: the API is not hammered.
	await resolveWeather(world, { ...TOKYO, day: '2026-08-29', fetchImpl: deadFetch(calls) });
	assert.equal(calls.n, before);
	// A quarter of an hour later: a fresh attempt, and this time it answers.
	const later = Date.now() + RETRY_FALLBACK_MS + 1000;
	const r = await resolveWeather(world, { ...TOKYO, day: '2026-08-29', now: later, fetchImpl: okFetch(calls) });
	assert.equal(calls.n, before + 1);
	assert.equal(r.snapshot.source, 'open-meteo');
});

await ta('le world state ne collectionne pas les zones', async () => {
	const world = {};
	for (let i = 0; i < MAX_ZONES + 12; i++) {
		await resolveWeather(world, { lat: 10 + i * 0.5, lon: 20 + i * 0.5, day: '2026-08-29', fetchImpl: deadFetch({ n: 0 }) });
	}
	assert.equal(Object.keys(world.weather).length, MAX_ZONES);
});

await ta('the authoritative date is the API\'s, not the server\'s', async () => {
	// The player may straddle a time zone: Open-Meteo dates its days in the
	// zone's own (timezone=auto), and that is the date kept.
	const world = {};
	const r = await resolveWeather(world, { ...TOKYO, day: '2026-08-28', fetchImpl: okFetch({ n: 0 }) });
	assert.equal(r.snapshot.day, '2026-08-29');
});

// ---------------------------------------------------------- severity (PHASE 19)

t('severity: every regime has one, and exactly one of the four', () => {
	const levels = new Set(['nominal', 'watch', 'marginal', 'nogo']);
	for (const regime of W.REGIMES) {
		const s = W.severity({ regime, windSpeed: 0 });
		assert.ok(levels.has(s), `${regime}: unknown severity "${s}"`);
	}
});

t('severity: what Bible section 14 calls marginal never passes for nominal', () => {
	// The same set of regimes that triggers ">>> MARGINAL CONDITIONS" in
	// formatForecast: the two must not be able to diverge.
	for (const regime of ['WINDY', 'GALE', 'STORM', 'HEAVY RAIN', 'RAIN', 'FOG']) {
		const s = W.severity({ regime, windSpeed: 0 });
		assert.ok(s === 'marginal' || s === 'nogo',
			`${regime} is marginal for formatForecast but "${s}" for severity`);
	}
	const gale = { day: '2026-08-29', source: 'test', days: [W.sanitize({ windSpeed: 20 })] };
	assert.equal(gale.days[0].regime, 'GALE');
	assert.ok(W.conditionsLine(gale).startsWith('>>> '));
	assert.equal(W.severity(gale.days[0]), 'nogo');
});

t('severity: you do not go out in a gale or a storm', () => {
	assert.equal(W.severity({ regime: 'GALE', windSpeed: 20 }), 'nogo');
	assert.equal(W.severity({ regime: 'STORM', windSpeed: 20 }), 'nogo');
});

t('severity: a calm sky over an already sustained wind is still information', () => {
	// classify only switches to WINDY at 9 m/s; it can be felt from 6.
	assert.equal(W.severity({ regime: 'CLEAR', windSpeed: 2 }), 'nominal');
	assert.equal(W.severity({ regime: 'CLEAR', windSpeed: 7 }), 'watch');
	assert.equal(W.severity({ regime: 'OVERCAST', windSpeed: 8 }), 'watch');
});

t('severity: no snapshot, no colour', () => {
	assert.equal(W.severity(null), 'nominal');
	assert.equal(W.severity(undefined), 'nominal');
});

console.log(`\n${n} weather tests OK`);
