# Dial skill eval

Measures whether Claude Code, given Harness's dial skill (`DIAL_SKILL` in `cli/src/devices/dialSkill.ts`), rings the
dial when, and only when, the person must act, and whether the line and the final answer say what to do. Claude Code
only; no other agent is scored.

16 scenarios under `scenarios/`, each a tiny repo with a one-line task: 10 where the person must act (a missing key, a
2FA code, a design choice, a board to plug in…) and 6 the agent can finish alone. Split train / val / test 6 / 5 / 5,
fixed in `flow/_state.json`. What each metric means and how a run scores: `flow/metrics.md`.

## Run

From `cli/`:

```sh
npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant <baseline|vN> --reps 2 \
  --split train,val --concurrency 4 --timeout-s 900
```

The first run, and any run after a file in `_state.json`'s `harness_paths` changed, stops with exit 2: review the
diff, then run once with `--approve-harness`. A run resumes where it stopped. An account limit stops the pass with
exit 3; report it, never switch accounts.

Then the records and the report:

```sh
npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow   # table.md, status and aggregate tables, headline
node evals/dial-skill/build-report-lite.mjs evals/dial-skill/flow   # flow/report.html
```

Unit tests (no tokens, outside `npm test` and CI):

```sh
npx vitest run --config evals/dial-skill/vitest.config.ts
```

## Isolation

- Claude runs under the `CLAUDE_CONFIG_DIR` already set (the session's profile, never the default `~/.claude`), with
  `--setting-sources project`, so the person's hooks never fire into the live daemon.
- Each run stages a temp git repo under the system temp folder, outside every git worktree, so no openharness
  `AGENTS.md` loads and no answer key is in reach.
- A fake `harness` records rings; the scenario's fakes (`gh`, `aws`, `shipit`…) come first on a curated `PATH` that
  leaves out the real `harness` and `gh`. Nothing reads or writes `~/.harness`, the daemon, the real dial or the
  production backend.
- Claude's own sandbox confines writes to the temp repo; the network stays on, with `registry.npmjs.org` the only
  allowed host. Every scenario host ends in `.invalid` and never resolves; every secret is fake.
- The environment is allowlisted; rows, lines, judge reasons and traces carry `<run>` and `~` in place of paths.

## Cost

Every run is one `claude-opus-5-5` session at effort `high` (up to 40 turns) plus up to two judge calls
(`claude-opus-5-5`, effort `low`). A train + val pass at 2 reps is 22 runs. Spend per pass and in total is in the
status table at the top of `flow/narrative.md`, computed from each row's model and usage.

## Results

Filled in after the held-out test run.
