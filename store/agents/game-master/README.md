# Game Master · Relay

![Relay logo](brand/logo.svg)

Turn an idea into a board or card game people can play. Author original rules, design the cards
and pieces, test real decisions, and keep a complete offline game and physical print-and-play kit.
The agent writes the mechanics from your brief; you can edit the resulting game directly.

## What you can do

- Create new mechanics in an editable rules module. Drafting, cooperative routing and
  push-your-luck are verified examples, not the available genres in a menu.
- Play legal choices, see scores and outcomes, pass a private hand between local players,
  undo a testing move, save a replay and reconstruct it against the same rules.
- Edit components, copies, values, colors and original or supplied SVG/PNG/JPEG/WebP face artwork.
  Lock approved pieces, undo edits, revise the rulebook and keep the complete source.
- Apply a new edition while retaining the old playable game and replay. Workspace source saves
  use revision checks and history; concurrent agent/browser revisions remain recoverable.
- Run repeatable games under uniform choices or a named authored policy. Inspect errors, turn
  caps and outcome distributions, with seeds and replays for the actual runs.
- Export an offline editable/playable HTML, JSON and JavaScript source, individual SVG pieces,
  A4 print sheets, boards, rulebook, PDFs and ZIP. You can play and print without Harness running.

## Try a brief

> I want a tiny two-player game about growing a garden. Let us choose plants from hands we pass,
> with points for flower-and-water pairs. Make cards we can actually print. After we play, help
> me change the scoring while keeping the artwork I approve.

The workspace begins with **Pocket Conservatory**, a complete original drafting game. The
[acceptance record](test/ACCEPTANCE.md) also covers **Signal Garden**, a routing puzzle, and
**Night Ferry**, a push-your-luck card game, each with a targeted revision and physical delivery.

## Build and keep the work

Setup resolves Node, installs pinned local tools and reuses Chrome/Chromium or installs its local
browser. `GAME_DSH_DIR` locates those tools from an installed workspace.

```sh
node tools/build.mjs
node tools/check.mjs --seeds 80
node tools/export.mjs delivery
```

The [source contract](skills/game/references/project.md) explains how to author mechanics and
components. The browser also exports a complete kit and opens print views; use the print dialog
for PDF. Print at 100% / actual size, without browser headers or footers, and check the 50 mm line.
Backs are supplied separately for gluing or opaque sleeves; no duplex alignment is assumed.

## Scope and evidence

This is local human play and game design for 1–6 players, with an explicit finite project/state
size and turn budget. The pass-and-play curtain hides casual views; source and replay files are
not secret from the browser owner. There is no network multiplayer or native game-engine import.
Rules run in a worker so a broken module can be stopped while source remains editable.

Simulations measure the named policy, seeds and authored rules. They do not establish fun, human
balance or commercial quality. Authored acceptance fixtures are not customer or installed-agent
prompt trials. Helpers keep `ready:false` until actual requested play and delivery are reviewed.

The original arena source remains under `store/tools/experiences/game-master.*`; existing legacy
workspaces are not automatically migrated or overwritten.

## Logo and icon

The original Relay identity remains in `brand/`: [vector icon](brand/icon.svg), [PNG](brand/icon.png),
[light logo](brand/logo.svg) and [dark logo](brand/logo-dark.svg). The mark also appears in the
studio, offline favicon and desktop Store/picker/tabs.

## Credit and stewardship

Original implementation, game fixtures and visual identity by OpenHarness contributors,
maintained by Autonomous under the [MIT license](LICENSE). The offline runtime has no third-party
code dependency. Package-local build tools are esbuild 0.27.2 (MIT) and Playwright Core 1.63.0
(Apache-2.0); their licenses remain in the installed packages. No third-party game design is copied.
