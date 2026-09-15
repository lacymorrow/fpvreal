# CLAUDE.md

FPV Real: a browser FPV simulator over real photogrammetry. Pick a place, fly
it with your radio. Hollow fork of FPVThePlanet (AGPL-3.0): the flight stack
and terrain streaming are upstream's, the shell is ours.

## Layout

- `sim/src/main.js`: the shell. Boot, the frame loop, respawn, the OSD. Keep
  it small. Nothing about the airframe, controller or radio belongs here.
- `sim/src/{input,calibration,key-map,gamepad-dir,menu-nav}.js`: sticks and
  radio. Upstream, kept.
- `sim/src/{flightController,quad,physics,frame-pacing,motor,blade-element,drone-profiles,wind}.js`:
  the flight stack. Upstream, kept.
- `sim/src/{rocktree-*,live-node-queue,RocktreeMaterial,TileMaterial,loader}.js`
  and `sim/tools/lib/rocktree`: terrain streaming. Upstream, kept.
- `sim/src/{lens,link,rain,sky,sun,audio,audio-bus,space,chase-camera,fence-field,geofence}.js`:
  goggles optics, video link, sky, sound. Upstream, kept.
- `sim/tools/*-selftest.mjs`: one per kept module. `npm run selftest` runs them.
- `docs/PLAN.md`: what was kept, cut, and the milestones. `docs/upstream/`:
  upstream's own notes on the flight model, sound and rendering.

## Commands

From `sim/`: `npm run dev`, `npm run build`, `npm run selftest`, `npm run
fuzz`, `npm run tune`. No lint is configured. Plain JavaScript, no transpiler.

## Rules that bite

- Do not hand-edit PID gains, thresholds or airframe constants. They are
  measured. Retune with `npm run tune` and commit what the bench produced.
- Keep the module boundaries in the README table. A fix that teaches
  `flightController.js` about the airframe, or `main.js` about the mixer,
  gets sent back.
- Coordinates are local ENU metres: X east, Y up, Z south. The drone collider
  is a 0.15 m sphere and the camera near plane is exactly 0.15. Rapier damping
  is zero on purpose; `quad.js` computes drag.
- Every physics step resets Rapier forces and torques.
- Kept upstream files stay upstream-shaped so their fixes can be pulled in.
  Translate French comments to English only in a file touched for another
  reason.
- Terrain is Google's imagery. The on-screen credit stays. Nothing is stored
  server-side, nothing is redistributed.
- Run the module's own selftest while working. Run the whole chain once, at
  the end, before committing.
- No em dashes anywhere.

## Milestones

M0 hollow fork (done 2026-09-15). M1 map screen, spawn on open ground, arm
switch on aux, sticks sampled per physics substep, measured input latency.
M2 video to scene. M3 racing loop. See `docs/PLAN.md`.
