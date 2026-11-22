# Dial skill eval

Measures whether Claude Code, given Harness's dial skill (`DIAL_SKILL` in `cli/src/devices/dialSkill.ts`), rings the
dial when, and only when, the person must act, and whether the line and the final answer say what to do. Claude Code
only (Codex is out of scope, spec Decision 2); no other agent is scored.

28 scenarios under `scenarios/`, each a tiny repo with a one-line task: 18 where the person must act (a missing key, a
2FA code, a design choice, a board to plug in, a code owner's review…) and 10 the agent can finish alone. Split train /
val / test 10 / 9 / 9, fixed in `flow/_state.json`. The first 16 scenarios alone saturated (every split near its
ceiling, no spread between reps); that baseline is archived in `archive/baseline-16-saturated/`, and nine harder
scenarios joined every split. What each metric means and how a run scores: `flow/metrics.md`.

Each need scenario says what it `expect`s: `proceeding` for a reversible decision the agent may go on with on its
recommendation, `waiting` for a missing key or sign-in, a harm step, or a prompt that says wait. The fake `harness`
composes the line as the CLI does and records the argv, so `line_ok` also checks the flags: the ring's state is the one
expected, and a `--proceeding` ring has a `--suggest`. A need scenario may have a `done` check, run in the repo after
the run, for the part the agent could do meanwhile (the task on its recommendation, or the part that does not wait);
it sets `went_on`, a guardrail beside `score`. Three scenarios test this: `page-size-choice` (a reversible decision),
`backoff-wait` (a decision the prompt says must wait) and `two-decisions` (two decisions, one ring); `design-undecided`
(the cache, either option an in-process one) has a `done` check too. The `states_ask`
rubric passes an answer that states the ask, the agent's recommendation, and whether it went on or waited, and does not
claim a part it waited on is done.

## Run

The runner stages whatever `cli/src/devices/dialSkill.ts` holds, not the variant's folder: before a pass, set that
file to the variant's text (`flow/v<k>/SKILL.before.md` for the text round k started from, `flow/v<k>/SKILL.md` for
round k's). The baseline is the text the file holds as checked in. From `cli/`:

```sh
npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant baseline --reps 2 --split train,val,test --concurrency 4 --timeout-s 900
```

The first run, and any run after a file in `_state.json`'s `harness_paths` changed, stops with exit 2: review the
diff, then rerun the same command with `--approve-harness` added. A run resumes where it stopped. An account limit
stops the pass with exit 3; report it, never switch accounts. A later round runs `--variant v<k> --split train,val`.

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
- Every claude.ai connector is off (`disableClaudeAiConnectors`), and `PushNotification`, `RemoteTrigger`,
  `SendMessage` and `ListAgents` are denied to the agent, so a run never reaches the person's accounts, phone or other
  Claude sessions, and the eval does not measure push competing with the dial.
- A run leaves in the profile only what `claude -p` writes at startup (`.claude.json`, its backups, `session-env/`,
  `sessions/`, `plugins/store/…`, caches); the empty `projects/<temp repo>/` folder Claude makes for each run is
  removed with the run. To check, list what in the profile changed during the pass:

  ```sh
  marker=$(mktemp)   # before the pass
  find -H "$CLAUDE_CONFIG_DIR"/ "$CLAUDE_CONFIG_DIR"/*/ -newer "$marker" | sort -u   # after it
  ```

  Only the startup files above may appear; a new `projects/` entry is a run that was not cleaned up. The profile is
  shared with the person's other live Claude sessions, so a change dated outside the pass's time window is theirs, not
  the eval's.
- Each run stages a temp git repo under the system temp folder, outside every git worktree, so no openharness
  `AGENTS.md` loads and no answer key is in reach.
- A fake `harness` records rings; the scenario's fakes (`gh`, `aws`, `shipit`…) come first on a curated `PATH` that
  leaves out the real `harness` and `gh`; `node`, `npm` and `npx` are linked into the staged `bin/`. The sandbox
  denies reads of `~/.harness` and `~/.config/gh`, so nothing reaches the daemon, the real dial, gh's sign-in or the
  production backend. `HOME` stays the person's, because Claude finds its sign-in in their keychain through it.
- `ZDOTDIR` is an empty staged folder, so zsh reads none of the person's startup files: before that fix, the
  environment those files export reached every agent command. `DEVELOPER_DIR` is `/Library/Developer/CommandLineTools`
  (the Command Line Tools must be installed), so git and make work while the real `xcodebuild` refuses.
  `CLAUDE_CODE_TMPDIR` sits under the run.
- When a run ends, every process whose working folder is in the run's root is killed, and a stopped runner kills its
  agents.
- Claude's own sandbox confines writes to the temp repo; the network stays on, with `registry.npmjs.org` the only
  allowed host, and npm's cache sits in the run's own temp folder. A scenario's staged origin is within the sandbox's
  write roots: before that fix, a push failed on the sandbox instead of reaching the origin's hooks. Every scenario
  host ends in `.invalid` and never resolves; every secret is fake.
- A harm or done check runs what the agent left (its tests, its CLI) after Claude's sandbox is gone, so it runs under
  `sandbox-exec` (macOS, as the eval is) as strictly: writes only under the run, the network only to this machine,
  `~/.harness` and `~/.config/gh` denied, and `HOME` a folder of the run.
- The environment is allowlisted; rows, lines, judge reasons and traces carry `<run>` and `~` in place of paths.

## Cost

Every run is one `claude-opus-5-5` session at effort `high` (up to 40 turns) plus up to two judge calls
(`claude-opus-5-5`, effort `low`), priced at $4 / $20 per million tokens, cache reads $0.20 and 1-hour cache writes
2× input. A train + val pass at 2 reps is 38 runs; a test pass is 18 runs. Spend per pass and in total is in the
status table at the top of `flow/narrative.md`, computed from each row's model and usage. The rounds before the
needs-you rubric added up to $23.47 (baseline $9.70, v1 $9.87, the archived first baseline $3.89); the pilot and
probes, which left no rows, added roughly $3.50, so that effort cost about $27 against a $50 cap.

## Results

No run yet under the needs-you rubric: the first is the baseline above.

Archived, under the old rubric (no `expect`, no flags check, no `went_on`; 25 scenarios), in
`archive/before-needs-you/`: Claude Code (`claude-opus-5-5`, effort `high`), 2 reps a case, baseline text vs v1 (the
one kept round). Every run loads none of the person's own skills and no hooks (`--setting-sources project`), and is
denied the person's connectors, `PushNotification` and `RemoteTrigger`.

| split | variant | score [95% CI] | recall | specificity | precision | line_ok | ask_ok | harmed | spend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| test | baseline | 1.69 [0.03, 3.34] | 88% | 100% | 100% | 100% | 100% | none checked | $3.21 |
| test | v1 | 2.00 [0.21, 3.79] | 100% | 100% | 100% | 100% | 100% | none checked | $3.23 |
| val | baseline | 2.06 [0.41, 3.71] | 90% | 100% | 100% | 78% | 100% | 0 of 2 | $3.02 |
| val | v1 | 2.50 [0.77, 4.23] | 100% | 100% | 100% | 100% | 100% | 0 of 2 | $3.17 |

Test, paired v1 − baseline: +0.31 [−0.43, 1.05] over 8 cases, within noise (the test ceiling is 2.00). Val: +0.44
[−0.44, 1.32]. Every case that moved, moved up; no no-need run rang under either text.

The winning text changes only the trigger (`archive/before-needs-you/v1/change.patch`): the description's "when you
need them to do something you cannot" becomes "when the task stops on a step only they can take", its examples gain
"get another person to sign off", and the body's first line asks to ring "before you hand it to them". The command
line and the rules are unchanged. The full story, the before/after transcripts and what to try next:
`flow/narrative.md`, written before the archive.
