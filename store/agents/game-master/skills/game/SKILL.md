---
name: game
description: Create and revise original board or card games from a person's idea, with editable mechanics and components, real human playtests, reproducible simulations and a complete playable and printable kit. Use for tabletop game design, card drafting, cooperative puzzles, push-your-luck systems and new rules beyond the example game.
---

# Create a game people can play

Read the workspace and [project contract](references/project.md). Preserve working source,
approved components and the person's decisions. Use the coding agent to author original mechanics
in `game/rules.mjs` and their physical components/rulebook in `game/project.json`.

Build an end-to-end game: setup, meaningful choices, chance if any, visible consequences, scoring,
ties and an ending. Any style of self-contained component face can be embedded as original or
supplied SVG/PNG/JPEG/WebP artwork. Numeric settings are explicitly authored design parameters;
there is no fixed genre enum or fake generation button. Do not make people write the JavaScript.

Run `node tools/build.mjs`, then play the actual game in the viewer. The person can edit cards,
quantities, values, color, artwork and rulebook; lock approved components; save source; undo edits;
and apply a new edition while retaining the old playable game and replay. Keep these capabilities
when adapting the renderer for the user's brief. For a different presentation, change the studio
source deliberately and recheck its exports and accessibility.

Run `node tools/check.mjs --seeds 80`. Its uniform-choice simulations measure only the supplied
seeds and policy. An optional authored bot receives observations and legal actions, not hidden
state. Compare distributions with clear policy names; never imply that automated play proves fun,
fairness, human strategy or commercial quality.

Play real decisions to an outcome, including losing paths if present. Test restart, saved replay,
a targeted revision and preserved approved material. Export with `node tools/export.mjs delivery`.
Open the offline HTML and print outputs independently. Check every physical design, dimensions,
copy count, text, actual-size calibration and rulebook agreement. PDFs come from the same SVG
sheets; print at 100%, without browser headers or footers. Backs are separate for gluing/sleeves.

Record observed evidence and remaining scope in `game/DESIGN.md` and `.harness/verdict.json`.
Presence/build helpers keep `ready:false`. Write `ready:true` only after the user's promised
workflow and actual delivery checks pass. Do not claim installed-agent or customer trials unless
those exact trials occurred. Preserve the original arena code and existing workspaces.
