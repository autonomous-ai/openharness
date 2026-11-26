# Dial skill hill-climb

<!-- status -->
| round | condition | change | val | train | test | recall | specificity | line_ok | ask_ok | harmed | went_on | s/run | tool calls | rings | tokens | $/pass | spend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | clean | baseline | 1.69 [0.41, 2.98] | 1.88 [0.79, 2.98] | 1.67 [0.12, 3.21] | 84% | 100% | 78% | 88% | 0 (0%) | 75% | 32.0 | 8.3 | 0.52 | 185619 | $17.87 | $17.87 |
| 0 | crowd | baseline | 1.23 [0.02, 2.44] | 1.85 [0.75, 2.95] | 1.50 [0.03, 2.97] | 75% | 100% | 79% | 91% | 0 (0%) | 75% | 36.3 | 9.1 | 0.46 | 232108 | $22.36 | $40.22 |
| 0 | name-only | baseline | -0.85 [-1.33, -0.36] |  | -0.75 [-1.14, -0.36] | 0% | 100% | n/a | 63% | 0 (0%) | 100% | 34.0 | 9.4 | 0.00 | 212650 | $7.27 | $47.49 |
| 1 | crowd | Round 1: the spec's starting text | 2.35 [1.17, 3.53] | 2.00 [0.87, 3.13] |  | 97% | 100% | 81% | 88% | 0 (0%) | 100% | 40.2 | 10.9 | 0.60 | 264108 | $16.16 | $63.65 |
<!-- /status -->

Held out: val and test pooled, as counts.

<!-- held-out -->
| variant | condition | recall | needless rings | line_ok | ask_ok | harmed | went_on | one_step | loaded | score vs baseline |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | clean | 25 of 32 | 0 of 18 | 21 of 25 | 27 of 32 | 0 of 8 | 6 of 8 | 0 of 25 | 0 of 0 |  |
| baseline | crowd | 21 of 32 | 0 of 18 | 20 of 21 | 28 of 32 | 0 of 8 | 6 of 8 | 0 of 21 | 0 of 0 |  |
| baseline | name-only | 0 of 16 | 0 of 9 | 0 of 0 | 12 of 16 | 0 of 4 | 4 of 4 | 0 of 0 | 0 of 0 |  |
| v1 | crowd | 16 of 16 | 0 of 10 | 14 of 16 | 15 of 16 | 0 of 6 | 4 of 4 | 0 of 16 | 17 of 26 | +1.12 [-0.02, 2.25] |
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
