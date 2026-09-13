// Weather model of the persistent world (PHASE 04).
//
// No I/O, no DOM, no `node:` — the file is importable as-is by the browser
// (src/weather.js) and by Node (the dev plugin, the selftest), same rule as
// ./tiles.mjs.
//
// This module does NOT reimplement wind, rain or fog: it produces a *bulletin*
// per zone and per day, then translates it into parameters for src/wind.js,
// src/rain.js and src/fog.js, which stay the rendering layer. The physical
// constants (MAX_RATE, the clear-air range, visibility under rain) are imported
// from those models rather than copied here.

import { mulberry32, compassPoint } from '../../src/wind.js';
import { MAX_RATE, rainVisibility } from '../../src/rain.js';
import { rangeFor, intensityForRange, RANGE_MIN } from '../../src/fog.js';
import { asText } from './as-text.mjs';

export const FORECAST_DAYS = 7;

// Zone key precision: 0.01 degrees, about 1.1 km. Two acquisitions hand-drawn
// over the same district must land on the same weather; two distinct cities
// must never share one.
export const ZONE_PRECISION = 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);

export function zoneKey(lat, lon) {
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('invalid zone');
	const la = lat.toFixed(ZONE_PRECISION);
	// -0.00 and 0.00 are the same zone.
	const lo = (((lon + 180) % 360 + 360) % 360 - 180).toFixed(ZONE_PRECISION);
	return `${Number(la).toFixed(ZONE_PRECISION)},${Number(lo).toFixed(ZONE_PRECISION)}`;
}

// *Local* civil day, not UTC: the player's day turns when their clock says so,
// and that is also Open-Meteo's convention with timezone=auto.
export function dayKey(date = new Date()) {
	const d = date instanceof Date ? date : new Date(date);
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Absolute day number, so the forecast is anchored on the calendar and not on
// the moment it is asked for: today's "+1" and tomorrow's "TODAY" are drawn
// from the same number, hence identical.
export function dayIndex(day) {
	const [y, m, d] = String(day).split('-').map(Number);
	return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

export function dayAfter(day, n) {
	const [y, m, d] = String(day).split('-').map(Number);
	const t = new Date(Date.UTC(y, m - 1, d + n));
	const p = (v) => String(v).padStart(2, '0');
	return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

// FNV-1a, 32 bits. A hash function, not a generator: mulberry32 (src/wind.js)
// carries the sequence, so the project holds a single PRNG.
export function hash32(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

const hash01 = (str) => mulberry32(hash32(str))();

// ---------------------------------------------------------------------------
// Regimes
//
// The labels are the ones shown to the player, hence English (D5). The order of
// the array means nothing: a zone's sequence comes out of the generation, not
// out of a fixed cycle — exactly what Bible section 5 asks for.

export const REGIMES = [
	'CLEAR', 'CLOUD', 'OVERCAST', 'MIST', 'FOG',
	'LIGHT RAIN', 'RAIN', 'HEAVY RAIN', 'WINDY', 'GALE', 'STORM',
];

// Thresholds. Wind is in m/s at 10 m, visibility in metres, rain in mm/h (the
// day's mean instantaneous rate, not the total).
const WIND_BREEZY = 6, WIND_STRONG = 9, WIND_GALE = 17;
const GUST_GALE = 25;
const VIS_FOG = 1000, VIS_MIST = 5000;
// Met Office classes: drizzle under 0.2 mm/h, moderate rain from 2, heavy from
// 10. Those are the published thresholds, not round numbers chosen to land
// nicely on the regimes.
const RATE_LIGHT = 0.2, RATE_RAIN = 2.0, RATE_HEAVY = 10;
const CLOUD_OVERCAST = 85, CLOUD_CLOUDY = 40;

export function classify({ windSpeed = 0, windGust = 0, rateMmH = 0, visibilityM = Infinity, cloudPct = 0 }) {
	if (windSpeed >= WIND_GALE || windGust >= GUST_GALE) return rateMmH >= RATE_RAIN ? 'STORM' : 'GALE';
	if (visibilityM < VIS_FOG && rateMmH < RATE_RAIN) return 'FOG';
	if (rateMmH >= RATE_HEAVY) return 'HEAVY RAIN';
	if (rateMmH >= RATE_RAIN) return 'RAIN';
	if (rateMmH >= RATE_LIGHT) return 'LIGHT RAIN';
	if (visibilityM < VIS_MIST) return 'MIST';
	if (windSpeed >= WIND_STRONG) return 'WINDY';
	if (cloudPct >= CLOUD_OVERCAST) return 'OVERCAST';
	if (cloudPct >= CLOUD_CLOUDY) return 'CLOUD';
	return 'CLEAR';
}

export function windLabel(speed) {
	if (speed < 1) return 'CALM';
	if (speed < WIND_BREEZY) return 'LOW WIND';
	if (speed < WIND_STRONG) return 'MODERATE WIND';
	if (speed < WIND_GALE) return 'STRONG WIND';
	return 'GALE WIND';
}

// The compass rose lives in wind.js: one table, not two that could diverge.
export { compassPoint as compass };

// ---------------------------------------------------------------------------
// Guard rails
//
// A public API and a generator both produce combinations that cannot be flown,
// or that do not exist in the atmosphere. They are corrected here, once, before
// anything classifies them or sends them to the models.

// Past 8 m/s the mechanical mixing lifts fog into stratus: "pea soup plus
// storm" is a combination the generator can produce and the atmosphere does
// not.
const FOG_WIND_LIMIT = 8;
const FOG_WIND_FLOOR = 1500;
// Gust factor: below 1 it is not a gust, past 3 it is a typo. Measured values
// live between 1.2 and 2.5 over flat land.
const GUST_MIN = 1.0, GUST_MAX = 3.0;

export function sanitize(day) {
	const d = { ...day };

	d.windSpeed = clamp(Number(d.windSpeed) || 0, 0, 40);
	d.windGust = clamp(Number(d.windGust) || 0, 0, 60);
	// Number.isFinite first, like visibilityM three lines down. Math.round leaves
	// an Infinity alone and `Infinity % 360` is NaN, so a bearing was the one
	// field this block could hand on broken: JSON has no Infinity literal but
	// `1e400` parses to one, and the NaN then reached the WEATHER screen as
	// `compassPoint(NaN)` -> the word "undefined".
	const dir = Number(d.windDir);
	d.windDir = Number.isFinite(dir) ? (((Math.round(dir) % 360) + 360) % 360) : 0;
	d.rateMmH = clamp(Number(d.rateMmH) || 0, 0, 60);
	d.precipMm = clamp(Number(d.precipMm) || 0, 0, 400);
	d.cloudPct = clamp(Number(d.cloudPct) || 0, 0, 100);
	d.visibilityM = Number.isFinite(d.visibilityM) ? clamp(d.visibilityM, 30, 60000) : 60000;

	// A gust is stronger than the mean wind, and not three times stronger.
	d.windGust = clamp(d.windGust, d.windSpeed * GUST_MIN, d.windSpeed * GUST_MAX);

	// Wind clears fog — except the fog rain makes, which is suspended water and
	// not an inversion.
	if (d.windSpeed >= FOG_WIND_LIMIT && d.rateMmH < RATE_LIGHT) {
		d.visibilityM = Math.max(d.visibilityM, FOG_WIND_FLOOR);
	}
	// It does not rain under a blue sky.
	if (d.rateMmH >= RATE_LIGHT) d.cloudPct = Math.max(d.cloudPct, 70);
	// Rain has its own extinction: visibility cannot be better than the rate
	// imposes (rain.js is the source of that relation).
	if (d.rateMmH > 0) d.visibilityM = Math.min(d.visibilityM, rainVisibility(d.rateMmH));
	// And a blocked sky is not a clear one.
	if (d.visibilityM < VIS_FOG) d.cloudPct = Math.max(d.cloudPct, 60);

	d.regime = classify(d);
	return d;
}

// ---------------------------------------------------------------------------
// Procedural generation
//
// The offline fallback, and the only source in a build without a dev server.
// Two requirements that seem to contradict each other:
//
//   - the weather evolves from day to day, without jumping at random;
//   - today's "+1" must be tomorrow's "TODAY".
//
// Hence value noise indexed on the absolute day and smoothed over its
// neighbours: each day is computable on its own, but depends on its two
// neighbours, so the series is continuous and the forecast never contradicts
// itself the next day.

function channel(zone, d, name) { return hash01(`${zone}|${d}|${name}`); }

function smooth(zone, d, name) {
	return 0.25 * channel(zone, d - 1, name)
		+ 0.5 * channel(zone, d, name)
		+ 0.25 * channel(zone, d + 1, name);
}

// The smoothing turns three uniforms into a near-normal variable of mean 0.5
// and standard deviation sqrt(0.375/12) = 0.1768. Re-spreading that with a line
// and a clamp — the reflex — pinned 7 % of days on the bound, which gave Tokyo
// one storm a week. So it goes back through the normal cumulative distribution,
// which returns a REAL uniform on (0,1): the wind, rain and fog laws can then be
// calibrated on their real frequencies, the only way "rare" means rare.
const SMOOTH_SD = Math.sqrt(0.375 / 12);

// Abramowitz & Stegun 7.1.26, error below 1.5e-7. Enough: it draws weather, not
// a structural calculation.
function erf(x) {
	const sign = x < 0 ? -1 : 1;
	const t = 1 / (1 + 0.3275911 * Math.abs(x));
	const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
		- 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
	return sign * y;
}

function uniform(zone, d, name) {
	const v = (smooth(zone, d, name) - 0.5) / SMOOTH_SD;
	return clamp(0.5 * (1 + erf(v / Math.SQRT2)), 1e-4, 1 - 1e-4);
}

// The zone's climatology: what does not change from one day to the next. It is
// what makes one zone's sequence differ from another's — Tokyo and Reims do not
// draw from the same distribution, not merely in a different order.
export function climate(lat, lon) {
	const z = zoneKey(lat, lon);
	const polar = clamp01(Math.abs(lat) / 60);
	return {
		zone: z,
		windiness: clamp01(0.25 + 0.45 * hash01(`${z}|clim-wind`) + 0.30 * polar),
		wetness: clamp01(0.20 + 0.60 * hash01(`${z}|clim-wet`)),
		fogginess: clamp01(0.15 + 0.65 * hash01(`${z}|clim-fog`)),
		baseDir: hash01(`${z}|clim-dir`) * 360,
	};
}

// Wind: Weibull of shape 2 (Rayleigh), which is the law wind speeds really
// follow. The scale A carries the zone's climate. With A = 6.5: median 5.4 m/s,
// 90th percentile 9.9, and 17 m/s (a gale) once in a thousand days.
const WEIBULL_A = [3.5, 9.0];
// It rains about one day in three in a temperate climate, and fog is a rare
// phenomenon even where it is frequent.
const RAIN_DAYS = [0.15, 0.50];
const FOG_DAYS = [0.02, 0.18];

const lerp = (r, t) => r[0] + (r[1] - r[0]) * t;

export function proceduralDay(lat, lon, day) {
	const c = climate(lat, lon);
	const d = dayIndex(day);
	const z = c.zone;

	// --- wind
	const A = lerp(WEIBULL_A, c.windiness);
	const windSpeed = A * Math.sqrt(-Math.log(1 - uniform(z, d, 'wind')));
	// Gust factor: 1.3 to 2.2, and the stronger the wind the lower it gets — it
	// is the gust that catches up with the mean, not the other way round.
	const gustFactor = 1.25 + 0.85 * uniform(z, d, 'gust') * (1 - 0.35 * clamp01(windSpeed / 15));

	// --- rain
	const rainThreshold = 1 - lerp(RAIN_DAYS, c.wetness);
	const uRain = uniform(z, d, 'moist');
	const q = uRain > rainThreshold ? (uRain - rainThreshold) / (1 - rainThreshold) : 0;
	// Exponential total: many days at 2 mm, a few at 30.
	const precipMm = q > 0 ? 12 * (0.5 + c.wetness) * -Math.log(1 - 0.98 * q) : 0;
	// Spread over how many hours — THAT is the number separating a shower from a
	// drizzle, and rain.js reasons in mm/h, not mm/day.
	const precipHours = precipMm > 0 ? 0.5 + 14 * uniform(z, d, 'spread') : 0;
	const rateMmH = precipHours > 0 ? precipMm / precipHours : 0;

	// --- fog
	const fogThreshold = 1 - lerp(FOG_DAYS, c.fogginess);
	const uFog = uniform(z, d, 'fog');
	const fogAmount = uFog > fogThreshold ? (uFog - fogThreshold) / (1 - fogThreshold) : 0;
	const visibilityM = fogAmount > 0 ? 25000 * Math.pow(0.004, fogAmount) : 25000;

	// --- cover
	const cloudPct = 100 * clamp01(0.10 + 0.90 * uniform(z, d, 'cloud') + 0.35 * q + 0.20 * (c.wetness - 0.5));

	return sanitize({
		date: day,
		windSpeed,
		windGust: windSpeed * gustFactor,
		windDir: (c.baseDir + (uniform(z, d, 'dir') - 0.5) * 200 + 360) % 360,
		precipMm,
		rateMmH,
		visibilityM,
		cloudPct,
	});
}

export function proceduralForecast({ lat, lon, day = dayKey(), days = FORECAST_DAYS }) {
	return Array.from({ length: days }, (_, i) => proceduralDay(lat, lon, dayAfter(day, i)));
}

// ---------------------------------------------------------------------------
// Open-Meteo
//
// No key, no secret: the URL is public and is built here so the selftest can
// check it without a network.

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

export function openMeteoUrl(lat, lon, days = FORECAST_DAYS) {
	const q = new URLSearchParams({
		latitude: lat.toFixed(4),
		longitude: lon.toFixed(4),
		daily: [
			'weather_code', 'precipitation_sum', 'precipitation_hours',
			'wind_speed_10m_max', 'wind_gusts_10m_max', 'wind_direction_10m_dominant',
		].join(','),
		hourly: 'visibility,cloud_cover',
		wind_speed_unit: 'ms',
		timezone: 'auto',
		forecast_days: String(days),
	});
	return `${OPEN_METEO_URL}?${q}`;
}

// Mean over the hours of a given day, ignoring the gaps. `null` when the series
// is absent: Open-Meteo does not serve `visibility` for every model, and an
// invented value would be worse than one derived from the weather code.
function dailyMean(hourly, key, dayStr) {
	const times = hourly?.time;
	const vals = hourly?.[key];
	if (!Array.isArray(times) || !Array.isArray(vals)) return null;
	let sum = 0, n = 0;
	for (let i = 0; i < times.length; i++) {
		// asText(), not String(): `times` is Open-Meteo's, and
		// `{"toString": null}` is valid JSON that String() throws on — the fetch
		// would then log an engine TypeError instead of its own refusal
		// (fuzzing finding 3, tools/lib/as-text.mjs).
		if (!asText(times[i]).startsWith(dayStr)) continue;
		const v = vals[i];
		if (Number.isFinite(v)) { sum += v; n++; }
	}
	return n > 0 ? sum / n : null;
}

// WMO codes -> what they imply when the hourly series is missing. Used only to
// fill a gap, never to overwrite a measurement.
const WMO_FOG = new Set([45, 48]);
const WMO_CLEAR = new Set([0, 1]);
const WMO_OVERCAST = new Set([3, 45, 48]);

export function fromOpenMeteo(payload, { days = FORECAST_DAYS } = {}) {
	const d = payload?.daily;
	if (!d || !Array.isArray(d.time) || d.time.length === 0) throw new Error('unusable Open-Meteo answer');
	const n = Math.min(days, d.time.length);
	const out = [];
	for (let i = 0; i < n; i++) {
		const date = d.time[i];
		const code = Number(d.weather_code?.[i] ?? 0);
		const precipMm = Number(d.precipitation_sum?.[i] ?? 0) || 0;
		const hours = Number(d.precipitation_hours?.[i] ?? 0) || 0;
		const rateMmH = precipMm > 0 ? precipMm / Math.max(1, hours) : 0;

		let visibilityM = dailyMean(payload.hourly, 'visibility', date);
		if (visibilityM === null) {
			// Fallback: the weather code says whether there is fog, rain does the
			// rest through sanitize().
			visibilityM = WMO_FOG.has(code) ? 400 : WMO_CLEAR.has(code) ? 30000 : 15000;
		}
		let cloudPct = dailyMean(payload.hourly, 'cloud_cover', date);
		if (cloudPct === null) cloudPct = WMO_CLEAR.has(code) ? 15 : WMO_OVERCAST.has(code) ? 95 : 60;

		out.push(sanitize({
			date,
			windSpeed: Number(d.wind_speed_10m_max?.[i] ?? 0) || 0,
			windGust: Number(d.wind_gusts_10m_max?.[i] ?? 0) || 0,
			windDir: Number(d.wind_direction_10m_dominant?.[i] ?? 0) || 0,
			precipMm,
			rateMmH,
			visibilityM,
			cloudPct,
		}));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Snapshot

export const SOURCES = ['open-meteo', 'stale', 'procedural'];

// Confidence decays with the horizon, and starts lower when the bulletin is not
// measured: an invented forecast must not announce itself as sure as a reading.
const CONFIDENCE_BASE = { 'open-meteo': 0.96, stale: 0.72, procedural: 0.58 };

export function confidence(source, offset) {
	return clamp01((CONFIDENCE_BASE[source] ?? 0.5) - 0.075 * Math.max(0, offset));
}

export function makeSnapshot({ lat, lon, day = dayKey(), source, days }) {
	return {
		zone: zoneKey(lat, lon),
		lat, lon, day, source,
		fetchedAt: new Date().toISOString(),
		days: days.map((e, i) => ({ ...e, confidence: confidence(source, i) })),
	};
}

// A stale snapshot stays useful: it is the "last known snapshot" fallback. It
// is re-dated, its window is shifted onto the current day and its confidence is
// lowered — which stays honest, unlike serving it as-is.
export function restale(snapshot, day = dayKey()) {
	const shift = dayIndex(day) - dayIndex(snapshot.day);
	if (shift <= 0) return snapshot;
	const days = snapshot.days.slice(shift);
	if (days.length === 0) return null;
	return {
		...snapshot,
		day,
		source: 'stale',
		days: days.map((e, i) => ({ ...e, confidence: confidence('stale', i) })),
	};
}

export function today(snapshot) {
	return snapshot?.days?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Translation to the existing models
//
// This is the only place where the world speaks to wind.js / rain.js / fog.js.
// The three models do not change: their parameters are written, nothing is
// reimplemented.

// Shower or steady rain: rain.js's variability says "how much it comes and
// goes". A convective shower pulses a lot, an occlusion rain does not.
function rainVariability(day) {
	if (day.rateMmH <= 0) return 0.5;
	// A lot of water in few hours = showers; little water spread out = drizzle.
	const burst = clamp01(day.rateMmH / 8);
	return clamp01(0.30 + 0.55 * burst);
}

export function toSimParams(day) {
	return simParamsOf(sanitize(day));
}

// The translation alone, on a bulletin that ALREADY went through sanitize().
//
// Split out of toSimParams() for the bench (PHASE 26): sanitize() is not just a
// clamp, it is a set of physical-consistency rules — wind clears fog, it does
// not rain under a blue sky. Those rules are right for a bulletin and wrong for
// a bench, where the operator is allowed to ask for a shower under a clear sky
// and to see it arrive.
//
// The bench therefore calls simParamsOf() directly, with its own bounds. What
// it SHARES is the translation itself: at 12 m/s the bench and the world write
// exactly the same parameters into wind.js/rain.js/fog.js, so they fly the
// same. That is the whole point of not building a second one.
export function simParamsOf(d) {
	// Wind. rain.js/fog.js are in 0..1, wind.js is in physical units: the speed
	// goes through as-is, only the gust is converted into a knob.
	const speed = clamp(d.windSpeed, 0, 25);
	// wind.js sets GUST_PEAK = [0, 0.9]: knob 1 adds 90 % of the local mean at
	// the top of the gust. The gust factor therefore translates directly, with
	// no invented constant — it is the exact inverse of the model. Past a factor
	// of 1.9 the knob saturates, and that is a limit of wind.js and not of the
	// translation: in near-zero wind a gust factor of 3 is common and saturates
	// here without consequence, 90 % of 1.4 m/s still being calm.
	const gustFactor = speed > 0.5 ? d.windGust / speed : 1;
	const gust = clamp01((gustFactor - 1) / 0.9);
	// Turbulence: mechanical (the wind itself) plus convective (the shower). Fog,
	// on the contrary, is the sign of a stable layer, so it cuts it back.
	const stable = d.visibilityM < VIS_MIST ? 0.45 : 1;
	const turbulence = clamp(stable * (0.35 + 0.75 * (speed / WIND_GALE) + 0.35 * clamp01(d.rateMmH / 10)), 0, 2);

	// Rain. rateMmH is already the mean instantaneous rate; MAX_RATE is what "1"
	// means in rain.js.
	const rainIntensity = clamp01(d.rateMmH / MAX_RATE);

	// Fog. rain.js already adds its own extinction on top, so fog.js is only
	// given the visibility of the air *outside* rain — otherwise the same shower
	// would count twice.
	const airVis = d.rateMmH > 0
		? 1 / Math.max(1e-9, 1 / d.visibilityM - 1 / rainVisibility(d.rateMmH))
		: d.visibilityM;
	const fogIntensity = clamp01(intensityForRange(airVis));
	// Visibility never drops below RANGE_MIN in fog.js; a bank's variability is
	// higher when it is thin (it tears apart).
	const fogVariability = fogIntensity > 0 ? clamp01(0.65 - 0.35 * fogIntensity) : 0.5;

	// Cloud. cloudPct is already produced, already bounded and already made
	// consistent with rain and visibility by sanitize(); there is nothing to
	// model here, only a fraction to convert to.
	const cover = clamp01(d.cloudPct / 100);
	// A scattered sky churns — cumulus form and dissolve as you watch — whereas a
	// stratus lid is a stable layer that barely moves. Same shape and same reason
	// as fogVariability just above.
	const cloudVariability = cover > 0 ? clamp01(0.7 - 0.45 * cover) : 0.5;

	return {
		wind: { speed, direction: d.windDir, gust, turbulence },
		rain: { intensity: rainIntensity, variability: rainVariability(d) },
		fog: { intensity: fogIntensity, variability: fogVariability },
		cloud: { cover, variability: cloudVariability },
		// The sun (#23) takes the cover as-is, and the SAME out-of-rain visibility
		// as fog.js: that is the air's extinction, and the shower already has its
		// own. Handing it the total visibility would count the same rain twice —
		// once in the fog, once on the disc.
		sun: { cloudPct: d.cloudPct, visibilityM: airVis },
	};
}

// ---------------------------------------------------------------------------
// Text rendering (terminal)

const BAR_CELLS = 12;
export function confidenceBar(c, cells = BAR_CELLS) {
	// Floor, not round: a full bar must mean "certain", and no forecast is.
	const on = Math.floor(clamp01(c) * cells);
	return '█'.repeat(on) + '░'.repeat(cells - on);
}

export function headline(day) {
	return `${day.regime} / ${windLabel(day.windSpeed)}`;
}

export function formatVisibility(m) {
	if (!Number.isFinite(m)) return '—';
	return m >= 10000 ? `${(m / 1000).toFixed(0)} km`
		: m >= 1000 ? `${(m / 1000).toFixed(1)} km`
		: `${Math.round(m / 10) * 10} m`;
}

export function dayRows(snapshot) {
	return snapshot.days.map((d, i) => ({
		when: i === 0 ? 'TODAY' : `+${i}`,
		date: d.date,
		headline: headline(d),
		confidence: d.confidence,
	}));
}

// The block the terminal displays. Regime, wind, visibility, rain, fog,
// confidence — the six fields Bible section 5 asks for.
export function formatForecast(snapshot, { title = '' } = {}) {
	const t = today(snapshot);
	if (!t) return 'NO FORECAST';
	const fogRange = rangeFor(toSimParams(t).fog.intensity);
	const lines = [];
	if (title) lines.push(title.toUpperCase(), '');
	lines.push(`${snapshot.day} · ${snapshot.source.toUpperCase()}`, '');
	for (const r of dayRows(snapshot)) lines.push(`${r.when.padEnd(6)} ${r.headline}`);
	lines.push('',
		`WIND   ${t.windSpeed.toFixed(1)} m/s  G ${t.windGust.toFixed(1)}  ${compassPoint(t.windDir)}`,
		`VIS    ${formatVisibility(t.visibilityM)}`,
		`RAIN   ${t.rateMmH < 0.05 ? 'NONE' : `${t.rateMmH.toFixed(1)} mm/h`}`,
		`FOG    ${fogRange >= rangeFor(0) - 1 ? 'NONE' : formatVisibility(fogRange)}`,
		'',
		`CONFIDENCE ${confidenceBar(t.confidence)}`);
	return lines.join('\n');
}

// The regimes where a flight becomes a bad idea: Bible section 14 wants the
// pilot to think about it BEFORE flying, not on discovering the first gust.
const MARGINAL = new Set(['WINDY', 'GALE', 'STORM', 'HEAVY RAIN', 'RAIN', 'FOG']);

// PHASE 19 (issue #56) — what grades the weather line on the Home screen. User
// feedback of 2026-08-29: "when launching a flight you do not think about the
// conditions". Bible section 38 only allows a functional colour if it carries
// information: here the information is "does this change my decision to fly".
// The ranking is therefore the pilot's, not the meteorologist's — OVERCAST is
// ugly but flies, MIST flies badly.
//
//   nominal   nothing to report, the line stays in neutral ink
//   watch     flyable, but the wind or the water can be felt
//   marginal  degraded flight: visibility or wind work against the drone
//   nogo      you do not go out
//
// Every REGIMES entry has one, and no MARGINAL regime is classed under
// `marginal`: weather-selftest.mjs checks both.
const SEVERITY = {
	CLEAR: 'nominal', CLOUD: 'nominal', OVERCAST: 'nominal',
	MIST: 'watch', 'LIGHT RAIN': 'watch',
	FOG: 'marginal', RAIN: 'marginal', 'HEAVY RAIN': 'marginal', WINDY: 'marginal',
	GALE: 'nogo', STORM: 'nogo',
};

export function severity(day) {
	if (!day) return 'nominal';
	const base = SEVERITY[day.regime] ?? 'nominal';
	// A calm sky over an already sustained wind is still information: wind
	// strength decides as much as the regime, and `classify` only switches to
	// WINDY at 9 m/s when it can be felt from 6.
	if (base === 'nominal' && day.windSpeed >= WIND_BREEZY) return 'watch';
	return base;
}

// The CONDITIONS block rendered at TARGET SCAN (issue #76). Three lines — wind
// (strength + direction + label), rain, visibility — preceded by an alert when
// the day's regime is marginal. `null` when there is no snapshot: weather is not
// invented.
export function conditionsBlock(snapshot) {
	const t = today(snapshot);
	if (!t) return null;
	const lines = ['CONDITIONS', ''];
	if (MARGINAL.has(t.regime)) lines.push('>>> MARGINAL CONDITIONS', '');
	lines.push(
		`WIND         ${t.windSpeed.toFixed(1)} m/s  ${compassPoint(t.windDir)}   ${windLabel(t.windSpeed)}`,
		`RAIN         ${t.rateMmH < 0.05 ? 'NONE' : `${t.rateMmH.toFixed(1)} mm/h`}`,
		`VISIBILITY   ${formatVisibility(t.visibilityM)}`,
	);
	return lines;
}

// The one-line reminder at the foot of a target card: the last thing read
// before CONFIRM. `null` when there is no snapshot.
export function conditionsLine(snapshot) {
	const t = today(snapshot);
	if (!t) return null;
	const parts = [windLabel(t.windSpeed)];
	if (t.rateMmH >= 0.05) parts.push('RAIN');
	parts.push(`VIS ${formatVisibility(t.visibilityM)}`);
	return `${MARGINAL.has(t.regime) ? '>>> ' : ''}${parts.join(' · ')}`;
}

export { RANGE_MIN, MAX_RATE };
