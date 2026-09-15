# FPV Real: the plan

Written 2026-09-14, decisions taken 2026-09-15. DRI: Lacy.

One sentence: a browser tab where you drop a pin anywhere on Earth, press FLY, and your real radio is flying that place in under thirty seconds.

## Decisions

- **Name:** FPV Real, repo `fpvreal`. Chosen 2026-09-15. No GitHub repo used the name and fpvreal.com was unregistered at the time. "FPV World" and "Drone World" were taken.
- **Terrain:** Google Earth's internal rocktree protocol, as upstream ships it, until it stops working. The official Photorealistic 3D Tiles API costs money and there is none to spend. The browser fetches tiles directly from Google, nothing passes through a server, nothing is stored, the imagery is credited on screen. The provider interface stays in the design so a different source can drop in later without touching the flight code.
- **Order:** video-to-scene comes before gates and racing. Milestones renumbered below.

## The base

FPVThePlanet by lionrayonnant, AGPL-3.0. Taken as a hollow fork: the flight stack and the terrain streaming are kept with their module boundaries intact, the narrative game around them is gone, the shell is new.

What upstream gave us, verified on 2026-09-14:

- Live terrain streams from Google Earth with no key and no account. Uptown Charlotte was flyable about 15 seconds after page load.
- Radio support: EdgeTX and OpenTX radios detected by USB id (1209:4f54, Tango 2 included), per-device calibration, measured deadband, full-travel throttle. Gamepads get half-travel throttle so letting go disarms.
- A Betaflight-shaped controller with Actual Rates and bench-measured PID gains. A four-motor output so a real SITL can replace it later.
- 250 Hz fixed-step physics in Rapier with catch-up logic for dropped frames. Per-tile trimesh collision.
- Selftests that run with no browser, no network, no terrain.

What was cut: operator terminal, intro, briefing, target scan, hacking minigame, drone swarm, crew dialogue, 143 music tracks, session archive, the no-respawn rule, the settings screen, the Electron build, the Node server, the baked-scene pipeline. About 19,000 lines of `sim/src` and 171 tool files.

What was kept, by module:

| group | files |
|---|---|
| sticks and radio | `input.js`, `calibration.js`, `key-map.js`, `gamepad-dir.js`, `menu-nav.js` |
| flight stack | `flightController.js`, `quad.js`, `physics.js`, `frame-pacing.js`, `motor.js`, `blade-element.js`, `drone-profiles.js`, `wind.js` |
| terrain streaming | `rocktree-*.js`, `live-node-queue.js`, `RocktreeMaterial.js`, `TileMaterial.js`, `loader.js`, `tools/lib/rocktree`, `tools/lib/decoders`, `tools/lib/providers` |
| goggles and sound | `lens.js`, `link.js`, `rain.js`, `sky.js`, `sun.js`, `audio.js`, `audio-bus.js`, `space.js`, `chase-camera.js`, `fence-field.js`, `geofence.js` |
| benches | 27 selftests, the rocktree fuzzer, `tune-pid.mjs`, the UIUC propeller validator |

## The first ten seconds

1. The tab opens on a map centred on where you are, or the last place you flew. One search box. One button: FLY.
2. The map fades, the sky is there, tiles land around the spawn, a ring shows how much ground is trusted. Move a stick and a bar lights to show the radio was seen.
3. The quad sits on open ground, nose toward the open side. Arm on your switch, or press the key if there is no radio. You are flying. Crash: half a second of static, and you are back on the pad. Nothing to click.

Nothing else is on either screen. Rates, camera tilt and the flight-mode key sit behind one settings key and remember themselves.

## Milestones

### M0, the hollow fork. Done 2026-09-15.

New repo from upstream with history kept for credit. Drop list deleted. A 520-line `main.js` boots the flight loop on a lat/lon from the URL, defaulting to uptown Charlotte. The 27 kept selftests pass and the fuzzer finds nothing. Flown in Chrome: the quad spawns on Tryon Street with the OSD live (`docs/m0-charlotte.jpg`).

Found on the first flight, carried into M1:

- A keyboard takeoff at full throttle in acro flipped the quad onto its back. Needs the radio test before anyone touches the tune.
- The spawn is wherever ground is under the origin, which can be a roof or a wall. The spawn raycast in M1 fixes this.

### M1, drop in anywhere with a radio. The demo.

Built 2026-09-15, waiting on the radio walk. Everything below is in the tree
and exercised in Chrome with a keyboard; the arm switch, the calibration
wizard, per-radio rates and the latency bench need a transmitter in the room,
which the session that built them did not have.

- Map screen: Leaflet, Nominatim search, geolocate, pin, FLY. Location and view range in the URL so a link is a place.
- Spawn: raycast down from the pin to the first trusted tile, back off to open ground, place the quad 1 m up facing the longest clear ray.
- Arm on an aux channel with a threshold. Refuse to arm above idle throttle. Disarm on the same switch. Keyboard fallback stays.
- Sample the pad inside the physics substep, not once per frame.
- Measure stick-to-motor latency at 60, 120 and 144 Hz, in Chrome and Firefox. Publish the number in the README.
- WebHID only if that number is above one display frame.
- Rates follow the transmitter, the way calibration already does.
- Remap and calibrate screen, rebuilt small. Upstream's lived inside the dropped settings module.
- Loading, no-terrain, no-radio and no-location states designed on purpose.

Done when a 60 second recording with the radio in frame passes the demo test.

What the keyboard walk found on 2026-09-15: the first pad search scored a
roof over the street (fixed: mean clearance plus a strong low-ground term),
then put the quad on a hillside where it sat rolled 35 degrees (fixed: a
flatness probe rules out slopes over 25 %). Both are in `spawn-selftest.mjs`.

### M2, video to scene.

Built 2026-09-15, its own plan in `docs/M2.md`. A local command
(`pipeline/`, `fpvreal-scene`) turns a YouTube link or a file into a scene
folder: frames, COLMAP poses, a Brush splat trained on the Mac's GPU, the up
vector from the pilot's camera, the scale from the clock, a marching-cubes
collision mesh. The sim opens the folder with `?scene=`: Spark renders the
splat in the same scene, Rapier gets the mesh, the pad search runs on it, and
the pilot's path is a ghost line. Nothing in the browser runs the pipeline;
that needs compute there is no money for.

Done when one bando video becomes a flyable scene with the original pilot's line.
First run 2026-09-15: a 30 s section of a bando clip became a scene the sim
boots in 6 s, pad on the floor, the pilot's line through the building
(`docs/m2-hole-in-one.jpg`, the numbers in `docs/M2.md`). Not yet flown with
a radio.

### M3, the racing loop.

Gates placed on the map or along a recovered path, a lap timer, a ghost of your best lap, and a share link that encodes location and gate layout in the URL. No accounts, no server state.

Done when two people fly the same track from the same link and compare times.

### M4, public.

Static hosting, the source published under AGPL. Terrain stays rocktree until it breaks.

## Risks

- **Rocktree goes away.** Accepted. The provider interface is the mitigation; the day it breaks, the swap is a loader, not a rewrite.
- **Streaming stalls.** Upstream documents 700 to 1,700 ms tile stalls and has catch-up logic. Racing needs the spawn ring fully loaded before arming.
- **Flight feel.** Upstream's maintainer has an unmerged gravity-fix branch with the note that nothing on it has been flown in a browser. Nobody who races has tuned this. Lacy flying it with a real radio is the first real test, and the tuning bench turns that into numbers.
- **Photogrammetry has no interiors,** no thin structures, and melts under gates. Right for "fly anywhere", wrong for a bando. That is why M2 exists.
- **Plain JavaScript, no lint, no types** in the kept modules, so upstream fixes can be pulled in. The shell follows suit; mixing in one tree is a seam.

## Demo test for M1

1. Ten seconds: map, FLY, flying.
2. Removed: the drop list, plus the settings screen cut down to rates, camera tilt, and mode.
3. One action per screen: FLY on the map, arm on the pad.
4. Defaults: calm weather, freestyle rates, 25° camera, acro.
5. States: no location permission shows the search box with a hint. Tiles failing shows the message and a button to pick another spot. No radio shows the keys. Offline is not supported and says so.
6. Feel: arm to motors under one frame, respawn under one second, stick latency published.
7. Seams walked: map, sky, pad, flight, crash, pad, one visual language.
8. Stage test: would you demo it to the Velocidrone author.
9. Evidence: the recording, the latency number, the screenshot.
10. DRI: Lacy.
