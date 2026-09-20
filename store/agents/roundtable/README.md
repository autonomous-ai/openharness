# Roundtable, a Harness agent

[Harness](https://github.com/autonomous-ai/openharness) agent package for making a decision with a
**panel of coding agents from different vendors** instead of one. You state the question; Claude
Code, Codex, OpenCode and Grok Build research it independently, argue about what they found, and the
pane shows you where they agree and where they don't. Runs on Claude Code as the moderator.

- `harness.json` — engine, template, skill, toolchain, and the shared [Web Viewer](../../viewers/web-viewer/)
  for the pane.
- `AGENTS.md` — the moderator's instructions. It never argues; it frames the motion, seats the room,
  calls the rounds, tags the claims and writes the decision.
- `toolchain/room` — the room engine. `room seats` finds the vendor CLIs on this machine,
  `room run <round>` runs every seat at once, and every command rewrites the pane and the verdict.
- `toolchain/lib/engines.mjs` — one row per engine (`claude -p`, `codex exec -s read-only`,
  `opencode run`, `grok -p`, `pi --print`, `hermes -z`). Adding a vendor is adding a row.
- `toolchain/lib/render.mjs` — the pane: a matrix, columns are seats and rows are rounds, over a
  claim map that shows settled rows against split ones. One generated `index.html`, no CDN.
- `skills/roundtable/` — the craft: writing a motion, seating, the sealed-openings rule, the claim
  map, and a decision that picks and keeps its dissent.

## How it works

The panelists are **not** Harness sessions and never appear as tiles. They are headless subprocesses
of each vendor's own CLI, spawned by the moderator, run in parallel, read-only where the CLI can say
so, and — critically — run **outside the workspace**, so a sealed opening really is sealed. The
moderator is the only process that writes a file.

That is also why this package needs nothing from the app or the daemon: a harness may run whatever
it likes from its toolchain, and a panel of agents is just six CLIs and a renderer.

## Credit and stewardship

Every seat is another vendor's software, run unmodified through the command line interface they
publish: [Claude Code](https://claude.com/claude-code) (Anthropic), [Codex](https://openai.com/codex)
(OpenAI), [OpenCode](https://opencode.ai) (SST), [Grok Build](https://x.ai) (xAI),
[Pi](https://github.com/earendil-works) and [Hermes](https://nousresearch.com) (Nous Research).
Nothing of them is vendored here and nothing is changed; Roundtable only chooses the arguments and
files the answers. Each runs under its own licence and the user's own account, and a vendor that is
not installed or not signed in simply has no seat.

This folder — the manifest, the room engine, the pane, the skill, the moderator's instructions — is
the Harness package, written by Autonomous, MIT (`LICENSE`).

If you maintain one of these engines and want its adapter to work differently, open an issue on
[autonomous-ai/openharness](https://github.com/autonomous-ai/openharness); the adapter table is six
lines per vendor and yours to correct.
