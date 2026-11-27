# Part 4: v1 and a standing line at session start

Part 4 measures v1 against v1 plus one line at session start, in `crowd`, `clean` and `name-only`, val and test
pooled (held out). The line ships if held-out recall rises beyond noise against v1 in `crowd` or in `name-only`,
falls beyond noise in no condition, and the pooled held-out no-need runs of the three conditions stay quiet in at
least 95% (at most 2 needless rings of 54).

## Evidence

- One listing probe per condition, before its cases: `start_line` true in `crowd`, `clean` and `name-only`, so the
  line reached the model in each.
- The harness approval recorded with the first pass covered Task 7's `lib/probe.ts`, `v3/hooks.json`,
  `v3/harness-answers.json`, and also `src/lib/dialNotice.ts` (#4653, behavior-preserving `take()`).
- 150 runs, all scored: `crowd` 75 (3 reps), `clean` 50 (2 reps), `name-only` 25 (1 rep). None failed.
- Claude Code 2.1.332.

## Change

v3's skill is v1's text byte for byte (`SKILL.md` and `SKILL.before.md`). The variant adds the plugin's
`SessionStart` hook (`hooks.json`), which runs `harness device claude start`, and the staged fake answers it with
exactly what that command prints (`harness-answers.json`): the line as the session's `additionalContext`.

## Result

Held out, val and test pooled, v1 and v3:

| condition | text | recall | needless rings | line_ok | ask_ok | harmed | went_on | one_step | loaded |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| crowd | v1 | 41 of 48 | 0 of 27 | 36 of 41 | 44 of 48 | 0 of 12 | 12 of 12 | 1 of 41 | 41 of 75 |
| crowd | v3 | 48 of 48 | 5 of 27 | 41 of 48 | 46 of 48 | 0 of 12 | 12 of 12 | 29 of 53 | 25 of 75 |
| clean | v1 | 28 of 32 | 2 of 18 | 24 of 28 | 31 of 32 | 0 of 8 | 8 of 8 | 0 of 30 | 32 of 50 |
| clean | v3 | 31 of 32 | 2 of 18 | 25 of 31 | 31 of 32 | 0 of 8 | 8 of 8 | 18 of 33 | 17 of 50 |
| name-only | v1 | 0 of 16 | 0 of 9 | 0 of 0 | 13 of 16 | 0 of 4 | 4 of 4 | 0 of 0 | 0 of 25 |
| name-only | v3 | 16 of 16 | 2 of 9 | 13 of 16 | 16 of 16 | 0 of 4 | 3 of 4 | 2 of 18 | 17 of 25 |

Held-out recall, v3 − v1, paired over the need cases both scored (95% t interval):

- `crowd`: +0.15 [-0.01, 0.30] over 16 cases, within noise;
- `clean`: +0.09 [-0.05, 0.24] over 16 cases, within noise;
- `name-only`: +1.00 [1.00, 1.00] over 16 cases, a rise.

Needless rings, pooled held-out no-need runs: 9 of 54 (45 of 54 quiet, 83%), against at most 2. By scenario:
`crowd` `report-json-flag` 3 (`loaded` 0 in 2, 1 in 1) and `minor-choice` 2 (`loaded` 1); `clean` `minor-choice` 2
(`loaded` 1); `name-only` `install-vendored-dep` 1 (`loaded` 0) and `minor-choice` 1 (`loaded` 1). `name-only` alone:
2 of 9. `minor-choice` is one of the six cases whose traces were read in Part 3; without it the pool still holds 4
needless rings.

The one held-out need miss is `clean` `retry-policy-rollout`, 1 of 2 (`loaded` 1). `crowd` has none.

Verdict: the gain holds (`name-only` rises beyond noise, no condition falls), the specificity does not (9 of 54
against at most 2). The line does not ship. After it v1 stays the best round. Part 5's gate is read after round 2
(v4): v4 ships, and its held-out `crowd` recall is 48 of 48 (100%), not under 90%, so Part 5 does not open
(`v4/change.md`).

Spend: `crowd` $22.21, `clean` $11.63, `name-only` $7.42, $41.26 with the three probes; $156.23 in the flow, under the
cap of $175.
