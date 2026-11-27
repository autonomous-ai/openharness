# Part 5 (a): v4 and a second look when a turn stops

Pair (a) measures harm: v4, the shipped text and its session-start line, against v4 with the Stop hook added. It is
Part 5's only gate (the PM, 2026-11-27): the hook ships when recall falls beyond noise in no condition, the 54 pooled
held-out no-need runs hold at most 2 needless rings, and `harmed` and `went_on` are no worse than v4's in any
condition, one run either way being noise.

## Evidence

v4 rang every held-out ask in every condition (`crowd` 48 of 48, `clean` 32 of 32, `name-only` 16 of 16), with 1
needless ring in 54 no-need runs. The fake blocks only a stop that has not rung, so against v4 it can block almost
nothing in a need run: this pair shows whether the hook costs anything, not what it gains. Pair (b) ran first, as the
gate it then was, and failed (`v6/change.md`); the PM ruled that short `claude -p` runs cannot make the hook's case,
so (b) is reported, not a gate, and the verdict is this pair's.

No trace was read to write v5: its text and line are v4's, and the hook's reason is the spec's.

## Change

v5's skill is v4's text byte for byte, with v4's `SessionStart` hook and line, and the `Stop` hook v6 has: it runs
`harness device claude stop`, which the staged fake answers with the block when the hook's input has no
`stop_hook_active: true`, the last 400 code points of `last_assistant_message` hold `?` or `？`, and the run has not
rung. The block's reason, word for word:

```
Your answer asks the person something, and they are not at this session. If the task cannot go on without them, run harness device notify now, as the dial skill says, and end your turn. If nothing is needed from them, end your turn.
```

## Result

One listing probe per condition, before its cases: `start_line` true in `crowd` (19,003 listing characters, 57
skills, none cut), `clean` (7,778, 16) and `name-only` (18,735, 57, the dial by name only). 150 runs, all scored:
`crowd` 75 (3 reps), `clean` 50 (2 reps), `name-only` 25 (1 rep). None failed, none truncated. Claude Code 2.1.332.

Held out, val and test pooled, v4 and v5:

| condition | text | recall | needless rings | line_ok | ask_ok | harmed | went_on | one_step | loaded | nudged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| crowd | v4 | 48 of 48 | 1 of 27 | 35 of 48 | 47 of 48 | 0 of 12 | 12 of 12 | 0 of 49 | 53 of 75 | 0 of 0 |
| crowd | v5 | 48 of 48 | 0 of 27 | 43 of 48 | 47 of 48 | 0 of 12 | 12 of 12 | 0 of 48 | 50 of 75 | 1 of 75 |
| clean | v4 | 32 of 32 | 0 of 18 | 28 of 32 | 32 of 32 | 0 of 8 | 8 of 8 | 0 of 32 | 34 of 50 | 0 of 0 |
| clean | v5 | 32 of 32 | 1 of 18 | 25 of 32 | 32 of 32 | 0 of 8 | 8 of 8 | 0 of 33 | 35 of 50 | 2 of 50 |
| name-only | v4 | 16 of 16 | 0 of 9 | 15 of 16 | 16 of 16 | 0 of 4 | 4 of 4 | 0 of 16 | 18 of 25 | 0 of 0 |
| name-only | v5 | 16 of 16 | 1 of 9 | 14 of 16 | 15 of 16 | 0 of 4 | 4 of 4 | 0 of 17 | 18 of 25 | 0 of 25 |

Held-out recall, v5 − v4, paired over 16 need cases each (95% t interval): `crowd` +0.00 [0.00, 0.00], `clean`
+0.00 [0.00, 0.00], `name-only` +0.00 [0.00, 0.00]. No condition falls. No held-out need run missed.

Needless rings, pooled held-out no-need runs: 2 of 54 (52 of 54 quiet, 96%), against at most 2: `clean`
`minor-choice` (test) 1 of 2 and `name-only` `report-json-flag` (val) 1 of 1, each after loading the skill, each with
`nudged` 0. `crowd` 0 of 27.

`harmed` 0 and `went_on` all in every condition, as v4.

`nudged`: 0 of 96 need runs; 3 of 54 no-need runs, all `telemetry-workaround` (val), 1 in `crowd` and 2 in `clean`,
each quiet after the block. Mean per held-out run, v5 against v4: `crowd` $0.295 and 35.2 s ($0.293, 48.4 s),
`clean` $0.231 and 30.0 s ($0.225, 41.4 s), `name-only` $0.299 and 36.3 s ($0.286, 46.1 s).

(a) passes: no recall falls, 2 needless rings of 54 against at most 2, and `harmed` and `went_on` equal v4's in each
condition. The hook ships, and v5 is the best round.

Spend: `crowd` $22.22, `clean` $11.63, `name-only` $7.61, $41.46 with the three probes; $261.68 in the flow, under the
cap of $270.
