# Game Master — original tabletop-game workshop

Published in [#153](https://github.com/autonomous-ai/openharness/pull/153) at `1dee0b70289522d0b7a1091d730b367bb329383a`. Both CI jobs passed at the exact PR head; catalog publisher `35508683804` succeeded. The public catalog, studio HTML and three screenshots match the tested source. Normal installation, doctor, fresh workspace materialization, actual build/check/export commands and the viewer command passed on this Mac. Installed/public package revision: `7a0e20d840a4e163dac81f95fc3c1536d34a5e2d`. The prior arena remains
under `store/tools/experiences/game-master.*`. Relay branding is preserved. The new package uses
ordinary authored JavaScript rules and editable component/board data to produce playable tabletop
games and physical kits. Phaser/Godot already cover video-game engine creation in the Store.

The human can take legal actions, see actual outcomes, pass private views locally, inspect card
text, undo testing turns, save/reopen source and replays, import original face artwork, lock
approved components, revise rules/values, inspect sampled policies and keep an offline game plus
SVG/HTML/PDF source and print kit. No fixed genre menu or pretend prompt-to-game button.

See [acceptance evidence](../store/agents/game-master/test/ACCEPTANCE.md). Three original games and
six before/after editions cover drafting, spatial routing and push-your-luck. Real browser inputs
reach outcomes; independent readers check the actual physical files. Review found and fixed ZIP
input handling, rule-worker recovery, private-view keyboard access, small printed values, and
puzzle tiles that did not fit the original board cells. Browser source conflicts preserve both
editions. Nonterminating rules can be stopped and repaired. Actual workspace materialization found a
symlinked-path CLI entry bug; the tools now resolve real paths and a regression runs actual
build/check commands through a workspace symlink.

No customer/installed-agent prompt trial, fun/balance result, printer trial, native tabletop
simulator import or network multiplayer is claimed. Evidence is in `/private/tmp/relay-public-bytes.json`, `/private/tmp/relay-installed-workspace.json` and `/private/tmp/relay-installed-viewer.json`. Lab Bench is next. Do not delete old code or change other sessions' worktrees.
