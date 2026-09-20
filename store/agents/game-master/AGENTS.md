# Game Master / Relay

Turn a person's idea into an original **board or card game they can actually play, revise and
print**. The coding agent authors mechanics; the studio does not pretend a list of presets is
creation. Pocket Conservatory is a complete example and a starting point, not a genre limit.
Phaser and Godot harnesses cover video-game engine workflows; this package specializes in tabletop
rules, human playtesting and physical delivery.

## Work from the person's game

1. Identify players, decisions, goals, hidden information, components and a complete ending. Ask
   only for decisions that change the work; choose reasonable defaults and record them.
2. Author `game/project.json` and the full `game/rules.mjs`. Read the [contract](skills/game/references/project.md).
   Rules are ordinary import-free JavaScript: no fixed list of genres or mechanics. Component
   designs, original face artwork, quantities, boards, scoring values and rulebook stay in source.
3. Build with `node tools/build.mjs`. Play the actual legal choices in the viewer. Make the first
   playable version early, then improve it against the brief. Do not replace source with one
   manually edited generated HTML; source saves must continue to work.
4. Revise only what the person asked to change. Locked components represent approved work.
   Preserve their ids, values and face artwork unless a requested change requires otherwise.
   Browser drafts and running games are distinct editions; keep old rules and replays.
5. Deliver `node tools/export.mjs delivery`: playable offline HTML, complete source, individual
   SVG components, A4 sheets, board sheets, PDF rulebook/components and ZIP. Open the offline game,
   perform real inputs, inspect every unique printed design and read the rulebook against the rules.

`GAME_DSH_DIR` points to the installed package. Setup supplies Node and pinned local build/browser
utilities. If Node is not on the host PATH, run `bash "$GAME_DSH_DIR/toolchain/node.sh" tools/build.mjs`
from the workspace. Doctor checks the actual tools. Do not ask a nonprogrammer to install runtimes
manually when setup can do it.

## What counts as verification

- `node tools/check.mjs --seeds 80` samples uniform legal choices, repeats exact seeds, detects
  illegal actions/dead ends/turn caps and reconstructs every replay. Add an observation-only `bot`
  for a clearly named strategy. Do not call sampled policy win rates human balance or fun.
- Actually play through beginning, decisions, scoring and a final outcome. Exercise losing paths
  where the game has them; restart, undo a testing move and reopen a saved replay.
- Keep rulebook, printed values and executable rules in agreement. The physical game must specify
  setup, every legal decision, chance procedure, turn order, scoring, ties and how it ends.
- Export after revisions. Independently inspect ZIP/JSON/SVG/PDF files, physical sizes, inventory
  counts, text legibility and cut guides. Custom artwork owns its printed text: revise it when
  the mechanics change. Use local, original or user-supplied artwork and retain its provenance.
- Record exact commands, seeds, user inputs, observations and limits in `game/DESIGN.md` and
  `.harness/verdict.json`. A build or helper never sets `ready:true`. Mark readiness only after
  the promised game and delivery checks actually pass. No invented customer or installed-agent
  trial, synthetic feedback, play counts, or test-coverage percentages.

## Boundaries to keep visible

One browser supports local human play and pass-and-play. Its curtain conceals casual views, not
source/state from a browser owner. Replays contain the full deterministic state. There is no
network multiplayer, account, cloud service or game-engine import promise. Rules must use seeded
context randomness and remain self-contained; do not use network requests, clock time, globals
for mutable game state or unseeded randomness. A worker time limit keeps bad rules from freezing
editing; it does not prove every game will terminate.

The old arena source remains under `store/tools/experiences/game-master.*`. Never erase existing
legacy workspaces or force them into the new project format.
