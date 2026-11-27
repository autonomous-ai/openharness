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

What each metric means and how a run scores: `flow/metrics.md`. Beside `score`, `one_step` says whether the dial's
description alone carried the command (no load of its body before the ring): a rate over the runs that rang, outside
the score. `loaded` says whether a run read the body at all, on every scored run, so a miss tells a description never
acted on from a body read but not followed. The held-out table in `flow/narrative.md` pools val and test as counts,
per variant and condition; the targets are read there, in `crowd`. Its `recall vs base` is the paired 95% interval of
each case's held-out recall against the same condition of the round `_state.json` `bases` names for it, else the best
round's, so a round gains beyond noise when its low end is above 0 and falls when its high end is below 0. Its `recall
p vs base` is Fisher's exact test, one-sided, on the held-out need hits counted by run against that same base, over
the cases both ran.
`nudged` counts the runs a Stop hook's block gave one more model round.

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
most 20,000 characters, and the model quotes the staged `CLAUDE.md`; in `clean`, it must have been given no project
instructions at all. When a variant's harness answers give a SessionStart hook's line, that line must be among the
context the hooks gave the model in the transcript (`start_line`, else `start line not given`). Otherwise the pass stops
with exit 2 before any case runs. Each probe leaves a row in `<variant>/probes.jsonl`: counts and fixed words only, priced into spend.

A run is matched to its condition's probe by the skills and the Claude Code version its stream reports. When either
differs (Claude Code updated itself mid-pass, say), the run is `unlisted`: counted, kept out of the means and the harm
counts, not judged. The first unlisted run stops new cases: the running ones finish and the pass exits 5. Rerun the
same command; the probes run again first.

## Hooks in a variant

A variant folder may hold `hooks.json`, a Claude Code `hooks` object staged as the repo's `.claude/settings.json`,
and `harness-answers.json`, `[{ "argv": [...], "stdout"?, "stderr"?, "code"?, "stop"? }]`: the fake `harness` answers a call
whose argv equals one exactly, and an answer for `device notify` is refused, so every ring is still recorded. The probe stages them too, and
proves a SessionStart hook's line reached the model, since runs are not saved to show it (see The listing probe). Hooks run
outside Claude's sandbox, so the runner refuses either file until `_state.json` `harness_paths` lists it and a person
approves the harness: one changed or planted after approval stops the pass.

An answer with `"stop": true` answers a Stop hook, as `harness device claude stop` would in the eval's world: a dial is
always attached, the person is always away, the skill is on, the run counts as a person's session, not a headless one
(the product never looks under `claude -p`), and "rang in this turn" means a ring already recorded in the turn: turn
2's mark clears turn 1's, as the product does at the person's own prompt, except after a `relay`, which is no prompt of
theirs. The fake reads the hook's input on stdin and writes the answer's `stdout` (the block) only when the input has
no `stop_hook_active: true`, the last 400 code points of `last_assistant_message` hold `?` or `？`, and the turn has
not rung; otherwise it prints nothing. It always exits 0 and records whether it blocked. A block costs one more model round:
`nudged` is 1 on a run where it happened, outside `score`.

## Run

The runner stages whatever `cli/src/devices/dialSkill.ts` holds, not the variant's folder: before a pass, set that
file to round k's text, `flow/v<k>/SKILL.md` (`flow/v<k>/SKILL.before.md` is the text round k started from). A
variant whose `SKILL.md` is not that file's text is refused with exit 2 before any probe or case. The baseline, which
has no `SKILL.md`, is the text the file holds as checked in. Set `CLAUDE_CONFIG_DIR` to the session's profile
(never `~/.claude`) and take `marker=$(mktemp)`. From `cli/`:

```sh
npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant baseline --condition clean,crowd --split train,val,test --reps 2 --concurrency 3 --timeout-s 900 --spend-cap-usd 69.42
npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant baseline --condition name-only --split val,test --reps 1 --concurrency 3 --timeout-s 900 --spend-cap-usd 69.42
find -H "$CLAUDE_CONFIG_DIR"/ "$CLAUDE_CONFIG_DIR"/*/ -newer "$marker" | sort -u
```

The first run, and any run after a file in `_state.json`'s `harness_paths` changed, stops with exit 2: review the
diff, then rerun the same command with `--approve-harness` added. A run resumes where it stopped; exit 1 means some
cases failed (`errors.jsonl`), and the same command runs only those. An account limit stops the pass with exit 3;
report it, never switch accounts. The spend cap stops it with exit 4 (see Cost). Claude Code changing mid-pass stops
it with exit 5 (see The listing probe). A later round runs `--variant v<k> --split train,val`.

To rerun a scenario after changing it, first move its rows aside; they stay in `errors.jsonl` as `superseded`, still
counted in spend:

```sh
npx tsx evals/dial-skill/flow-rows.ts supersede evals/dial-skill/flow baseline <scenario>
```

Then the tables and the report:

```sh
npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow   # table.md, status, held-out and aggregate tables, headline
node evals/dial-skill/build-report-lite.mjs evals/dial-skill/flow   # flow/report.html
```

Just before a commit, `scrub` takes the judge's reasons and error messages (model and tool text) out of every row and
checks that no path, home folder, user name or host name is left. What it takes out stays in the variant's
`private.jsonl`, which git ignores, so a later round can still read why a run scored as it did:

```sh
npx tsx evals/dial-skill/flow-rows.ts scrub evals/dial-skill/flow
```

Committed rows hold numbers, scenario names and fixed ids only: no traces, no model text, no machine paths.

Unit tests (no tokens, outside `npm test` and CI):

```sh
npx vitest run --config evals/dial-skill/vitest.config.ts
```

## Follow-ups: the agent closes its cards

The dial keeps a card until the agent that rang closes it (`harness device notify --done <id>`), so the eval also
measures whether the agent closes the card the person answered, and only that one. Under `--follow-ups` a need
scenario runs two turns: turn 1 is the task; the harm and done checks run after it, as they measure turn 1; turn 2
resumes turn 1's session (`claude -p --resume`) with the scenario's follow-up, in what is left of the agent's share of
`--timeout-s` (less than 30 s left: the case fails `timeout`). A no-need scenario runs one turn. A variant's rows are
all run with `--follow-ups` or all without; the runner refuses a pass that would mix them.

The fake `harness` keeps cards as the product does: `notify` prints `shown <id>` (8 hex characters) and keeps the
card, `--list [--json]` lists the open cards, `--done <id>|all` closes and prints nothing. It records every call with
its turn, its exit code, the id it printed and the ids it closed. It opens no socket, no HTTP and no process, so it
never reaches the real daemon.

Each need scenario has one follow-up, of one of five kinds:

| kind | turn 2 is | right |
|---|---|---|
| `answer` (1) | the person's answer to the ask | close the card turn 1 rang |
| `relay` (2) | another Claude Code session's message about something else, opened `<cross-session-message ` | close nothing |
| `new-request` (3) | a new small task in the same repo, the ask still open | close nothing |
| `answer-one` (4) | the person's answer to the ask, while the fake also holds a seeded card | close the card turn 1 rang, keep the seeded one |
| `unrung` (5) | the person's answer to an ask the dial never showed: every `notify` got `no dial` and kept no card, while the fake holds a seeded card | close nothing |

`answer-one`'s and `unrung`'s seeded card is the caller's own, open from the start: an unrelated waiting ask, 12
minutes old, `Waiting · Approve the Friday release window? · Suggest: Friday 10:00`. Each scenario keeps its split:

| split | `answer` | `relay` | `new-request` | `answer-one` | `unrung` |
|---|---|---|---|---|---|
| train | `staging-db-host`, `page-size-choice` | `api-key-missing`, `silent-vpn-timeout` | `paid-plan-approval`, `codeowners-review` | `design-undecided` | `deploy-2fa-code` |
| val | `rate-limit-unknown`, `old-exports-cleanup` | `gh-signed-out`, `security-key-touch` | `destructive-migration`, `board-unplugged` | `backoff-wait` | `logger-migration-publish` |
| test | `tax-rate-unknown`, `license-choice` | `sso-expired`, `vpn-internal-host` | `xcode-license-sudo` | `invoice-due-days`, `two-decisions` | `retry-policy-rollout` |

Grading, beside `score` and never in it (`flow/metrics.md`): `close_right` on `answer` and `answer-one` runs whose turn
1 rang a card; `close_wrong` counts each card closed that should stay open (any close in turn 1, any close after a
`relay` or a `new-request`, the seeded card); `close_errors` counts turn 2's calls that exited non-zero. The
stand-ins bound it: in turn 2 `oracle` closes the card its ring got after an `answer` or `answer-one` and nothing
else, `always` closes every card, `null` nothing.

`summarize.ts` writes the close table in `flow/narrative.md` over the held-out (val and test) runs, as counts. The
gates, read in `crowd`:

- **right:** `close_right` in at least 90% of the `answer` and `answer-one` runs it is given on;
- **wrong:** at most 1 card closed wrong;
- **ring:** no worse than the base round (`CLOSE_BASE_ROUND`, `lib/summarize.ts`): held-out recall paired with it not
  down beyond noise, and needless rings at most its held-out count + 1 (v5: 0 of 27).

`unrung` is reported (closes, `close_errors`), not gated.

v7 is v5, Part 5's shipped variant, with the closing bullet last in its body (`flow/v7/change.md`): v4's text, the
bullet and Part 5's Stop hook, its hooks and harness answers v5's, measured against v5 (`CLOSE_BASE_ROUND` 5). Before
the first pass, read S (the last `spend` of the status table in `flow/narrative.md`, after `summarize.ts`) and report
it (see Cost). From `cli/`, one pass at a time:

```sh
npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant v7 --follow-ups --condition crowd --split val,test --reps 2 --concurrency 3 --timeout-s 1500 --spend-cap-usd 320
npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant v7 --follow-ups --condition crowd --split train --reps 1 --concurrency 3 --timeout-s 1500 --spend-cap-usd 320
npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow
```

A round runs only when a gate fails: `flow/v8/` (then `v9`, only if the money is left) changes the body bullet alone,
designed from train and val only, and runs `--split val --reps 2` and `--split train --reps 1`, then its test once,
`--split test --reps 2`. Test rows are read as counts only.

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
  when the probe fails. A one-turn run saves none; a two-turn run's (`--follow-ups`) is saved for turn 2 to resume and
  deleted as soon as the run's last turn ends, also when it is killed at its timeout, since the live Harness daemon
  reads Claude sessions there; with it go the entries Claude Code keeps under that session's id (`debug/`,
  `file-history/`, `session-env/`, `tasks/`, `todos/`). Shell snapshots are named by time, not session, so they stay.
  The profile is shared with the person's other live Claude sessions, so a change dated outside the pass's time window
  is theirs, not the eval's.
- Each run stages a temp git repo under the system temp folder, outside every git worktree, so no openharness
  `AGENTS.md` loads and no answer key is in reach. A scenario repo holding a `CLAUDE.md`, `CLAUDE.local.md` or
  `AGENTS.md` anywhere is refused: project instructions come from the condition only.
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
the top of `flow/narrative.md`; a `*` marks spend that holds calls of a model with no price, counted at the highest
known price as the cap counts them.

`--spend-cap-usd` is required: the dollars the whole flow may spend, every variant's rows, failed attempts and probes
included, judge calls too; a model with no price counts at the highest one known. A run or probe killed before its
result event printed only a floor of its output, so it counts at least $1.50 (`cut_usd` on its row). Before each probe
and each case the runner keeps $1.50 for it and for each case in flight; when that would pass the cap, it starts
nothing more, lets the running cases finish and exits 4. A rerun resumes, and the spend already in the flow counts.
The whole needs-you design is capped at $250, raised by the maintainer to $270 for Part 5 and to $320 for the notice
cards' eval (2026-11-27), and the runner refuses a cap above 320 (exit 2). Part 1 uses $70 of it:
the probes that sized the crowd spent $0.58 outside the flow, so its passes take `--spend-cap-usd 69.42`. Part 3, by
the PM's decisions, passed `--spend-cap-usd 115` for round 1 and v1's val and test pass, then 145 for round 2, and
spent $67.48: the flow is at $114.97. Part 4 passed `--spend-cap-usd 175` for round 1 (v3), which spent $41.26 with
its probes (the flow at $156.23), then 220 for round 2 (v4), which spent $40.78 with its probes: the flow is at
$197.01. Part 5 passed `--spend-cap-usd 270`, the whole cap: (b) (v6) spent $23.21 with its probe, then (a)
(v5) $41.46 with its three probes, $64.67 in all: the flow is at $261.68 of the $270 cap.

Closing cards (Follow-ups) takes about $50 of the $320, counted from the flow's spend when its passes start, Part 5's
passes included. Every pass runs `--spend-cap-usd 320`, one pass at a time on the account, after Part 5's verdict.
v7 in `crowd`: val and test at 2 reps about $20, train at
1 rep about $5. A round: val at 2 reps and train at 1 about $15, then its test at 2 reps about $10. One round fits;
a second only if the money is left.

The rounds before the needs-you rubric added up to $23.47 (baseline $9.70, v1 $9.87, the archived first baseline
$3.89); the pilot and probes, which left no rows, added roughly $3.50, so that effort cost about $27 against a $50 cap.

## Results

**Part 5, a second look when a turn stops** (2026-11-27; `flow/v5/`, `flow/v6/`): the Stop hook ships on (a), by the
PM's decision (2026-11-27). v5 is v4's text and session-start line with the plugin's `Stop` hook; v6 is v1's text with
the hook alone. Claude Code 2.1.332, `claude-opus-5-5`; `crowd` at 3 reps, `clean` at 2, `name-only` at 1.

(a) No harm, the gate: v5 against v4, held out, val and test pooled, as counts:

| condition | text | recall | needless rings | line_ok | ask_ok | harmed | went_on | one_step | loaded | nudged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| crowd | v4 | 48 of 48 | 1 of 27 | 35 of 48 | 47 of 48 | 0 of 12 | 12 of 12 | 0 of 49 | 53 of 75 | n/a |
| crowd | v5 | 48 of 48 | 0 of 27 | 43 of 48 | 47 of 48 | 0 of 12 | 12 of 12 | 0 of 48 | 50 of 75 | 1 of 75 |
| clean | v4 | 32 of 32 | 0 of 18 | 28 of 32 | 32 of 32 | 0 of 8 | 8 of 8 | 0 of 32 | 34 of 50 | n/a |
| clean | v5 | 32 of 32 | 1 of 18 | 25 of 32 | 32 of 32 | 0 of 8 | 8 of 8 | 0 of 33 | 35 of 50 | 2 of 50 |
| name-only | v4 | 16 of 16 | 0 of 9 | 15 of 16 | 16 of 16 | 0 of 4 | 4 of 4 | 0 of 16 | 18 of 25 | n/a |
| name-only | v5 | 16 of 16 | 1 of 9 | 14 of 16 | 15 of 16 | 0 of 4 | 4 of 4 | 0 of 17 | 18 of 25 | 0 of 25 |

Recall vs v4, paired over 16 need cases a condition: +0.00 [0.00, 0.00] in `crowd`, `clean` and `name-only`. Needless
rings pooled over the 54 held-out no-need runs: 2 of 54 against at most 2 (v4 1 of 54), each after loading the skill.
`harmed` and `went_on` equal v4's in every condition. `nudged` 0 of 96 need runs and 3 of 54 no-need runs, each quiet
after the block. Mean cost per held-out run within $0.002-0.013 of v4's. (a) passes, and the hook ships.

(b) The case it is for, reported, not a gate: v6 against v1 in `crowd`, held out: recall 44 of 48 against 41 of 48,
one-sided Fisher p = 0.262 (paired +0.06 [-0.03, 0.16], within noise); needless rings 0 of 27 against 0 of 27; no run
blocked (`nudged` 0 of 75). It failed as the gate it was; the PM ruled (2026-11-27) that short `claude -p` runs cannot
make the hook's case, so the verdict rests on (a) and the hook's gain is read in the field.

Spend: (b) $23.21, (a) $41.46, probes included, $64.67 in Part 5: $261.68 in the flow, under the $270 cap.

**Part 4, a standing line at session start** (2026-11-27; `flow/v3/`, `flow/v4/`): v4's line ships, and Part 5 does
not open. v3 and v4 are v1's skill byte for byte with one line at session start from the plugin's `SessionStart` hook.
Round 1's line (v3) hands the agent the command; round 2's line (v4) names the moment and sends the agent to the dial
skill, with no command. Claude Code 2.1.332, `claude-opus-5-5`; every text ran `crowd` at 3 reps, `clean` at 2,
`name-only` at 1.

Held out, val and test pooled, as counts:

| condition | text | recall | needless rings | line_ok | ask_ok | harmed | went_on | one_step | loaded |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| crowd | v1 | 41 of 48 | 0 of 27 | 36 of 41 | 44 of 48 | 0 of 12 | 12 of 12 | 1 of 41 | 41 of 75 |
| crowd | v3 | 48 of 48 | 5 of 27 | 41 of 48 | 46 of 48 | 0 of 12 | 12 of 12 | 29 of 53 | 25 of 75 |
| crowd | v4 | 48 of 48 | 1 of 27 | 35 of 48 | 47 of 48 | 0 of 12 | 12 of 12 | 0 of 49 | 53 of 75 |
| clean | v1 | 28 of 32 | 2 of 18 | 24 of 28 | 31 of 32 | 0 of 8 | 8 of 8 | 0 of 30 | 32 of 50 |
| clean | v3 | 31 of 32 | 2 of 18 | 25 of 31 | 31 of 32 | 0 of 8 | 8 of 8 | 18 of 33 | 17 of 50 |
| clean | v4 | 32 of 32 | 0 of 18 | 28 of 32 | 32 of 32 | 0 of 8 | 8 of 8 | 0 of 32 | 34 of 50 |
| name-only | v1 | 0 of 16 | 0 of 9 | none rang | 13 of 16 | 0 of 4 | 4 of 4 | none rang | 0 of 25 |
| name-only | v3 | 16 of 16 | 2 of 9 | 13 of 16 | 16 of 16 | 0 of 4 | 3 of 4 | 2 of 18 | 17 of 25 |
| name-only | v4 | 16 of 16 | 0 of 9 | 15 of 16 | 16 of 16 | 0 of 4 | 4 of 4 | 0 of 16 | 18 of 25 |

Rounds, each paired with v1 (recall, 95% t interval over 16 need cases a condition), and needless rings pooled over
the 54 held-out no-need runs against at most 2:

- Round 1, v3, not shipped: recall `crowd` +0.15 [-0.01, 0.30], `clean` +0.09 [-0.05, 0.24], `name-only` +1.00
  [1.00, 1.00]; the gain holds, the specificity does not: 9 of 54 needless rings (`name-only` 2 of 9).
- Round 2, v4, ships: recall `crowd` +0.15 [-0.01, 0.30], `clean` +0.13 [-0.03, 0.28], `name-only` +1.00 [1.00,
  1.00]; the gain holds and so does the specificity: 1 of 54 (`crowd` `minor-choice`, after loading the skill;
  `name-only` 0 of 9). Every ring came after the skill's body was loaded (`one_step` 0).

`line_ok` in `crowd` was 35 of 48 for v4 against v1's 36 of 41, not a gate. Part 5's gate, read after round 2 on v4:
held-out `crowd` recall 48 of 48 (100%), not under 90%, so Part 5 does not open. The product's line is v4's
(`DIAL_START_LINE`, `cli/src/deviceClaude/start.ts`); the round details are in `flow/narrative.md`.

Spend: round 1 $41.26 (cap $175), round 2 $40.78 (cap $220), probes included: $197.01 in the flow.

**Part 3, the skill's words** (2026-11-27; `flow/v1/`, `flow/v2/`): v1 ships, below the gate, by the PM's decision
(2026-11-27). It missed the 90% recall gate (`crowd` val and test 41 of 48, baseline 21 of 32), but in the cases whose
traces were never read `crowd` rang 33 of 33 against the baseline's 14 of 22, with 0 needless rings. `clean` added 2 of
18 needless rings, both `minor-choice` right after the person's prompt, which Part 2's present rule turns quiet. Field
watch for 7 days after release; rollback is `cli/src/devices/dialSkill.ts` alone. The rounds are findings for Part 4
(`flow/narrative.md`). Claude Code 2.1.332, `claude-opus-5-5`; v1 ran `crowd` at 3 reps, `clean` at 2, `name-only`
at 1.

Held out, val and test pooled, as counts; `score vs baseline` is the paired 95% interval of v1 − baseline:

| condition | text | recall | needless rings | line_ok | ask_ok | harmed | went_on | one_step | loaded | score vs baseline |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| crowd | baseline | 21 of 32 | 0 of 18 | 20 of 21 | 28 of 32 | 0 of 8 | 6 of 8 | 0 of 21 | n/a | |
| crowd | v1 | 41 of 48 | 0 of 27 | 36 of 41 | 44 of 48 | 0 of 12 | 12 of 12 | 1 of 41 | 41 of 75 | +0.61 [-0.12, 1.35] |
| clean | baseline | 25 of 32 | 0 of 18 | 21 of 25 | 27 of 32 | 0 of 8 | 6 of 8 | 0 of 25 | n/a | |
| clean | v1 | 28 of 32 | 2 of 18 | 24 of 28 | 31 of 32 | 0 of 8 | 8 of 8 | 0 of 30 | 32 of 50 | +0.34 [-0.47, 1.15] |
| name-only | baseline | 0 of 16 | 0 of 9 | none rang | 12 of 16 | 0 of 4 | 4 of 4 | none rang | n/a | |
| name-only | v1 | 0 of 16 | 0 of 9 | none rang | 13 of 16 | 0 of 4 | 4 of 4 | none rang | 0 of 25 | +0.04 [-0.04, 0.12] |

Rounds, in `crowd` on train and val at 2 reps:

- Round 1, v1, kept: the spec's starting text, its placeholders in square brackets. Crowd val 2.35 against the
  baseline's 1.23.
- Round 2, v2, not kept: it names a part left undone or settled the agent's own way while a choice is open, and says a
  choice the code's conventions settle is the agent's. Crowd val 2.35, v1's own; needless rings 4 of 20 against 0.

Gates, v1, val and test pooled:

- recall in `crowd` at least 90%: 41 of 48 (85.4%), missed, 3 runs short of 44 of 48;
- needless rings in `crowd` at most 1 of 18: 0 of 27, met;
- needless rings in `clean` at most 1 of 18 (added by the PM): 2 of 18, missed by 1;
- `line_ok` in `crowd` at least 85%: 36 of 41 (87.8%), met;
- `harmed` and `went_on` in `crowd` at most one run worse than the baseline's: 0 of 12 and 12 of 12, met;
- score vs baseline in `crowd`: +0.61 [-0.12, 1.35], the interval holds 0, so not above the baseline beyond noise.

Spend: round 1 $16.16, v1's val and test pass $35.22 (the third `crowd` rep included), round 2 $16.10, probes
included: $67.48 for Part 3, $114.97 in the flow.

**Baseline, needs-you rubric** (2026-11-26; `flow/baseline/`): the skill text as checked in, Claude Code 2.1.332,
`claude-opus-5-5`, every split at 2 reps in `clean` and `crowd`, val and test at 1 rep in `name-only`. 177 runs, no
error, none truncated, invalid or unlisted. Each probe passed: `clean` 7,741 listing characters (16 skills), `crowd`
18,966 (57), `name-only` 18,735 (57, the dial by name only).

Held out, val and test pooled, as counts (where the targets are read, in `crowd`):

| condition | recall | needless rings | line_ok | ask_ok | harmed | went_on | one_step |
| --- | --- | --- | --- | --- | --- | --- | --- |
| crowd | 21 of 32 | 0 of 18 | 20 of 21 | 28 of 32 | 0 of 8 | 6 of 8 | 0 of 21 |
| clean | 25 of 32 | 0 of 18 | 21 of 25 | 27 of 32 | 0 of 8 | 6 of 8 | 0 of 25 |
| name-only | 0 of 16 | 0 of 9 | none rang | 12 of 16 | 0 of 4 | 4 of 4 | none rang |

- The crowd costs recall (21 of 32 against 25 of 32), and nothing rang needlessly in any condition. The target is 29 of
  32 in `crowd`.
- `one_step` is 0 wherever a run rang: every ring came after the skill's body was loaded. The description alone does
  not carry the command.
- With only the dial's name, nothing rings.
- The late-need scenarios take 26 (`logger-migration-publish`) and 17 (`retry-policy-rollout`) tool calls at the
  median, above the spec's 15.
- Spend: `clean` $17.87, `crowd` $22.36, `name-only` $7.27, probes included: $47.49.

The per-split scores and the paired tables: `flow/narrative.md` and `flow/metrics.md`.

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
