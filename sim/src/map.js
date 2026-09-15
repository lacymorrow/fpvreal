// The map screen: one search box, one pin, one button.
//
// Resolves with { lat, lon } when the pilot presses FLY. Knows nothing about
// the sim; main.js takes the place from here to the boot.

import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const LAST_PLACE_KEY = 'fpvreal.lastPlace';
// Somewhere with 3D coverage, for a first run with no location permission.
const FALLBACK = { lat: 35.2271, lon: -80.8431, zoom: 16 };

export function loadLastPlace() {
	try {
		const p = JSON.parse(localStorage.getItem(LAST_PLACE_KEY));
		if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) return p;
	} catch { /* nothing saved */ }
	return null;
}

export function saveLastPlace(place) {
	try { localStorage.setItem(LAST_PLACE_KEY, JSON.stringify(place)); } catch { /* private mode */ }
}

async function geocode(query) {
	const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
	const res = await fetch(url, { headers: { Accept: 'application/json' } });
	if (!res.ok) throw new Error(`search failed (${res.status})`);
	const rows = await res.json();
	if (!rows.length) return null;
	return { lat: Number(rows[0].lat), lon: Number(rows[0].lon), name: rows[0].display_name };
}

function locate() {
	return new Promise((resolve) => {
		if (!navigator.geolocation) return resolve(null);
		navigator.geolocation.getCurrentPosition(
			(pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
			() => resolve(null),
			{ timeout: 8000, maximumAge: 600000 },
		);
	});
}

export function pickPlace(root) {
	return new Promise((resolve) => {
		root.insertAdjacentHTML('beforeend', `
			<div id="pick">
				<div id="pick-map"></div>
				<form id="pick-bar" autocomplete="off">
					<span id="pick-brand">FPV REAL</span>
					<input id="pick-search" type="search" placeholder="Search a place, or click the map" aria-label="Search a place">
					<button id="pick-locate" type="button" title="Where I am">◎</button>
					<button id="pick-fly" type="submit" disabled>FLY</button>
				</form>
				<p id="pick-hint">Click anywhere with 3D buildings. Google Earth covers most cities.</p>
			</div>`);
		const el = {
			screen: root.querySelector('#pick'),
			search: root.querySelector('#pick-search'),
			locate: root.querySelector('#pick-locate'),
			fly: root.querySelector('#pick-fly'),
			hint: root.querySelector('#pick-hint'),
			form: root.querySelector('#pick-bar'),
		};

		const last = loadLastPlace();
		const start = last ?? FALLBACK;
		const map = L.map('pick-map', { zoomControl: false, attributionControl: true })
			.setView([start.lat, start.lon], start.zoom ?? 16);
		L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
			maxZoom: 19,
			attribution: '© OpenStreetMap contributors',
		}).addTo(map);
		L.control.zoom({ position: 'bottomright' }).addTo(map);

		let pin = null;
		let place = null;
		function setPlace(lat, lon, { pan = false } = {}) {
			place = { lat, lon };
			if (!pin) {
				pin = L.circleMarker([lat, lon], { radius: 9, color: '#e4552b', weight: 3, fillColor: '#e4552b', fillOpacity: 0.35 }).addTo(map);
			} else {
				pin.setLatLng([lat, lon]);
			}
			if (pan) map.setView([lat, lon], Math.max(map.getZoom(), 16));
			el.fly.disabled = false;
			el.hint.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}. Press FLY.`;
		}
		if (last) setPlace(last.lat, last.lon);

		map.on('click', (e) => setPlace(e.latlng.lat, e.latlng.lng));

		el.locate.addEventListener('click', async () => {
			el.hint.textContent = 'Asking the browser where you are';
			const here = await locate();
			if (!here) {
				el.hint.textContent = 'No location from the browser. Search for a place, or click the map.';
				return;
			}
			setPlace(here.lat, here.lon, { pan: true });
		});

		el.form.addEventListener('submit', async (e) => {
			e.preventDefault();
			const q = el.search.value.trim();
			// Enter in the search box with text searches; Enter with an empty
			// box, or the FLY button, flies.
			if (q && document.activeElement === el.search) {
				el.hint.textContent = `Searching for ${q}`;
				try {
					const hit = await geocode(q);
					if (!hit) { el.hint.textContent = `Nothing found for ${q}. Try a city or an address.`; return; }
					setPlace(hit.lat, hit.lon, { pan: true });
					el.hint.textContent = `${hit.name}. Press FLY.`;
					el.fly.focus();
				} catch (err) {
					el.hint.textContent = `Search is not reachable right now (${err.message}). Click the map instead.`;
				}
				return;
			}
			if (!place) return;
			saveLastPlace({ ...place, zoom: map.getZoom() });
			map.remove();
			el.screen.remove();
			resolve(place);
		});

		if (!last) {
			// First run: offer the browser's location without a click, but the map
			// is usable before the answer comes.
			locate().then((here) => { if (here && !place) setPlace(here.lat, here.lon, { pan: true }); });
		}
	});
}
