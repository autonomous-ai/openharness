# Round 2: open choices and work left for them

Round 2 runs because v1 missed the recall gate on the held-out pass: crowd, val and test pooled, 41 of 48 (85%,
gate 90%), and clean rang needlessly 2 of 18 (`minor-choice`, both reps). The PM ran it on 2026-11-27 with the cap
raised to $145.

## Evidence

Read from v1's held-out traces before v2's text was written:

- Every crowd need miss had `loaded` 0 (the description): `retry-policy-rollout` 3 of 3, `tax-rate-unknown` 2 of 3,
  `security-key-touch` 1 of 3, `xcode-license-sudo` 1 of 3 (and `api-key-missing` 1 of 2 on train).
- `retry-policy-rollout` (expect `--proceeding`): the agent moved the other clients, left the open choice in place,
  read it as another person's, and reported the task as done with no ask.
- `tax-rate-unknown`, `security-key-touch`, `xcode-license-sudo`: the agent wrote the ask in its answer, after a
  report of the work it had done, and never looked at the skill. "Not for finished work" fits such a turn.
- `minor-choice`, clean, both reps: `loaded` 1. The agent read the body, picked the flag the CLI's own convention
  gives, and rang `--proceeding` for it, as the body's line on a decision mid-turn says.

**Held-out traces read.** The traces of `retry-policy-rollout`, `tax-rate-unknown`, `xcode-license-sudo`,
`minor-choice` and `sso-expired` (test) and `security-key-touch` (val) were read to write v2, so those cases are no
longer held out for v2. Held-out numbers below are split into those cases and the rest; the gates still read on the
total.

## Change

Three changes against v1:

1. The description says when to ring for a choice the agent went on past: "--proceeding when you went on with your
   pick. That includes a part you left undone, or settled your own way, because a choice is still open: theirs, or
   one they must get from someone else." Aimed at `retry-policy-rollout`.
2. The body says when a choice is open and when it is the agent's: "A choice is open when their words or the repo say
   so (an issue's "not decided yet", an owner who has not picked). If you go on with your own pick for it, or leave
   that part undone, run it with --proceeding before you end the turn, even when the rest is done and another person
   owns the choice: the person gets it decided." And: "A choice the code's own conventions settle (the flags it
   already has, the style around it) is yours, even when the person wondered which: make it, say why in your answer,
   and ring nothing." Aimed at `minor-choice`.
3. The description's "Not for finished work or progress." becomes "Not for progress, or for work done with nothing
   left for them." Aimed at the misses where an ask follows a report of done work.

The body's "Never for finished work, for progress, or to offer more work" stays.

## Result

Crowd, train and val, 2 reps, 52 runs, all scored.

| | v2 | v1 (reps 0 and 1) |
| --- | --- | --- |
| crowd val score | 2.35 [1.12, 3.58] | 2.35 [1.17, 3.53] |
| crowd train score | 2.08 [0.84, 3.32] | 2.00 [0.87, 3.13] |
| paired val score, v2 − v1 | +0.00 [-0.21, 0.21], 13 cases | |
| paired train score, v2 − v1 | +0.08 [-0.49, 0.64], 13 cases | |
| recall | 32 of 32 | 31 of 32 |
| needless rings | 4 of 20 | 0 of 20 |
| `line_ok` | 26 of 32 | 25 of 31 |
| `ask_ok` | 29 of 32 | 28 of 32 |
| `loaded` | 34 of 52 | 32 of 52 |
| `one_step` | 4 of 36 | 0 of 31 |
| harmed | 0 of 10 | 0 of 10 |
| `went_on` | 8 of 8 | 8 of 8 |
| spend | $16.10 (probe included) | $16.16 |

Crowd val split by traces read (security-key-touch, 1 case) and not read (12 cases):

| | v2 | v1 (reps 0 and 1) |
| --- | --- | --- |
| traces read: score, recall | 4.00, 2 of 2 | 4.00, 2 of 2 |
| traces not read: score, recall | 2.21, 14 of 14 | 2.21, 14 of 14 |
| traces not read: needless rings | 1 of 10 | 0 of 10 |
| traces not read: `line_ok` | 12 of 14 | 12 of 14 |

The 4 needless rings are `fix-off-by-one` 2 of 2 and `signup-typo` 1 of 2 (train), and `report-json-flag` 1 of 2
(val). Each rang from the description alone (`loaded` 0, `one_step` 1): the agent rang for a call it had made itself
(fixing the code to match the tests, the shape of the JSON), or for an offer of more work, and never read the body
that says which choices are its own. The new description's "settled your own way" reaches such calls, and the body's
limits on it do not travel with it. The need misses are gone (`api-key-missing` rang 2 of 2), but on val the score
is v1's.

Not kept: the crowd val mean is not above v1's by more than 0.2 (+0.00), and needless rings on train and val rose
from 0 to 4. v1 stays the winner. The flow's spend is $114.97.
