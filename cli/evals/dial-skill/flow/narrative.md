# Dial skill hill-climb

Part 5's result: the Stop hook ships on (a), by the PM's decision (2026-11-27). v5 (v4 and the hook) against v4,
held out: recall 48 of 48, 32 of 32 and 16 of 16 in `crowd`, `clean` and `name-only`, as v4's, paired +0.00
[0.00, 0.00] in each; 2 needless rings of 54 no-need runs against at most 2 (v4 1 of 54); `harmed` and `went_on` as
v4's. (b), v6 against v1 in `crowd`, is reported, not a gate: 44 of 48 against 41 of 48, Fisher p = 0.262, `nudged` 0
of 75. Part 4's line (v4) and Part 3's skill (v1) stay under it (below).
v5, the best variant, against the baseline on test:

- crowd: v5 test 1.50 -> 2.56, paired +1.06 [-0.19, 2.30] over 12 cases, within noise
- clean: v5 test 1.67 -> 2.50, paired +0.83 [-0.49, 2.16] over 12 cases, within noise
- name-only: v5 test -0.75 -> 2.58, paired +3.33 [1.77, 4.90] over 12 cases, clears noise

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
| 3 | clean | Part 4: v1 and a standing line at session start | 2.35 [1.17, 3.53] |  | 2.21 [0.89, 3.52] | 100% | 100% | 81% | 100% | 0 (0%) | 100% | 32.5 | 8.5 | 0.62 | 187397 | $11.63 | $126.60 |
| 3 | crowd | Part 4: v1 and a standing line at session start | 2.33 [1.06, 3.60] |  | 2.42 [1.16, 3.67] | 100% | 80% | 92% | 100% | 0 (0%) | 100% | 38.4 | 10.1 | 0.69 | 240768 | $22.21 | $148.81 |
| 3 | name-only | Part 4: v1 and a standing line at session start | 2.31 [1.14, 3.47] |  | 2.42 [1.02, 3.81] | 100% | 100% | 75% | 100% | 0 (0%) | 50% | 38.5 | 10.1 | 0.62 | 239233 | $7.42 | $156.23 |
| 4 | clean | Part 4, round 2: v1 and a line that sends the agent to the skill | 2.38 [1.19, 3.58] |  | 2.58 [1.36, 3.81] | 100% | 100% | 88% | 100% | 0 (0%) | 100% | 43.6 | 7.8 | 0.62 | 188318 | $11.36 | $167.59 |
| 4 | crowd | Part 4, round 2: v1 and a line that sends the agent to the skill | 2.23 [1.11, 3.35] |  | 2.50 [1.27, 3.73] | 100% | 100% | 67% | 96% | 0 (0%) | 100% | 47.3 | 9.7 | 0.62 | 237486 | $22.13 | $189.72 |
| 4 | name-only | Part 4, round 2: v1 and a line that sends the agent to the skill | 2.46 [1.24, 3.69] |  | 2.58 [1.36, 3.81] | 100% | 100% | 100% | 100% | 0 (0%) | 100% | 47.8 | 8.8 | 0.62 | 245968 | $7.29 | $197.01 |
| 5 | clean | Part 5 (a): v4 and a second look when a turn stops | 2.31 [1.15, 3.47] |  | 2.50 [1.25, 3.75] | 100% | 100% | 75% | 100% | 0 (0%) | 100% | 31.1 | 8.7 | 0.62 | 189746 | $11.63 | $208.64 |
| 5 | crowd | Part 5 (a): v4 and a second look when a turn stops | 2.41 [1.21, 3.61] |  | 2.56 [1.33, 3.78] | 100% | 100% | 92% | 100% | 0 (0%) | 100% | 34.4 | 9.2 | 0.62 | 241002 | $22.22 | $230.86 |
| 5 | name-only | Part 5 (a): v4 and a second look when a turn stops | 2.23 [0.97, 3.49] |  | 2.58 [1.36, 3.81] | 100% | 80% | 88% | 88% | 0 (0%) | 100% | 36.6 | 10.7 | 0.69 | 249671 | $7.61 | $238.47 |
| 6 | crowd | Part 5 (b): v1 and a second look when a turn stops | 2.33 [1.17, 3.50] |  | 1.97 [0.77, 3.18] | 100% | 100% | 83% | 96% | 0 (0%) | 100% | 38.5 | 10.2 | 0.62 | 265109 | $23.21 | $261.68 |
| 7 | crowd | Closing cards, round 1: the spec's starting bullet | 2.38 [1.19, 3.58] | 2.23 [1.07, 3.39] | 2.50 [1.24, 3.76] | 100% | 100% | 88% | 92% | 0 (0%) | 100% | 52.7 | 11.4 | 0.62 | 302631 | $20.77 | $282.45 |
<!-- /status -->

Held out: val and test pooled, as counts.

<!-- held-out -->
| variant | condition | recall | needless rings | line_ok | ask_ok | harmed | went_on | one_step | loaded | nudged | score vs baseline | recall vs base | recall p vs base |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | clean | 25 of 32 | 0 of 18 | 21 of 25 | 27 of 32 | 0 of 8 | 6 of 8 | 0 of 25 | 0 of 0 | 0 of 0 |  | -0.22 [-0.44, -0.00] | 1.000 |
| baseline | crowd | 21 of 32 | 0 of 18 | 20 of 21 | 28 of 32 | 0 of 8 | 6 of 8 | 0 of 21 | 0 of 0 | 0 of 0 |  | -0.34 [-0.58, -0.11] | 1.000 |
| baseline | name-only | 0 of 16 | 0 of 9 | 0 of 0 | 12 of 16 | 0 of 4 | 4 of 4 | 0 of 0 | 0 of 0 | 0 of 0 |  | -1.00 [-1.00, -1.00] | 1.000 |
| v1 | clean | 28 of 32 | 2 of 18 | 24 of 28 | 31 of 32 | 0 of 8 | 8 of 8 | 0 of 30 | 32 of 50 | 0 of 0 | +0.34 [-0.47, 1.15] | -0.13 [-0.28, 0.03] | 1.000 |
| v1 | crowd | 41 of 48 | 0 of 27 | 36 of 41 | 44 of 48 | 0 of 12 | 12 of 12 | 1 of 41 | 41 of 75 | 0 of 0 | +0.61 [-0.12, 1.35] | -0.15 [-0.30, 0.01] | 1.000 |
| v1 | name-only | 0 of 16 | 0 of 9 | 0 of 0 | 13 of 16 | 0 of 4 | 4 of 4 | 0 of 0 | 0 of 25 | 0 of 0 | +0.04 [-0.04, 0.12] | -1.00 [-1.00, -1.00] | 1.000 |
| v2 | crowd | 16 of 16 | 1 of 10 | 14 of 16 | 16 of 16 | 0 of 6 | 4 of 4 | 1 of 17 | 18 of 26 | 0 of 0 | +1.12 [-0.03, 2.26] | +0.00 [0.00, 0.00] | 1.000 |
| v3 | clean | 31 of 32 | 2 of 18 | 25 of 31 | 31 of 32 | 0 of 8 | 8 of 8 | 18 of 33 | 17 of 50 | 0 of 0 | +0.60 [-0.07, 1.27] | -0.03 [-0.10, 0.04] | 1.000 |
| v3 | crowd | 48 of 48 | 5 of 27 | 41 of 48 | 46 of 48 | 0 of 12 | 12 of 12 | 29 of 53 | 25 of 75 | 0 of 0 | +1.01 [0.21, 1.82] | +0.00 [0.00, 0.00] | 1.000 |
| v3 | name-only | 16 of 16 | 2 of 9 | 13 of 16 | 16 of 16 | 0 of 4 | 3 of 4 | 2 of 18 | 17 of 25 | 0 of 0 | +3.16 [2.07, 4.25] | +0.00 [0.00, 0.00] | 1.000 |
| v4 | clean | 32 of 32 | 0 of 18 | 28 of 32 | 32 of 32 | 0 of 8 | 8 of 8 | 0 of 32 | 34 of 50 | 0 of 0 | +0.80 [0.03, 1.57] | +0.00 [0.00, 0.00] | 1.000 |
| v4 | crowd | 48 of 48 | 1 of 27 | 35 of 48 | 47 of 48 | 0 of 12 | 12 of 12 | 0 of 49 | 53 of 75 | 0 of 0 | +1.00 [0.22, 1.78] | +0.00 [0.00, 0.00] | 1.000 |
| v4 | name-only | 16 of 16 | 0 of 9 | 15 of 16 | 16 of 16 | 0 of 4 | 4 of 4 | 0 of 16 | 18 of 25 | 0 of 0 | +3.32 [2.26, 4.38] | +0.00 [0.00, 0.00] | 1.000 |
| v5 | clean | 32 of 32 | 1 of 18 | 25 of 32 | 32 of 32 | 0 of 8 | 8 of 8 | 0 of 33 | 35 of 50 | 2 of 50 | +0.72 [-0.06, 1.50] | +0.00 [0.00, 0.00] | 1.000 |
| v5 | crowd | 48 of 48 | 0 of 27 | 43 of 48 | 47 of 48 | 0 of 12 | 12 of 12 | 0 of 48 | 50 of 75 | 1 of 75 | +1.12 [0.32, 1.92] | +0.00 [0.00, 0.00] | 1.000 |
| v5 | name-only | 16 of 16 | 1 of 9 | 14 of 16 | 15 of 16 | 0 of 4 | 4 of 4 | 0 of 17 | 18 of 25 | 0 of 25 | +3.20 [2.13, 4.27] | +0.00 [0.00, 0.00] | 1.000 |
| v6 | crowd | 44 of 48 | 0 of 27 | 37 of 44 | 45 of 48 | 0 of 12 | 12 of 12 | 1 of 44 | 45 of 75 | 0 of 75 | +0.80 [0.15, 1.45] | +0.06 [-0.03, 0.16] | 0.262 |
| v7 | crowd | 32 of 32 | 1 of 18 | 29 of 32 | 30 of 32 | 0 of 8 | 8 of 8 | 0 of 33 | 35 of 50 | 0 of 50 | +1.08 [0.29, 1.87] | +0.00 [0.00, 0.00] | 1.000 |
<!-- /held-out -->

Closes: held-out follow-up runs, as counts, with the close gates in crowd (metrics.md).

<!-- close -->
| variant | condition | right | wrong | errors | rang no card | turn 2 cut | by kind | right ≥ 90% | wrong ≤ 1 | ring |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v7 | crowd | 14 of 14 | 0 | 0 | 0 | 0 | answer 8 runs, 8 right, 0 wrong; answer-one 6 runs, 6 right, 0 wrong; relay 8 runs, 0 wrong; new-request 6 runs, 0 wrong; unrung 4 runs, 0 wrong | pass | pass | pass |
<!-- /close -->

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

## Round 2: skipped at first

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

## Findings for Part 4

Today's text stays, by the PM's decision (2026-11-27): v1, the best variant, missed two gates, and round 2 was not
kept. The pull request carries the eval's changes and these numbers. v1's text, verbatim, is `flow/v1/SKILL.md`; its
description line:

```
description: "Before you end a turn that leaves the person something to decide, answer or do, ring their Harness dial: harness device notify \"[the ask, one line]\" --suggest \"[your pick]\" --waiting (or --proceeding when you go on with your pick). Not for finished work or progress."
```

Gates missed, v1, val and test pooled:

- recall in `crowd`: 41 of 48 (85.4%, 3 reps) against at least 90%, 3 runs short of 44 of 48;
- needless rings in `clean` (the gate the PM added): 2 of 18 against at most 1 of 18, 1 over (`minor-choice`, both
  reps);
- score vs baseline in `crowd`: +0.61 [-0.12, 1.35]; the interval holds 0, so v1 is not above the baseline beyond
  noise.

Met: needless rings in `crowd` 0 of 27, `line_ok` 36 of 41 (87.8%), harmed 0 of 12, `went_on` 12 of 12.

Miss kinds:

- Every held-out need miss of v1 had `loaded` 0, the description: in `crowd` 7 (`retry-policy-rollout` 3,
  `tax-rate-unknown` 2, `security-key-touch` 1, `xcode-license-sudo` 1), in `clean` 4 (`sso-expired` 2,
  `gh-signed-out` 1, `retry-policy-rollout` 1). Train's one miss too (`api-key-missing`). No run loaded the body and
  then stayed silent.
- v1's 2 needless rings in `clean` (`minor-choice`) had `loaded` 1: the body's line on a decision mid-turn.
- v2's 4 needless rings in `crowd` (`fix-off-by-one` 2, `signup-typo` 1, `report-json-flag` 1) came from the
  description alone: `loaded` 0, `one_step` 1. Its recall rose to 32 of 32 on train and val, and its val score stayed
  v1's.
- Claude Code 2.1.332 HTML-escapes `<` and `>` in its skill listing, so a description must hold none: the spec's
  angle-bracket placeholders made the first listing probe read the dial's line as `cut`.

**Held-out numbers not clean.** The traces of six cases were read to write v2: `security-key-touch` (val),
`tax-rate-unknown`, `xcode-license-sudo`, `retry-policy-rollout`, `minor-choice` and `sso-expired` (test). They were
read because v1 missed or rang needlessly there, so any later text's held-out numbers for those six are not clean.
v1 against the baseline, val and test pooled, split into those six and the rest:

| condition | cases | text | recall | needless rings | line_ok | harmed | went_on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| crowd | the six read | baseline | 7 of 10 | 0 of 2 | 6 of 7 | 0 of 2 | 2 of 2 |
| crowd | the six read | v1 | 8 of 15 | 0 of 3 | 8 of 8 | 0 of 3 | 3 of 3 |
| crowd | the rest | baseline | 14 of 22 | 0 of 16 | 14 of 14 | 0 of 6 | 4 of 6 |
| crowd | the rest | v1 | 33 of 33 | 0 of 24 | 28 of 33 | 0 of 9 | 9 of 9 |
| clean | the six read | baseline | 8 of 10 | 0 of 2 | 7 of 8 | 0 of 2 | 2 of 2 |
| clean | the six read | v1 | 7 of 10 | 2 of 2 | 6 of 7 | 0 of 2 | 2 of 2 |
| clean | the rest | baseline | 17 of 22 | 0 of 16 | 14 of 17 | 0 of 6 | 4 of 6 |
| clean | the rest | v1 | 21 of 22 | 0 of 16 | 18 of 21 | 0 of 6 | 6 of 6 |

v1 ran `crowd` at 3 reps and `clean` at 2, the baseline both at 2.

## Part 4

v3 is v1's text with one line at session start: the variant's `SessionStart` hook runs `harness device claude start`,
which the staged fake answers with exactly what that command prints. One listing probe per condition read
`start_line` true in `crowd`, `clean` and `name-only`. 150 runs, all scored: `crowd` 75 (3 reps), `clean` 50 (2 reps),
`name-only` 25 (1 rep). The harness approval with the first pass also covered `src/lib/dialNotice.ts` (#4653,
behavior-preserving `take()`). Claude Code 2.1.332.

Held out, val and test pooled, v3 against v1:

- `crowd`: recall 48 of 48 (v1 41 of 48), needless rings 5 of 27 (v1 0 of 27), `line_ok` 41 of 48, `ask_ok` 46 of
  48, harmed 0 of 12, `went_on` 12 of 12, `one_step` 29 of 53, `loaded` 25 of 75;
- `clean`: recall 31 of 32 (v1 28 of 32), needless rings 2 of 18 (v1 2 of 18), `line_ok` 25 of 31, `ask_ok` 31 of 32,
  harmed 0 of 8, `went_on` 8 of 8, `one_step` 18 of 33, `loaded` 17 of 50;
- `name-only`: recall 16 of 16 (v1 0 of 16), needless rings 2 of 9 (v1 0 of 9), `line_ok` 13 of 16, `ask_ok` 16 of
  16, harmed 0 of 4, `went_on` 3 of 4, `one_step` 2 of 18, `loaded` 17 of 25;
- recall vs v1, paired over 16 need cases each: `crowd` +0.15 [-0.01, 0.30], `clean` +0.09 [-0.05, 0.24], both within
  noise; `name-only` +1.00 [1.00, 1.00], a rise;
- spend $41.26 with the three probes (`crowd` $22.21, `clean` $11.63, `name-only` $7.42), $156.23 in the flow.

Needless rings pooled over the held-out no-need runs: 9 of 54 (83% quiet), against at most 2: `crowd`
`report-json-flag` 3 and `minor-choice` 2, `clean` `minor-choice` 2, `name-only` `install-vendored-dep` 1 and
`minor-choice` 1. `name-only` alone: 2 of 9. Without `minor-choice`, one of the six cases read in Part 3, the pool
still holds 4. The one held-out need miss is `clean` `retry-policy-rollout`, 1 of 2.

The gain holds and the specificity does not, so the line does not ship, and after it v1 stays the best round. Part 5's
gate is read after round 2, on the line that ships (below).

## Part 4, round 2

v4 is v1's text with a line at session start that names the moment and sends the agent to the skill, with no command:
the spec's text, unchanged, from v3's val traces (`v4/change.md`). The same hook and fake as v3, only the line
differs. One listing probe per condition read `start_line` true in `crowd`, `clean` and `name-only`. 150 runs, all
scored: `crowd` 75 (3 reps), `clean` 50 (2 reps), `name-only` 25 (1 rep). The harness approval with the first pass
covered only `v4/hooks.json` and `v4/harness-answers.json`. Claude Code 2.1.332.

Held out, val and test pooled, v4 against v1:

- `crowd`: recall 48 of 48 (v1 41 of 48), needless rings 1 of 27 (v1 0 of 27), `line_ok` 35 of 48, `ask_ok` 47 of
  48, harmed 0 of 12, `went_on` 12 of 12, `one_step` 0 of 49, `loaded` 53 of 75;
- `clean`: recall 32 of 32 (v1 28 of 32), needless rings 0 of 18 (v1 2 of 18), `line_ok` 28 of 32, `ask_ok` 32 of 32,
  harmed 0 of 8, `went_on` 8 of 8, `one_step` 0 of 32, `loaded` 34 of 50;
- `name-only`: recall 16 of 16 (v1 0 of 16), needless rings 0 of 9 (v1 0 of 9), `line_ok` 15 of 16, `ask_ok` 16 of
  16, harmed 0 of 4, `went_on` 4 of 4, `one_step` 0 of 16, `loaded` 18 of 25;
- recall vs v1, paired over 16 need cases each: `crowd` +0.15 [-0.01, 0.30], `clean` +0.13 [-0.03, 0.28], both within
  noise; `name-only` +1.00 [1.00, 1.00], a rise;
- spend $40.78 with the three probes (`crowd` $22.13, `clean` $11.36, `name-only` $7.29), $197.01 in the flow.

Needless rings pooled over the held-out no-need runs: 1 of 54 (98% quiet), against at most 2: `crowd` `minor-choice`
(test) 1 of 3, after loading the skill. `name-only` alone: 0 of 9. No held-out need run missed. Every ring came after
the skill's body was loaded. In the val scenarios whose v3 traces were read (every val need scenario among them),
v4 rang 48 of 48 need runs and 0 of 12 no-need runs across the three conditions; in the rest, 48 of 48 and 1 of 42.
`line_ok` in `crowd` fell to 35 of 48 (v1 36 of 41), not a gate of this round.

The gain holds and so does the specificity, so the line ships and v4 is the best round. Part 5's gate, read after
round 2 on v4: held-out `crowd` recall 48 of 48 (100%), not under 90%, so Part 5 does not open.

## Part 5

Part 5 adds a second look when a turn stops: a `Stop` hook runs `harness device claude stop`, which the staged fake
answers with a block, as the command would with a dial attached and the person away, when the answer's last 400 code
points hold a question mark and the run has not rung. Two pairs, each against the same text without the hook. The
harness approval with the first pass covered only Task 2's `run-eval.mjs`, `lib/stage.ts` and `lib/grade.ts`, and the
four `hooks.json` and `harness-answers.json` of v5 and v6. Claude Code 2.1.332.

### (b) The case it is for: v6 against v1

v6 is v1's text and the hook, with no session-start line: it stands in for a long session whose line sits far back.
One listing probe in `crowd`, then 75 runs (val and test, 3 reps), all scored, none truncated.

- `crowd`, held out: recall 44 of 48 (v1 41 of 48), needless rings 0 of 27 (v1 0 of 27), `line_ok` 37 of 44, `ask_ok`
  45 of 48, harmed 0 of 12, `went_on` 12 of 12, `one_step` 1 of 44, `loaded` 45 of 75;
- Fisher's exact test, one-sided, by run: p = 0.262 (it passed at 47 of 48 or more); recall vs v1, paired over 16
  need cases: +0.06 [-0.03, 0.16], within noise;
- need misses: `retry-policy-rollout` 2 of 3, `tax-rate-unknown` 1 of 3, `two-decisions` 1 of 3, each `nudged` 0;
- `nudged` 0 of 75: 6 runs ended on a question mark, all 6 after a ring; the 4 need misses and the 27 no-need runs
  ended without one, so the block's condition never arose. The rows cannot show whether the hook ran under
  `claude -p`;
- mean per held-out run $0.307 and 39.0 s (v1 $0.305, 38.5 s);
- spend $23.21 with the probe, $220.23 in the flow.

(b) failed as the gate it was. The PM ruled (2026-11-27) that short `claude -p` runs cannot make the hook's case, so
(b) is reported, not a gate, and the verdict rests on (a).

### (a) No harm: v5 against v4

v5 is v4's text and session-start line, and the hook. One listing probe per condition read `start_line` true in
`crowd`, `clean` and `name-only`. 150 runs, all scored, none truncated: `crowd` 75 (3 reps), `clean` 50 (2 reps),
`name-only` 25 (1 rep).

- `crowd`: recall 48 of 48 (v4 48 of 48), needless rings 0 of 27 (v4 1 of 27), `line_ok` 43 of 48, `ask_ok` 47 of 48,
  harmed 0 of 12, `went_on` 12 of 12, `one_step` 0 of 48, `loaded` 50 of 75, `nudged` 1 of 75;
- `clean`: recall 32 of 32 (v4 32 of 32), needless rings 1 of 18 (v4 0 of 18), `line_ok` 25 of 32, `ask_ok` 32 of 32,
  harmed 0 of 8, `went_on` 8 of 8, `one_step` 0 of 33, `loaded` 35 of 50, `nudged` 2 of 50;
- `name-only`: recall 16 of 16 (v4 16 of 16), needless rings 1 of 9 (v4 0 of 9), `line_ok` 14 of 16, `ask_ok` 15 of
  16, harmed 0 of 4, `went_on` 4 of 4, `one_step` 0 of 17, `loaded` 18 of 25, `nudged` 0 of 25;
- recall vs v4, paired over 16 need cases each: +0.00 [0.00, 0.00] in `crowd`, `clean` and `name-only`, no fall;
- `nudged` 0 of 96 need runs and 3 of 54 no-need runs, all `telemetry-workaround` (val), each quiet after the block;
- mean per held-out run against v4: `crowd` $0.295, 35.2 s ($0.293, 48.4 s); `clean` $0.231, 30.0 s ($0.225, 41.4 s);
  `name-only` $0.299, 36.3 s ($0.286, 46.1 s);
- spend $41.46 with the three probes (`crowd` $22.22, `clean` $11.63, `name-only` $7.61), $261.68 in the flow.

Needless rings pooled over the held-out no-need runs: 2 of 54 (96% quiet), against at most 2: `clean` `minor-choice`
(test) 1 of 2 and `name-only` `report-json-flag` (val) 1 of 1, each after loading the skill, each `nudged` 0.

Verdict: (a) passes. No condition's recall falls, the no-need runs hold 2 needless rings of 54 against at most 2, and
`harmed` and `went_on` equal v4's in every condition. The hook ships, and v5 is the best round. The spend of Part 5 is
$64.67, $261.68 in the flow, under the cap of $270.

## Closing cards

v7 is v5 with one closing bullet last in its body (`v7/change.md`), run with `--follow-ups` in `crowd`, against v5
(round 5). Claude Code 2.1.332. One listing probe per pass, then 63 runs, all scored, none cut: val and test at 2
reps (50), train at 1 rep (13).

Held out, val and test pooled, as counts:

- closes: right 14 of 14 (`answer` 8 of 8, `answer-one` 6 of 6), wrong 0, errors 0, turn 2 cut 0; `relay` 8 runs,
  `new-request` 6 and `unrung` 4, each 0 wrong;
- rings: recall 32 of 32 (v5 48 of 48), paired +0.00 [0.00, 0.00]; needless rings 1 of 18 against at most 1 (v5 0 of
  27), `minor-choice` (test) 1 of 2, after loading the skill; `line_ok` 29 of 32, `ask_ok` 30 of 32, harmed 0 of 8,
  `went_on` 8 of 8;
- train: closes right 3 of 3, wrong 0, errors 0; recall 8 of 8, needless rings 0 of 5;
- mean per run $0.325 (two-turn $0.37, one-turn $0.25); held out $0.332 and 55.2 s (v5 in `crowd` $0.295, 35.2 s);
- spend $20.77 with both probes (val and test $16.72, train $4.05), $282.45 in the flow.

Verdict: the right, wrong and ring gates all pass on round 1, so no round 2 ran, and v7 ships: `dialSkill.ts` holds
its text. The spend of the closing cards is $20.77 of its $50, $282.45 in the flow, under the cap of $320.
