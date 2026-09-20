# Relay acceptance — 2026-09-20

This rebuild gives a person an original tabletop game: authored mechanics, human legal choices,
edits to components and rules, reproducible playtests and a physical/portable delivery. The old
spectator arena and original logos/icons remain in the repository. These are authored acceptance
briefs, not customer feedback, installed-agent prompt completions, or proof of fun/human balance.

## Observed workflows

- Actual Chrome input: private-hand turns, meaningful choices and outcomes, card text inspection,
  locks, undo/redo, an original imported SVG face, source save and prior-edition history.
- Running playtests retain their original rules when the draft changes. Applying a new edition
  keeps the old offline game and replay. Concurrent browser/agent edits remain downloadable.
- Simulations export the actual named policy, seeds, outcomes and action/state replays. Reopening a
  replay checks its source revision and every legal choice; modified state is rejected.
- Complete ZIP and offline HTML export reopen outside Harness and take real input. The 390px
  browser layout has no horizontal document overflow. This is emulation, not an actual-phone test.
- Invalid and nonterminating rules produce a recoverable error. The editor remains usable; a
  repaired module starts a working game again. No hostile-code sandbox claim is made.
- Setup and doctor use managed Node and pinned local build/browser tools, with no manual runtime
  installation step. Package/source-conformance and the 421 CLI Store/check tests pass locally.

## Three original briefs, six delivered editions

| Game | Mechanics | Targeted revision | Approved material | Winning human-input path |
| --- | --- | --- | --- | ---: |
| Pocket Conservatory | Two-player hand drafting, public gardens, pair/variety scoring | Pair bonus 4 → 6; poppy name/color | Unchanged original component ids and remaining designs | 12 turns before / 12 after |
| Signal Garden | Solo tile rotation and spatial connectivity | Rotation budget 24 → 18; entrance color | Center tile design and values | 11 turns before / 11 after |
| Night Ferry | Two-player draw-or-bank, storms, finite voyages | Voyages 3 → 4; silk cargo 4 → 5 | Moon tea design and values | 21 turns before / 27 after |

Each edition was exported, reopened and played through real browser buttons to its computed
outcome. The spatial puzzle also has an actual losing path after exhausting the rotation budget.
Rulebook edits from the reopened offline game remain source. Every edition runs 80 uniform-choice
simulations twice with matching results, no rule errors or turn caps; package tests reconstruct
every sampled replay. Uniform play frequently loses the puzzle, as expected from blind choices.

`test/verify-delivery.py` uses independent Python stdlib ZIP/JSON/XML and Poppler PDF readers.
It checks archive integrity, source equality, component and board dimensions, all physical copies,
A4 page sizes, readable PDF text within page bounds, printed inventory and approved hashes.
The six deliveries contain **14 PDFs / 36 pages**, visually reviewed through Poppler page images.
A print review caught and corrected oversized puzzle cells relative to tiles; the independent
reader now checks that printed ports can meet. Printed card values were enlarged and component
art is clipped at its physical edge. Cards, rulebook, settings and executable rules were compared.

Browser test evidence: `/private/tmp/relay-browser-final/report.json`. Final six-delivery evidence
is under `/private/tmp/relay-acceptance-release/`; final print pages are under `/private/tmp/relay-print-release/`. All 36 pages were reviewed;
34 stayed pixel-identical after clipping, and the two changed tile sheets were reviewed again. CI repeats package/browser/six-delivery/independent-reader tests.
Store screenshots are captured from actual games, not mockups.
A real materialized-workspace check caught silent CLI entry skips through symlinked temporary
paths. Build/check/export/viewer entry checks now resolve real paths; the entry-point regression
executes the actual build and rule-check commands through a workspace symlink.
The shared browser-runner integration was corrected after CI caught an illegal `continue`;
its Game Master dispatch and sibling-fetch/storage/module viewer regression then passed.

## Reproduce

```sh
sh store/agents/game-master/toolchain/setup.sh
node --test store/agents/game-master/test/*.test.mjs
node store/agents/game-master/test/browser.mjs
node store/agents/game-master/test/acceptance.mjs
python3 store/agents/game-master/test/verify-delivery.py work/experience-evidence/relay-acceptance
node store/agents/game-master/test/showcase.mjs work/experience-evidence/relay-acceptance
```

## Remaining scope

No native tabletop-simulator import, network multiplayer, commercial-print certification, real
printer/cutting trial, customer playtest or installed-agent prompt trial is claimed. Chrome on
this Mac and the CI browser are covered; other browsers and physical phones are unmeasured.
Print at actual size and check calibration. Optional backs are separate for gluing/sleeves, not
an assumed duplex registration. The package enforces finite project/state/action/time limits;
it does not promise arbitrary complexity, every possible seed, fun, fairness or human balance.
