# Game Viewer

A shared viewer for Vite-based browser games. It compiles a workspace on each save and displays
the result beside its agent. Godogen is its first consumer.

The viewer keeps the last ten rendered versions. A syntax error or a reported browser error
preserves the last working game. A new build waits while someone is playing or inspecting a
previous version. Active previews retain their files beyond the history limit, so a long run
does not lose its assets when the agent keeps editing.

Explore, Play, pause, and restart call the game's bridge. The studio also provides a build log,
version selection, an asset browser, and export to a new `out/game-N/` folder. Export does not
overwrite earlier exports. Versions are temporary; exported files stay in the workspace.

Games with snapshot support also have **Rewind**. Scrub the recent run, return to the untouched
live moment, or **Try from here** with a different move. **Pin moment** saves a canvas image,
the complete game state, a Keep/Change/Explore note, and a frozen copy of that version's compiled
game. **Saved moments** reopens it even after later edits or a viewer restart. Records live in
`out/playtests/<id>/moment.json`, alongside `screenshot.jpg` and `game/`, where the agent can read
the feedback. The editable source remains in the project. External asset URLs still need their
original service; bundle important assets into the game for durable saved moments.

## Use from a harness

```json
{
  "viewer": { "use": "autonomous/game-viewer" },
  "verdict": ".harness/verdict.json"
}
```

The consumer supplies a Vite installation in its package, a workspace `index.html`, and
its game dependencies. Harness passes the consumer's directory as `HARNESS_DSH_DIR`.
The server uses Vite's API with a fixed build configuration; a project `vite.config.*`
is not loaded.

`studio.json` provides `title`, `description`, and `controls`. The agent can write
`.harness/progress.json` with `phase` (`concept`, `world`, `play`, `polish`, or `check`)
and a short `message`. No percentages are inferred.

The game dispatches `harness:ready` after a real rendered frame and required assets have loaded.
It defines `window.harnessGame` with:

- `setMode('explore' | 'play')`
- `setPaused(boolean)`
- `restart()`
- `stats()`, optionally returning real `fps` and `objects` counts

The injected bridge reports readiness and errors. The viewer writes the verdict from those
reports; compilation alone does not set `ready`. A ready preview still needs gameplay testing.
Standalone exports do not depend on the studio server.

### Optional rewind contract

Add synchronous hooks to the same `window.harnessGame` object:

```js
captureState() { return { schema: 'my-game/1', /* complete gameplay state */ }; }
restoreState(snapshot) { /* validate first, then restore state, visuals, and HUD */ }
```

`captureState()` returns a JSON object of at most 64 KiB. Include positions, velocities,
collected items, scores, timers, random-generator state, and camera state as applicable.
`restoreState()` must reject incompatible snapshots **before** modifying the game. It must
leave pause and preview mode unchanged, clear held input, and update the visible world. The
studio stores the preview mode separately with each moment. Restoring is state
restoration, not replaying recorded keyboard events or running a deterministic simulation.

The bridge records up to 180 frames at five per second during unpaused Play (about 36 seconds).
`stats().time` may provide game seconds for the timeline. `stats().running = false` records the
terminal frame once, retaining the useful run instead of filling history with the finish screen.
Dispatch `harness:timeline-reset` when in-game controls start a new run; the studio's Restart
button clears the timeline itself. Stats used in moments must be JSON objects under 8 KiB.
`setPaused(true)` must freeze the state being captured, including camera inertia.

The viewer pauses and locks game input while scrubbing or writing a note. Restore failures are
reported separately from build failures, with an attempt to restore the previous state. Games
without these hooks retain the existing Play/pause/restart/export controls. The screenshot uses
the first canvas, or `canvas[data-harness-capture]`; it excludes HTML HUD overlays and may be
unavailable for a tainted canvas. WebGL games should preserve the drawing buffer for capture.
Each saved build can contain up to 512 MiB and 10,000 files, without symbolic links.

## Run and test

```sh
npm test
HARNESS_WORKSPACE=/path/to/game HARNESS_DSH_DIR=/path/to/consumer \
  HARNESS_VIEWER_PORT=4111 bash viewer.sh
```

Node 22.12 or newer is found on the machine or through Harness's managed runtime. The viewer
itself has no npm dependencies; Vite belongs to the consuming harness.

The server binds to loopback. Mutation requests require its per-process token and reject
foreign browser origins. Served files and exports stay within their designated directories.
It runs the local project's code, as any local game development server does.

## Credit and stewardship

Game Viewer is original MIT-licensed code by OpenHarness contributors. It uses Vite through
the consuming package and supports browser games that implement its small bridge. Game engines,
assets, and their licenses remain the consuming harness's responsibility.
