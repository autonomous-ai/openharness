# Alpine Drift

A small Babylon.js snowboarding world to explore, play, and change with Godogen.
Press Play in Game Studio. A / D or left / right carve, Space jumps, W accelerates, S brakes,
and R restarts. Collect six gates before the finish. Trees can end a run; jump over them or turn.

Everything in this starter is procedural: terrain, trees, rider, hut, and gates. No asset-service
credentials are needed. Original OpenHarness starter code, MIT licensed.

## Files

- `src/main.ts`: world geometry, controls, gameplay, and the viewer bridge.
- `src/style.css`: the in-game HUD and finish screen.
- `studio.json`: project name and controls shown in the studio.

`npm run check` checks TypeScript. `npm run build` writes a standalone game in `dist/`.
Game Studio builds every save, preserves the previous working version on errors, and records
playable versions. Export copies the selected build into `out/` for you to host with a static server.

Try changing the season, adding a jump ramp, making another course, or replacing this with your own game.
