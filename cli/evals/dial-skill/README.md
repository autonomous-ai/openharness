# Dial skill eval

Measures whether Claude Code, given Harness's dial skill (`DIAL_SKILL` in `cli/src/devices/dialSkill.ts`), rings the
dial when, and only when, the person must act, and whether the line and the final answer say what to do. Claude Code
only (Codex is out of scope, spec Decision 2); no other agent is scored.

38 scenarios under `scenarios/`, each a tiny repo with a one-line task: 24 where the person must act (a missing key, a
2FA code, a design choice, a board to plug in, a code owner's review…) and 14 the agent can finish alone. Split train /
val / test 13 / 13 / 12 (need / no-need 8 / 5, 8 / 5, 8 / 4), fixed in `flow/_state.json`. The first 16 scenarios alone
saturated (every split near its ceiling, no spread between reps); that baseline is archived in
`archive/baseline-16-saturated/`, and nine harder scenarios joined every split. Ten more join in five families, each
its `kind`:

| family | count | what it tests |
|---|---|---|
| `ask-first` | 4 | need, `waiting`: the task cannot start without a fact or a choice only the person has. `old-exports-cleanup` has a harm check: two folders match "the old exports", one holds the only copy of customer data. |
| `late-need` | 2 | need: it shows only after long work (15 or more tool calls). |
| `offer-trap` | 2 | no need: the task finishes and the natural ending offers more work. |
| `progress-trap` | 1 | no need: a long task with several steps. |
| `fyi-trap` | 1 | no need: a deprecation warning worth telling in the answer, not a ring. |

What each metric means and how a run scores: `flow/metrics.md`.

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

## Conditions

A case is `<scenario>.<agent>.<condition>`; `--condition` takes `clean`, `crowd` and `name-only`, default `clean`.

- `clean`: the dial skill alone, beside Claude Code's bundled skills.
- `crowd`: what a real session holds. The 41 skills of `crowd/skills/` are staged beside the dial in the repo's
  `.claude/skills/`, and `crowd/instructions.md` (60 lines of ordinary engineering rules) is committed as the repo's
  `CLAUDE.md`. Five of the skills are process skills whose descriptions claim priority as real ones do ("Use when
  starting any conversation", "You MUST use this before…"), so the crowd competes for the model's attention, not only
  for the listing's length. No crowd skill asks, waits, notifies or names the dial or Harness: the crowd measures
  dilution, not a rival channel. The listing the model gets is 18,000 to 20,000 characters (the measured median of
  real sessions is 21,141), half of `claude-opus-5-5`'s 40,000-character listing budget.
- `name-only`: `crowd` with the dial's description dropped, by `skillOverrides: { "dial": "name-only" }` in the run's
  own `--settings`, which the agent never sees. The model sees the name `dial` and nothing else: the worst case, met
  by a session with many skills and a small context. It drops only the dial's own description; a real session over
  its listing budget loses other skills' descriptions too. Not `skillListingBudgetFraction`: it shortens descriptions
  by usage rank from the shared profile, so it cannot choose the dial. Run on val and test, 1 rep.

## The listing probe

Before any case, the runner probes each condition the pass runs: one `claude -p`, staged as the condition's first
case, with the run's own arguments, one turn, and its session saved, because only the saved transcript holds the
skill listing the model got. It reads the dial's line (`full`, `name-only`, `cut` or `absent`), counts the crowd
skills cut, measures the listing, and asks the model for the first line of its `CLAUDE.md`. A probe passes when the
dial's line is the one its condition gives (`absent` under `--no-skill`), no crowd skill is cut, a crowd listing is at
most 20,000 characters, and the model quotes the staged `CLAUDE.md`. Otherwise the pass stops with exit 2 before any
case runs. Each probe leaves a row in `<variant>/probes.jsonl`: counts and fixed words only, priced into spend.

A run is matched to its condition's probe by the skills and the Claude Code version its stream reports. When either
differs (Claude Code updated itself mid-pass, say), the run is `unlisted`: counted, kept out of the means, not judged.

## Hooks in a variant

A variant folder may hold `hooks.json`, a Claude Code `hooks` object staged as the repo's `.claude/settings.json`,
and `harness-answers.json`, `[{ "argv": [...], "stdout"?, "stderr"?, "code"? }]`: the fake `harness` answers a call
whose argv equals one exactly, and an answer for `device notify` is refused, so every ring is still recorded. The probe stages them too. Hooks run
outside Claude's sandbox, so the runner refuses either file until `_state.json` `harness_paths` lists it and a person
approves the harness: one changed or planted after approval stops the pass.

## Run

The runner stages whatever `cli/src/devices/dialSkill.ts` holds, not the variant's folder: before a pass, set that
file to the variant's text (`flow/v<k>/SKILL.before.md` for the text round k started from, `flow/v<k>/SKILL.md` for
round k's). The baseline is the text the file holds as checked in. Set `CLAUDE_CONFIG_DIR` to the session's profile
(never `~/.claude`) and take `marker=$(mktemp)`. From `cli/`:

```sh
npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant baseline --condition clean,crowd --split train,val,test --reps 2 --concurrency 3 --timeout-s 900 --spend-cap-usd 70
npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant baseline --condition name-only --split val,test --reps 1 --concurrency 3 --timeout-s 900 --spend-cap-usd 70
find -H "$CLAUDE_CONFIG_DIR"/ "$CLAUDE_CONFIG_DIR"/*/ -newer "$marker" | sort -u
```

The first run, and any run after a file in `_state.json`'s `harness_paths` changed, stops with exit 2: review the
diff, then rerun the same command with `--approve-harness` added. A run resumes where it stopped; exit 1 means some
cases failed (`errors.jsonl`), and the same command runs only those. An account limit stops the pass with exit 3;
report it, never switch accounts. The spend cap stops it with exit 4 (see Cost). A later round runs
`--variant v<k> --split train,val`.

To rerun a scenario after changing it, first move its rows aside; they stay in `errors.jsonl` as `superseded`, still
counted in spend:

```sh
npx tsx evals/dial-skill/flow-rows.ts supersede evals/dial-skill/flow baseline <scenario>
```

Then the records and the report. `scrub` takes the judge's reasons and error messages (model and tool text) out of
every row and checks that no path, home folder, user name or host name is left; run it before committing rows:

```sh
npx tsx evals/dial-skill/flow-rows.ts scrub evals/dial-skill/flow
npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow   # table.md, status, held-out and aggregate tables, headline
node evals/dial-skill/build-report-lite.mjs evals/dial-skill/flow   # flow/report.html
```

Committed rows hold numbers, scenario names and fixed ids only: no traces, no model text, no machine paths.

Unit tests (no tokens, outside `npm test` and CI):

```sh
npx vitest run --config evals/dial-skill/vitest.config.ts
```

## Isolation

- Claude runs under the `CLAUDE_CONFIG_DIR` already set (the session's profile, never the default `~/.claude`), with
  `--setting-sources project`, so the person's hooks never fire into the live daemon and the person's own skills are
  not loaded: only Claude Code's bundled skills, the dial skill and, in `crowd` and `name-only`, the crowd's skills
  and its `CLAUDE.md`. Every variant runs the same way.
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

  Only the startup files above may appear; a new `projects/` entry is a run that was not cleaned up. A probe's
  session is saved there for the seconds its one turn takes, holding one short answer, and is removed with it, even
  when the probe fails; a run's is never saved, since the live Harness daemon reads Claude sessions there. The profile is
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
- A variant's hooks run outside Claude's sandbox, so they are staged only under the harness sha (see Hooks in a
  variant).
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
2× input (`lib/spend.ts`). A train + val pass at 2 reps is 52 runs a condition; a test pass is 24. The baseline is 152
runs in `clean` and `crowd` plus 25 in `name-only`, about $50. Spend per pass and in total is in the status table at
the top of `flow/narrative.md`.

`--spend-cap-usd` is required: the dollars the whole flow may spend, every variant's rows, failed attempts and probes
included, judge calls too; a model with no price counts at the highest one known. Before each probe and each case the
runner keeps $1.50 for it and for each case in flight; when that would pass the cap, it starts nothing more, lets the
running cases finish and exits 4. A rerun resumes, and the spend already in the flow counts. The whole needs-you
design is capped at $250; Part 1 uses $70 of it. Later parts pass a larger `--spend-cap-usd`, never above 250.

The rounds before the needs-you rubric added up to $23.47 (baseline $9.70, v1 $9.87, the archived first baseline
$3.89); the pilot and probes, which left no rows, added roughly $3.50, so that effort cost about $27 against a $50 cap.

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
`archive/before-needs-you/narrative.md`.
