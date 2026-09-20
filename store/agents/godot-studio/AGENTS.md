# Godot Studio workspace

Read `skills/godot/SKILL.md`. The source project is at the workspace root; the pane follows `build/web/index.html`.

- Start by building the shipped Lumen game so the user has something playable.
- Keep native gameplay assertions in `scripts/proof.gd` relevant to the mechanics. Export success alone is not browser verification.
- Run the staged export after meaningful changes, then play the real build and exercise movement, goals, pause and restart.
- Keep single-threaded Web exports and the Compatibility renderer for the isolated shared viewer. Do not weaken the viewer sandbox to enable threads or storage.
- A failed build clears ready and preserves prior output. Report current failure rather than pointing at an old game as new evidence.
