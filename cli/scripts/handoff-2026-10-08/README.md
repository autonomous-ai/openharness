# Scripts from the daemon separation (2026-10-08)

Kept for the next session; see `docs/research/2026-10-08-daemon-separation-handoff.md`. Node on PATH, run from anywhere.

- **`closure.mjs`** measures the core's static import closure (esbuild from `core/main.ts`, every `import()` external): lines, files, and the biggest contributors.
- **`importers.mjs <cli dir> <regex>`** shows who imports each matching file in that closure, to find the edge that pulls something in.
- **`mutate*.py <cli dir>`** each flip one wiring point at a time (a call site, a declared rule, an engine branch), run that step's golden, and expect it to fail. That is how each move's golden was shown to catch broken wiring. One script per step: admission, adoption, hooks, identity, runtime, transcripts. `mutate.py` is the first, for launch argv.
- **`land-direct.sh <worktree> <branch> <pr>`** lands a PR as described in the handoff:
  - marks it ready;
  - merges main in when main moved;
  - waits for every check on the head, `ci/required` included;
  - then runs `make merge-pr` with the reviewed head and base.

  The worktree may be detached at the PR's head.
- **`main-health.sh`** runs on each new `origin/main` commit: tsc, `architecture.spec.ts`, and the 100% gates (`test:core`, `test:harnessd`, `test:local-models`, `test:resume`). It prints one line, `MAIN <sha> OK` or `MAIN <sha> FAIL: <gates>`. It expects a detached worktree named `main-health` beside it, with `cli/node_modules` installed. Unset `TMUX` and `TMUX_PANE` first.
