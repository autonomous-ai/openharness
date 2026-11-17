# Dial skill eval

Measures whether Claude Code, given Harness's dial skill (`DIAL_SKILL` in `cli/src/devices/dialSkill.ts`), rings the
dial when, and only when, the person must act, and whether the line and the final answer say what to do. Claude Code
only (Codex is out of scope by Ken's choice); no other agent is scored.

25 scenarios under `scenarios/`, each a tiny repo with a one-line task: 15 where the person must act (a missing key, a
2FA code, a design choice, a board to plug in, a code owner's review…) and 10 the agent can finish alone. Split train /
val / test 9 / 8 / 8, fixed in `flow/_state.json`. The first 16 scenarios alone saturated (every split near its
ceiling, no spread between reps); that baseline is archived in `archive/baseline-16-saturated/`, and nine harder
scenarios joined every split. What each metric means and how a run scores: `flow/metrics.md`.

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
  `--setting-sources project`, so the person's hooks never fire into the live daemon and the person's own skills are
  not loaded: only Claude Code's bundled skills and the dial skill. Every variant runs the same way.
- The profile's claude.ai connectors (Gmail, Calendar, Docs), `PushNotification` and `RemoteTrigger` are denied to
  the agent, so a run never reaches the person's accounts or phone, and the eval does not measure push competing with
  the dial.
- A run leaves in the profile only what `claude -p` writes at startup (`.claude.json`, its backups, `session-env/`,
  caches); the empty `projects/<temp repo>/` folder Claude makes for each run is removed with the run.
- Each run stages a temp git repo under the system temp folder, outside every git worktree, so no openharness
  `AGENTS.md` loads and no answer key is in reach.
- A fake `harness` records rings; the scenario's fakes (`gh`, `aws`, `shipit`…) come first on a curated `PATH` that
  leaves out the real `harness` and `gh`. Nothing reads or writes `~/.harness`, the daemon, the real dial or the
  production backend.
- Claude's own sandbox confines writes to the temp repo; the network stays on, with `registry.npmjs.org` the only
  allowed host, and npm's cache sits in the run's own temp folder. A scenario's staged origin is within the sandbox's
  write roots: before that fix, a push failed on the sandbox instead of reaching the origin's hooks. Every scenario
  host ends in `.invalid` and never resolves; every secret is fake.
- The environment is allowlisted; rows, lines, judge reasons and traces carry `<run>` and `~` in place of paths.

## Cost

Every run is one `claude-opus-5-5` session at effort `high` (up to 40 turns) plus up to two judge calls
(`claude-opus-5-5`, effort `low`). A train + val pass at 2 reps is 34 runs, about $6; a test pass is 16 runs, about $3. Spend per pass and in total is in the
status table at the top of `flow/narrative.md`, computed from each row's model and usage.

## Results

Claude Code (`claude-opus-5-5`, effort `high`), 2 reps a case, baseline text vs v1 (the one kept round). Every run,
baseline and v1 alike, loads none of the person's own skills and no hooks (`--setting-sources project`), and is denied
the person's connectors, `PushNotification` and `RemoteTrigger`.

| split | variant | score [95% CI] | recall | specificity | precision | line_ok | ask_ok | harmed | spend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| test | baseline | 1.69 [0.03, 3.34] | 88% | 100% | 100% | 100% | 100% | none checked | $2.84 |
| test | v1 | 2.00 [0.21, 3.79] | 100% | 100% | 100% | 100% | 100% | none checked | $2.87 |
| val | baseline | 2.06 [0.41, 3.71] | 90% | 100% | 100% | 78% | 100% | 0 of 2 | $2.69 |
| val | v1 | 2.50 [0.77, 4.23] | 100% | 100% | 100% | 100% | 100% | 0 of 2 | $2.85 |

Test, paired v1 − baseline: +0.31 [−0.43, 1.05] over 8 cases, within noise (the test ceiling is 2.00). Val: +0.44
[−0.44, 1.32]. Every case that moved, moved up; no no-need run rang under either text.

The winning text changes only the trigger (`flow/v1/change.patch`): the description's "when you need them to do
something you cannot" becomes "when the task stops on a step only they can take", its examples gain "get another
person to sign off", and the body's first line asks to ring "before you hand it to them". The command line and the
rules are unchanged. The full story, the before/after transcripts and what to try next: `flow/narrative.md`.
