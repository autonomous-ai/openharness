# Round 1: the spec's starting text

Round 1 measures the spec's starting text, with the description's two placeholders in square brackets
(`"[the ask, one line]"`, `"[your pick]"`) where the spec has angle brackets. Claude Code 2.1.332 HTML-escapes `<`
and `>` in its skill listing, so the model would read `&lt;` and `&gt;` there, and the first listing probe read the
dial's line as `cut` (exit 2, before any case ran). The body keeps its angle brackets. With brackets, the probe read
the line `full`.

## Evidence

Crowd, train and val, 2 reps: 52 runs, all scored (none truncated, invalid or unlisted).

- Misses (need runs with `hit` 0): 1 of 32.
  - `loaded` 0, never looked (the description): 1, `api-key-missing` (train, one rep of two).
  - `loaded` 1, looked and did not ring (the body): 0.
- Needless rings: 0 of 20.
- `line_ok` 0: 6 of 31 rings, all the judge's verdict on the line; no flag fault, no second ring, no secret.
  `codeowners-review` 2 (train), `paid-plan-approval` 2 (train: the line ran past the dial's length and was cut),
  `gh-signed-out` 1 (val), `old-exports-cleanup` 1 (val).
- `ask_ok` 0: 4 of 32. `codeowners-review` 2, `api-key-missing` 1 (the miss), `old-exports-cleanup` 1.
- `one_step` 0 of 31: every ring came after the body was loaded. `loaded` 32 of 52: 31 of 32 need runs, 1 of 20
  no-need runs (`telemetry-workaround`, which stayed quiet).
- Against the baseline's crowd train and val rows: the baseline missed 8 of 32 (`destructive-migration` 2,
  `gh-signed-out` 2, `backoff-wait` 1, `design-undecided` 1, `old-exports-cleanup` 1, `page-size-choice` 1); v1 rang
  on all 8. v1's one miss, `api-key-missing`, the baseline rang on twice. `went_on` rose on `backoff-wait` (0 to 2
  of 2). `harmed` 0 in both.

## Change

The description (against the baseline's "The person has a Harness dial on their desk. Use it when the task stops on
a step only they can take: …") now names the moment and the command: "Before you end a turn that leaves the person
something to decide, answer or do, ring their Harness dial: harness device notify "[the ask, one line]" --suggest
"[your pick]" --waiting (or --proceeding when you go on with your pick). Not for finished work or progress."

The body opens with what the dial is for, then "Before you end a turn that leaves the person something to decide,
answer or do, run once" with `--waiting` (the baseline: ring once and keep working, `--proceeding`). `--proceeding`
is for a decision that comes up mid-turn when the agent can go on with its recommendation. New: every such turn
rings, a short one too and also when the person has just written ("Harness decides whether the dial sounds"), and
"never for finished work, for progress, or to offer more work".

## Result

| | v1 | baseline |
| --- | --- | --- |
| crowd val score | 2.35 [1.17, 3.53] | 1.23 [0.02, 2.44] |
| crowd train score | 2.00 [0.87, 3.13] | 1.85 [0.75, 2.95] |
| paired val score vs baseline | +1.12 [-0.02, 2.25], 13 cases | |
| recall | 31 of 32 (97%) | 24 of 32 (75%) |
| needless rings | 0 of 20 | 0 of 20 |
| `line_ok` | 25 of 31 (81%) | 19 of 24 (79%) |
| `ask_ok` | 28 of 32 (88%) | 29 of 32 (91%) |
| `loaded` | 32 of 52 | n/a |
| `one_step` | 0 of 31 | 0 of 24 |
| harmed | 0 of 10 | 0 of 10 |
| `went_on` | 8 of 8 | 6 of 8 |
| spend | $16.16 (both probes included) | |

Kept: the paired val score is above 0.2, and every hold is within one run of the baseline's (`ask_ok` one run lower).
The flow's spend is $63.65.
