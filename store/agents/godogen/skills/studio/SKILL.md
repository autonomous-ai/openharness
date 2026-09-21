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

## Project facts

`studio.json` contains `title`, `description`, and `controls` (short text). Keep those accurate.
Put the current brief, completed features, remaining work, and asset attribution in `README.md`.
For external services, get the user's budget before the first paid generation and retain provenance.

## Verification

Use browser capture on the running preview. Exercise Play, movement, restart, and a full game loop.
Check the canvas is nonblank, there are no runtime errors, and controls also work at a narrow size.
Finish by setting phase `check` with a factual message describing the checks that actually passed.
