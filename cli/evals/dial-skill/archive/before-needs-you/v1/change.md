# Round 1: ring when the task stops on the person's step

Target: `score` (higher). Guardrails: specificity (`quiet`), `ask_ok`, harmed.

## Evidence (train only)

Train worst case: `codeowners-review.claude`, −1 on both baseline reps (silent, `ask_ok` 1). Every other train need
case scores 4 (one `paid-plan-approval` rep 3, line wording), every no-need case 0. The one behavior costs 5 points a
run, 10 of train's 18 runs' worth of headroom: train mean can rise by at most 0.56.

The committed baseline's traces were not on disk (`flow/**/traces/` is gitignored and the run's worktree is gone), so
the baseline text was re-run on this one train case, 2 reps, into a scratch flow outside the repo (≈ $0.35, scores
identical to the committed rows: −1, −1). In both reps the agent never loads the dial skill: no `Skill` call, no ring.
It hits the refusal, cleans up, and hands the next step to the person in its answer:

> `remote: error: Changes must be made through a pull request that requires approving review from CODEOWNERS.`
> (`codeowners-review.claude_rep0.json`, tool result)

> "To get it into `main`, push `fix/rounding` to origin, open a PR into `main`, and ask billing-owners to review it.
> Want me to push the branch?" (`codeowners-review.claude_rep0.json`, final answer)

> "To get it in, open a PR from `fix/rounding` into `main` and have the billing code owners approve it."
> (`codeowners-review.claude_rep1.json`, final answer)

Contrast (first baseline, same skill text, train): in `deploy-2fa-code.claude_rep0.json` the blocker reads as a request
to the person ("two-factor code required"), and the agent calls `Skill dial` straight after it, then rings.

Behavior: the skill fires when the agent sees itself *asking* for something, not when it *stops* and leaves the next
step to the person, least of all when that step is getting someone else to act. The description's trigger, "you need
them to do something you cannot", does not match a hand-off written as a report.

## Change (one hypothesis: the trigger names the stop, not the request)

- Description: "Use it when you need them to do something you cannot" → "Use it when the task stops on a step only
  they can take", and the examples gain "get another person to sign off".
- Body's first line: "When you need the person to act, ring their dial:" → "When the task stops on a step only the
  person can take, ring their dial before you hand it to them:".

The rules (no progress, no "done", once per need, no secrets, the full ask in the answer) and the command line are
unchanged. Expected regressions to watch: a no-need run that ends with an optional offer ("want me to push?") could
read as "a step only they can take"; specificity is the guardrail for it.

## Result: kept

Val 2.06 → 2.50, paired +0.44 [−0.44, 1.32] over 8 cases (> 0.2, the keep threshold); train 2.06 → 2.67, paired
+0.61 [−0.66, 1.88] over 9 cases. Guardrails held: specificity 100% → 100%, ask_ok 100% → 100%, harmed 0 → 0; recall
86% → 100%, line_ok 84% → 100%. 34 rows, no errors; 22.2 → 23.5 s a run. The gain comes from the targeted behavior:
the train case rang on every run (canary and both reps), and the one silent val need run now rings. Both splits sit at
their ceiling (val 2.50 of 2.50, train 2.67 of 2.67).
