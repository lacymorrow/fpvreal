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

Open http://localhost:5173. It boots over uptown Charlotte. To fly somewhere
else, for now, put the coordinates in the URL:

```
http://localhost:5173/?at=48.8584,2.2945
```

The map screen that replaces this is the next milestone.

## Controls

| | |
|---|---|
| radio or gamepad | detected automatically in Mode 2. EdgeTX and OpenTX radios are recognised by USB id |
| throttle, yaw | `W` `S`, `A` `D` |
| roll, pitch | arrow keys |
| `R` | respawn |
| `V` | FPV or chase view |
| `M` | flight mode: acro, angle, altitude |
| `P` | rates: cinematic, freestyle, race, and the family presets |
| `Space` | pause |

Acro is the default, on the keyboard too. Held keys ramp instead of snapping
to full deflection, which is what makes acro survivable without a stick. A
crash cuts the video for a moment and puts you back on the pad.

Sound needs one key press or click first. That is a browser rule.

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
