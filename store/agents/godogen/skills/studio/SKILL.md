---
name: studio
description: Build and verify a Babylon.js game progressively in OpenHarness's live Game Viewer.
---

# The live game studio

The viewer compiles saves into isolated versions. A broken edit cannot replace the last working
game. While the user plays, a new version waits behind **View update** so it never resets their run.

## Loop

1. Update `.harness/progress.json`: `{"phase":"world","message":"Shaping the mountain"}`.
   Phases are `concept`, `world`, `play`, `polish`, `check`. Report real work, with no invented timings.
2. Edit `src/`, `public/`, and `index.html`. The viewer watches these files. Import generated assets
   using Vite URLs (`import treeUrl from './assets/tree.glb?url'`); avoid absolute `/assets/` paths.
3. After every small milestone, `npm run check`. Inspect the preview, then test the game.
4. `node "$GODOGEN_TOOLS/check.mjs"` checks the actual viewer's current build/runtime state.
   It requires an open viewer. Its success means the preview rendered without reported errors;
   it does not replace gameplay testing. Never fabricate a successful runtime report.

## Bridge

Define `window.harnessGame` with `setMode('explore'|'play')`, `setPaused(boolean)`, `restart()`,
and `stats()` returning real values. `stats()` may include `fps`, `objects`, `score`, `distance`.
The starter demonstrates all of these. After the first successful render, dispatch
`new CustomEvent('harness:ready')`. Game Viewer captures errors before that event and keeps the
previous version visible. Do not remove the error bridge or signal success before rendering.

Keyboard listeners should use `event.code`, release input on blur, and prevent arrow/space scroll
only when the game has focus. Progress must use elapsed seconds, not an assumed frame rate.
Respect pause, reduce motion, and audio muting. Use clear focus styles and readable contrast.

## Rewind and playtest moments

The starter also exposes synchronous `captureState()` and `restoreState(snapshot)`. Keep them
when changing the game. Capture a JSON object under 64 KiB with a schema identifier and all
state needed to continue: positions, velocities, collected items, score, elapsed time, random
state when used, and the camera. Validate the whole snapshot before mutating anything. Restore
meshes and HUD immediately, clear held keys, and leave pause and preview mode unchanged. The
studio stores preview mode separately with each moment. `setPaused(true)` freezes
the simulation and camera inertia. A replacement game must use its own schema and state shape.

The studio records five frames per second, keeping the latest 180. It pauses while the player
scrubs, then restores the live moment or resumes from the selected frame. Return game seconds
as `stats().time`; `stats().running = false` preserves the terminal frame without overwriting
the run with an idle finish screen. Dispatch `harness:timeline-reset` when an in-game restart
control begins a new run. Studio Restart already clears history.

Pin moment writes `out/playtests/<id>/moment.json`, an optional `screenshot.jpg` of the game
canvas, and `game/` containing that exact compiled version. Read these notes when responding
to playtest feedback. A Keep note is something to preserve; Change and Explore notes describe
the user's requests. Saved builds stay compatible with their own snapshots after source edits.
The current editable source remains in `src/`; never imply the archived build is the current
source. Do not delete or overwrite user moments. Revisit through Saved moments to inspect them.

Verify pause → capture → play → restore → resume, including an already-collected item and a
moving/jumping character. Reject an incompatible snapshot without changing the world. Confirm
the player can steer after resuming and that the saved state reopens with its original build.

## Project facts

`studio.json` contains `title`, `description`, and `controls` (short text). Keep those accurate.
Put the current brief, completed features, remaining work, and asset attribution in `README.md`.
For external services, get the user's budget before the first paid generation and retain provenance.

## Verification

Use browser capture on the running preview. Exercise Play, movement, restart, and a full game loop.
Check the canvas is nonblank, there are no runtime errors, and controls also work at a narrow size.
Finish by setting phase `check` with a factual message describing the checks that actually passed.
