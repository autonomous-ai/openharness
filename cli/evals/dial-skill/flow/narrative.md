# Dial skill hill-climb

<!-- status -->
| round | change | val | train | test | recall | specificity | line_ok | ask_ok | harmed | s/run | tool calls | rings | tokens | $/pass | spend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | baseline | 2.06 [0.41, 3.71] | 2.06 [0.35, 3.76] | 1.69 [0.03, 3.34] | 86% | 100% | 84% | 100% | 0 (0%) | 22.2 | 5.5 | 0.56 | 155660 | $8.64 | $8.64 |
| 1 | Round 1: ring when the task stops on the person's step | 2.50 [0.77, 4.23] | 2.67 [1.13, 4.20] | 2.00 [0.21, 3.79] | 100% | 100% | 100% | 100% | 0 (0%) | 23.5 | 6.0 | 0.65 | 159133 | $8.84 | $17.48 |
<!-- /status -->

Guardrail and perf columns above count train and val rows only (every round runs those); the test split's own are in
"Versus baseline". `$/pass` and `spend` count this flow's rows, the test passes included.

**Headline (Claude Code, held-out test, 8 cases × 2 reps):** baseline 1.69 [0.03, 3.34] → v1 2.00 [0.21, 3.79], paired
+0.31 [−0.43, 1.05]. Within noise: the interval crosses zero. By the plan's rule, the words change is not recommended
for merging on this evidence. The direction agrees on every split and nothing got worse, but the test split could not
show more: its ceiling is 2.00, so baseline left only 0.31 of headroom, under half the paired interval's width.

The loop stopped after round 1 (kept, best = v1): v1 reached the ceiling on train (2.67 of 2.67) and val (2.50 of
2.50), so no further round could show a gain on either.

## Recommended change

`[TUNE]` v1's trigger, in `DIAL_SKILL_DESCRIPTION` and the body's first line (`flow/v1/change.patch`):

- Description: "Use it when you need them to do something you cannot" → "Use it when the task stops on a step only
  they can take", and the examples gain "get another person to sign off".
- Body: "When you need the person to act, ring their dial:" → "When the task stops on a step only the person can take,
  ring their dial before you hand it to them:".

Why: the baseline fired when the agent saw itself asking for something, not when it stopped and wrote the next step
up as a hand-off, least of all when that step is getting another person to act (`flow/v1/change.md`). The command
line, the rules and the format are unchanged. On the test split this is within noise, so it is a judgement call, not
a measured win: take it for the direction and the zero regressions, or leave the words as they are.

## Versus baseline

Computed from the rows in `flow/{baseline,v1}/results.jsonl` with the recipe of `lib/summarize.ts` (95% t interval
over case means; spend at claude-opus-5-5's $4 / $20 per million tokens, cache reads 0.1×, writes 1.25×), per split:

| split | variant | score [95% CI] | recall | specificity | precision | line_ok | ask_ok | harmed | spend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| test | baseline | 1.69 [0.03, 3.34] | 88% | 100% | 100% | 100% | 100% | none checked | $2.84 |
| test | v1 | 2.00 [0.21, 3.79] | 100% | 100% | 100% | 100% | 100% | none checked | $2.87 |
| val | baseline | 2.06 [0.41, 3.71] | 90% | 100% | 100% | 78% | 100% | 0 of 2 | $2.69 |
| val | v1 | 2.50 [0.77, 4.23] | 100% | 100% | 100% | 100% | 100% | 0 of 2 | $2.85 |

Paired v1 − baseline: test +0.31 [−0.43, 1.05] over 8 cases; val +0.44 [−0.44, 1.32] over 8; train +0.61
[−0.66, 1.88] over 9. Every case that moved, moved up: on test, `tax-rate-unknown` 1.5 → 4 (one baseline rep stayed
silent); on val, `gh-signed-out` 1 → 4 and `destructive-migration` 3.5 → 4; on train, `codeowners-review` −1 → 4 and
`paid-plan-approval` 3.5 → 4. No no-need run rang under either text (specificity 100% on every split), and every
answer carried the ask. The test split has no harm-checked scenario.

## Why trust this

- Held-out: the round's analyzer read train traces only; val picked the round; test was run once, at the end, on
  baseline and v1 in the same session, and no test trace was read to make a change.
- Same conditions for both texts: the runner stages the skill from `cli/src/devices/dialSkill.ts`, so the baseline
  test pass ran with that file set to the baseline text (`flow/v1/SKILL.before.md`) and the v1 pass with v1's
  (`flow/v1/SKILL.md`); every test trace's first turn shows the text it ran with. Same harness sha
  (`c3ee0890…`), rubric sha, model (`claude-opus-5-5`, effort `high`), judge (`claude-opus-5-5`, effort `low`) and
  Claude Code 2.1.326.
- Engagement moved with the score: rings per run 0.56 → 0.65 on train and val, and the gained cases are runs that
  were silent or rang a line the judge failed under baseline.
- Isolation: Claude Code only (Codex is out of scope by Ken's choice). The person's own skills are not loaded and
  hooks are off (`--setting-sources project`); the person's connectors (Gmail, Calendar, Docs), `PushNotification`
  and `RemoteTrigger` are denied to the agent, so the eval does not measure push competing with the dial. Claude's
  sandbox confines writes to the run's temp folder, with the network on and `registry.npmjs.org` the only allowed
  host.
- History of the eval: the first 16-scenario baseline saturated (train 2.67 of 2.67, val 2.20 of 2.40, no spread) and
  is archived in `archive/baseline-16-saturated/`; nine harder scenarios joined every split. The second baseline
  found a harness bug: the sandbox refused writes to the staged origin outside the repo, so a push failed with an
  unpacker error instead of reaching the origin's hooks. It was fixed (the staged origin joins the sandbox's write
  roots) and the two affected scenarios (`codeowners-review`, `gh-signed-out`) re-run before round 1.
- Limits: 8 cases × 2 reps per split, and most cases score at their ceiling under both texts, so the interval is wide.
  One model only; the words were not checked on Codex.

## What else was tried

Nothing else: the stopping condition held after round 1. No round was reverted and no categorization round was needed.

Failure taxonomy over this flow's 100 runs (50 baseline, 50 v1): account limits 0, timeouts 0, other errors 0,
truncated 0, invalid 0, harmed 0. Model misses, all under the baseline text: 4 need runs that never rang
(`codeowners-review` ×2 train, `gh-signed-out` val, `tax-rate-unknown` test) and 3 rings whose line the judge failed
as not the same single need (`destructive-migration` and `gh-signed-out` val, `paid-plan-approval` train). v1: none.

## Before and after (train cases)

Traces are not committed (`flow/**/traces/` is gitignored). The committed second baseline's traces were gone by round
1, so the baseline side of each pair is a run of the same baseline text: `codeowners-review` from round 1's trace
probe (scores identical to the committed rows), `env-from-example` from the archived first baseline.

1. `codeowners-review.claude_rep0` (need: a push to protected `main` needs a CODEOWNERS approval). Both runs merge the
   fix locally, push, and hit `remote: error: Changes must be made through a pull request that requires approving
   review from CODEOWNERS.` Baseline: resets `main`, never loads the skill, and ends "I didn't push the fix to `main`,
   because the remote rejected it… that pull request needs approval from `@acme-shop/billing-owners`": the ask is in
   the answer, no ring (score −1). v1: after the same reset it calls `Skill dial`, then
   `harness device notify "Rounding fix can't reach main: needs a billing code owner to approve a PR"` (`shown`), and
   its answer carries the same ask (score 4).
2. `env-from-example.claude_rep0` (no-need: `npm run dev:check` fails until `.env` is copied from `.env.example`). The
   guardrail for v1's wider trigger. Both runs read the README, copy `.env.example` to `.env`, see `dev:check: config
   ok` and report it; neither loads the skill or rings (score 0 both). v1's answer, like the baseline's, points at the
   local database for later without making it a step only the person can take.

## What to try next

- A harder held-out set: most test cases sit at their ceiling under both texts. More cases where the stop is a hand-off
  to another person (review, sign-off, a decision owned elsewhere), and more reps, would narrow the interval enough to
  call a gain of this size.
- Run baseline and v1 on Codex once Codex is back in scope: the skill file is shared, and a win on one model does not
  transfer by default.
- With push denied here, measure the dial against `PushNotification` in a separate eval if both stay on for the
  person.
