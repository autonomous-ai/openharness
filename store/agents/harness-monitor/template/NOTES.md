# Your harnesses

This folder is Harness Monitor's workspace. Almost nothing lives here, on purpose — there is one fleet per
machine, so there is one policy per machine:

- **The rules:** `~/.config/harness/policy.jsonc` — commented, hand-edited, read on every refresh. Or drag
  the two lines in the pane. Preview a change without moving anything: `hps pause --policy`.
- **The resume tickets:** `~/.harness/monitor/paused.json` — which conversation each paused harness had.
- **What happened, and why:** `~/.harness/monitor/log.jsonl`.

The only file Harness Monitor writes here is `.harness/verdict.json`, the pane header. Deleting this folder
loses nothing.
