# FPV Real

Pick a place on Earth and fly it FPV with your radio, in the browser.

The scenery is not modelled. It is Google Earth's 3D photogrammetry, streamed
into your browser as you fly, with a Betaflight-shaped flight controller, a
250 Hz physics loop, and a radio that works the moment you move a stick.

## Fly it

You need Node 22 or newer and a WebGL2 browser. Chrome is the safe choice: its
Gamepad API picks up a radio as soon as you touch it.

```bash
git clone https://github.com/lacymorrow/fpvreal.git
cd fpvreal/sim && npm install && npm run dev
```

Open http://localhost:5173. A map asks where. Search a place or click it,
press FLY, and the terrain streams in around the pad. The place goes into the
URL, so a link is a place:

```
http://localhost:5173/?at=48.8584,2.2945
```

## Controls

| | |
|---|---|
| radio or gamepad | detected automatically in Mode 2. EdgeTX and OpenTX radios are recognised by USB id |
| `Tab` | setup: calibrate the radio, teach it your arm switch, pick the feel and rates, set the camera tilt |
| feel | `smooth` (default) turns off the propwash shake and steadies the camera. `real` is the measured airframe with the camera bolted to the frame |
| arm switch | once taught, it arms and disarms like a flight controller: throttle down to arm, off then on after a crash |
| throttle, yaw | `W` `S`, `A` `D` |
| roll, pitch | arrow keys |
| `R` | respawn |
| `V` | FPV or chase view |
| `M` | flight mode: acro, angle, altitude |
| `P` | rates: cinematic (the default), freestyle, race, and the family presets. Remembered per radio |
| `Space` | pause |

A radio starts in acro. The keyboard starts self-levelled, because someone
with no stick is here to look at a place, not to race it; `M` cycles to acro.
Held keys ramp instead of snapping to full deflection. A crash cuts the video
for a moment and puts you back on the pad.

Sound needs one key press or click first. That is a browser rule.

## Latency

The sticks are read inside every 250 Hz physics step, not once per frame, so
a radio snapshot is flown on the step after it arrives. What the browser adds
on top is measured, not claimed: open http://localhost:5173/latency.html with
the radio plugged in, move a stick for ten seconds, and it reports the
Gamepad API snapshot rate, the display rate, and the worst case the two add
together. The number for a Radiomaster on Chrome goes here once it has been
measured on real hardware.

## Fly a video

A bando on YouTube can become a place you fly. This part runs on your own
machine, not in the browser: it is hours of compute, and the result is a
folder of a few hundred megabytes.

```bash
brew install ffmpeg colmap
uv tool install yt-dlp
# Brush: download brush-app-<your platform> from
# https://github.com/ArthurBrussee/brush/releases and put brush_app on your PATH
cd pipeline && uv run fpvreal-scene "https://www.youtube.com/watch?v=XRcnQfmXYAA" --from 12 --to 42
```

One line per stage: frames, COLMAP camera poses, a Gaussian splat trained
with Brush on your GPU (Metal, Vulkan or DX12, no CUDA needed), the up vector
from the pilot's camera, the scale from the clock, a collision mesh. The last
line says where the scene went. Copy or symlink the folder into
`sim/public/scenes/` and open it:

```
http://localhost:5173/?scene=/scenes/hole-in-one/
```

The original pilot's line is drawn through the scene. The scale is a guess
from an assumed cruising speed of 8 m/s, printed and written into
`scene.json`; if the place feels too big or too small, rerun with `--speed`.
Pick the cruising section of a freestyle clip with `--from` and `--to`; flips
and dives register badly. Budget hours: on an M1 the first clip took about
four, most of it Brush. `docs/M2.md` has the design, the limits and what the
first run found; `docs/m2-hole-in-one.jpg` is what came out.

## Where it comes from

The flight stack and the terrain streaming are from
[FPVThePlanet](https://github.com/lionrayonnant/FPVThePlanet) by lionrayonnant,
AGPL-3.0. FPV Real keeps those modules with their boundaries intact and
replaces the game around them with one screen and one button. Their measured
tuning, their selftests and their bench tools come along. See
[`docs/PLAN.md`](docs/PLAN.md) for what was kept, what was cut, and where this
is going.

Terrain comes from Google Earth's own tile protocol, straight from Google to
your browser. Nothing passes through a server and nothing is stored. The
imagery stays © Google and is credited on screen, as Google requires.

## Develop

From `sim/`:

```bash
npm run dev        # Vite, hot reload
npm run build      # dist/
npm run selftest   # the kept module selftests, no browser, no network
npm run fuzz       # the rocktree protocol fuzzer
npm run tune       # the PID bench. Do not hand-edit gains.
```

The module boundaries are the reason the flight stack is testable. Keep them:

| module | owns | must not know about |
|---|---|---|
| `src/input.js` | normalised sticks, device mapping, calibration | the airframe |
| `src/flightController.js` | the Betaflight-shaped controller, `motors[4]` out | the airframe |
| `src/quad.js` | mass, inertia, motor lag, drag, ground effect, battery | Rapier, the DOM |
| `src/physics.js` | Rapier, collision, mass properties | the controller |
| `src/main.js` | boot, the frame, respawn | how any of the above works |

## Licence

[AGPL-3.0-only](LICENSE). Host a modified version for other people and you
publish your changes. Three.js, Rapier and the IBM Plex Mono font keep their
own licences, listed next to what they cover.
