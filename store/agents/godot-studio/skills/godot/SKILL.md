---
name: godot
description: Build Godot games with GDScript, native gameplay assertions and sandboxed Web exports. Use for Godot Studio project and game-mechanic tasks.
---

# Game source and proof

Project: `project.godot`; scene: `scenes/Main.tscn`; starter mechanics: `scripts/main.gd`. Lumen draws its own art and supports keyboard and pointer/touch destinations.

```sh
sh "$GODOT_SKILLS/godot/scripts/export-web.sh"
```

The helper copies source (excluding build/cache directories), imports, runs `scripts/proof.gd`, then exports the Web preset into fresh staging. `GODOT_BIN` selects an editor, and `GODOT_WEB_TEMPLATE` an optional matching single-threaded release template. Node 20+ bootstraps through the package helper.

Proof must instantiate real gameplay and assert meaningful state transitions. On success it writes `{"passed":true,"checks":[...]}` to `HARNESS_BUILD_DIR/proof.json`; on failure exit nonzero. A missing receipt is failure even if Godot exits zero. Keep assertions relevant when replacing the starter. A standalone proof can write to Godot's user data directory when that environment variable is unset.

Use `_physics_process` for movement and keep per-frame work bounded. Preserve keyboard, touch/click, pause and restart when useful for the requested game. The custom `web/shell.html` exposes actual game state through JavaScriptBridge, not a parallel simulated game.

The build verdict means native assertions and export passed. Verify the exported game in the actual shared viewer before claiming browser readiness. A browser playthrough must exercise game results, not just see a canvas.

The viewer requires a single-threaded export (Godot 4.3+), Compatibility renderer, no service worker or persistent browser storage. Keep the editor and templates version-matched. Only Godot 4.4's known optional PWA callback warning is downgraded in the opaque sandbox; other engine errors remain visible.

Optional interaction/performance probe:
```sh
HARNESS_WORKSPACE="$PWD" node "$GODOT_SKILLS/godot/scripts/perf.mjs" build/web/index.html
```
Uses shared Web Viewer + Playwright and the assertions in `proof.json`. It reports actual interaction frame timing; inspect the recorded renderer and do not extrapolate hardware performance to other devices.
