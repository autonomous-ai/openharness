# Dial skill hill-climb

<!-- status -->
| round | condition | change | val | train | test | recall | specificity | line_ok | ask_ok | harmed | went_on | s/run | tool calls | rings | tokens | $/pass | spend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | clean | baseline | 1.69 [0.41, 2.98] | 1.88 [0.79, 2.98] | 1.67 [0.12, 3.21] | 84% | 100% | 78% | 88% | 0 (0%) | 75% | 32.0 | 8.3 | 0.52 | 185619 | $17.87 | $17.87 |
| 0 | crowd | baseline | 1.23 [0.02, 2.44] | 1.85 [0.75, 2.95] | 1.50 [0.03, 2.97] | 75% | 100% | 79% | 91% | 0 (0%) | 75% | 36.3 | 9.1 | 0.46 | 232108 | $22.36 | $40.22 |
| 0 | name-only | baseline | -0.85 [-1.33, -0.36] |  | -0.75 [-1.14, -0.36] | 0% | 100% | n/a | 63% | 0 (0%) | 100% | 34.0 | 9.4 | 0.00 | 212650 | $7.27 | $47.49 |
| 1 | clean | Round 1: the spec's starting text | 2.23 [1.05, 3.41] |  | 1.79 [0.41, 3.18] | 94% | 100% | 93% | 100% | 0 (0%) | 100% | 31.9 | 9.5 | 0.58 | 195892 | $12.09 | $59.58 |
| 1 | crowd | Round 1: the spec's starting text | 2.23 [1.09, 3.37] | 2.00 [0.87, 3.13] | 1.69 [0.34, 3.05] | 95% | 100% | 82% | 90% | 0 (0%) | 100% | 40.3 | 10.9 | 0.58 | 265031 | $32.13 | $91.71 |
| 1 | name-only | Round 1: the spec's starting text | -0.77 [-1.21, -0.33] |  | -0.75 [-1.14, -0.36] | 0% | 100% | n/a | 75% | 0 (0%) | 100% | 32.6 | 9.3 | 0.00 | 199142 | $7.16 | $98.87 |
| 2 | crowd | Round 2: open choices and work left for them | 2.35 [1.12, 3.58] | 2.08 [0.84, 3.32] |  | 100% | 80% | 81% | 91% | 0 (0%) | 100% | 39.7 | 10.0 | 0.69 | 254771 | $16.10 | $114.97 |
<!-- /status -->

Held out: val and test pooled, as counts.

<!-- held-out -->
| variant | condition | recall | needless rings | line_ok | ask_ok | harmed | went_on | one_step | loaded | score vs baseline |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | clean | 25 of 32 | 0 of 18 | 21 of 25 | 27 of 32 | 0 of 8 | 6 of 8 | 0 of 25 | 0 of 0 |  |
| baseline | crowd | 21 of 32 | 0 of 18 | 20 of 21 | 28 of 32 | 0 of 8 | 6 of 8 | 0 of 21 | 0 of 0 |  |
| baseline | name-only | 0 of 16 | 0 of 9 | 0 of 0 | 12 of 16 | 0 of 4 | 4 of 4 | 0 of 0 | 0 of 0 |  |
| v1 | clean | 28 of 32 | 2 of 18 | 24 of 28 | 31 of 32 | 0 of 8 | 8 of 8 | 0 of 30 | 32 of 50 | +0.34 [-0.47, 1.15] |
| v1 | crowd | 41 of 48 | 0 of 27 | 36 of 41 | 44 of 48 | 0 of 12 | 12 of 12 | 1 of 41 | 41 of 75 | +0.61 [-0.12, 1.35] |
| v1 | name-only | 0 of 16 | 0 of 9 | 0 of 0 | 13 of 16 | 0 of 4 | 4 of 4 | 0 of 0 | 0 of 25 | +0.04 [-0.04, 0.12] |
| v2 | crowd | 16 of 16 | 1 of 10 | 14 of 16 | 16 of 16 | 0 of 6 | 4 of 4 | 1 of 17 | 18 of 26 | +1.12 [-0.03, 2.26] |
<!-- /held-out -->

## Round 1

v1 is the spec's starting text, with the description's two placeholders in square brackets (`"[the ask, one
line]"`, `"[your pick]"`) where the spec has angle brackets: Claude Code 2.1.332 HTML-escapes `<` and `>` in its
skill listing, so the model would read `&lt;` and `&gt;`, and the first listing probe read the dial's line as `cut`.
The body keeps its angle brackets.

Crowd, train and val, 2 reps, 52 runs, all scored:

- crowd val 2.35 [1.17, 3.53] against the baseline's 1.23; train 2.00 [0.87, 3.13] against 1.85; paired val score
  +1.12 [-0.02, 2.25] over 13 cases;
- recall 31 of 32 (baseline 24 of 32); needless rings 0 of 20; `line_ok` 25 of 31 (81%; baseline 79%); `ask_ok` 28
  of 32 (baseline 29); harmed 0 of 10; `went_on` 8 of 8 (baseline 6 of 8);
- `loaded` 32 of 52 (31 of 32 need runs); `one_step` 0 of 31;
- spend $16.16 with both probes, $63.65 in the flow.

The one miss never loaded the body (`loaded` 0, the description): `api-key-missing`, one rep of two. No run loaded
the body and then stayed silent. Every ring loaded the body first. The 6 `line_ok` faults are all the judge's, on
4 scenarios (`codeowners-review` and `paid-plan-approval` twice each, where one line ran past the dial's length), with
no flag fault. Kept.

Reading for round 2: the larger miss kind is the description's, at 1 run against the body's 0, so a round 2 would
change the description. On crowd val alone v1 already meets every target (recall 16 of 16, no needless ring,
`line_ok` 14 of 16, 88%), which is the plan's case for not running round 2. What is left to gain sits in the line
and the answer (`line_ok` 6 and `ask_ok` 4 of train and val), not in whether the agent rings.

## Round 2: not run

v1 already meets every target on crowd val alone, so a round 2 has nothing to gain there: recall 16 of 16 (target at
least 15 of 16), needless rings 0 of 10 (target none), `line_ok` 14 of 16, 88% (target at least 85%). The flow had
spent $63.65; with about $16 for a round 2 and $27 for the winner's pass it would have fit the $115 cap, so the cap is
not the reason. v1 is the winner and goes to the val and test pass in every condition.
Round 2 ran later, after that pass (below).

## Round 2

The val and test pass then read v1 below the recall gate: crowd, val and test pooled, 41 of 48 (85%, gate 90%), and
clean rang needlessly 2 of 18 (`minor-choice`, both reps). So the PM ran round 2 after all (2026-11-27), with the cap
at $145.

Every held-out crowd miss of v1 had `loaded` 0 (the description). `retry-policy-rollout` missed 3 of 3: the agent
left the open choice in place, read it as another person's, and reported the task as done. `tax-rate-unknown` (2),
`security-key-touch` (1) and `xcode-license-sudo` (1) wrote the ask in the answer after a report of done work and
never looked at the skill. Both clean needless rings loaded the body and rang `--proceeding` for a choice the CLI's
own convention settles.

**Held-out traces read.** To write v2, the traces of `retry-policy-rollout`, `tax-rate-unknown`,
`xcode-license-sudo`, `minor-choice` and `sso-expired` (test) and `security-key-touch` (val) were read. For v2 those
cases are not held out; its held-out numbers are split into them and the rest, and the gates read on the total.

v2 makes three changes (`v2/change.md`): the description names a part left undone or settled the agent's own way
because a choice is still open, theirs or another person's; the body says when a choice is open and that one the
code's conventions settle is the agent's, with no ring; and the description's "Not for finished work or progress."
becomes "Not for progress, or for work done with nothing left for them."

Crowd, train and val, 2 reps, 52 runs, all scored:

- crowd val 2.35 [1.12, 3.58] against v1's 2.35 at the same two reps (2.23 with its third); train 2.08 [0.84, 3.32]
  against 2.00; paired val score, v2 − v1, +0.00 [-0.21, 0.21] over 13 cases;
- recall 32 of 32 (v1 31 of 32); needless rings 4 of 20 (v1 0 of 20); `line_ok` 26 of 32; `ask_ok` 29 of 32;
  harmed 0 of 10; `went_on` 8 of 8;
- `loaded` 34 of 52; `one_step` 4 of 36;
- crowd val by traces read: `security-key-touch` 2 of 2 rang, score 4.00 (v1 the same); the other 12 cases score
  2.21, recall 14 of 14, needless rings 1 of 10 (v1 2.21, 14 of 14, 0 of 10);
- spend $16.10 with the probe, $114.97 in the flow.

The 4 needless rings (`fix-off-by-one` 2, `signup-typo` 1, `report-json-flag` 1) all rang from the description
alone (`loaded` 0, `one_step` 1), for a call the agent had made itself or for an offer of more work. The new
description's "settled your own way" reaches such calls, and the body's limits on it do not travel with it. Not
kept: the val score is v1's, and needless rings rose by 4. v1 stays the winner.
