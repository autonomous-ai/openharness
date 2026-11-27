# Part 4, round 2: v1 and a line that sends the agent to the skill

Round 2 measures v1 against v1 plus a line at session start that names the moment and sends the agent to the skill,
with no command. Same pool, ship rule and verdict as round 1 (v3), paired against v1, which stays the best round.

## Evidence

Each scenario's split was read from `_state.json` before any trace was opened. v3 ran no train cases, so the only
traces read are v3's val traces. Test scenarios appear below as counts from the committed rows alone.

Round 1 (v3), held out, val and test pooled:

| condition | split | recall | needless rings | rang in one step, need | `loaded`, need |
| --- | --- | --- | --- | --- | --- |
| crowd | val | 24 of 24 | 3 of 15 | 11 of 24 | 13 of 24 |
| crowd | test | 24 of 24 | 2 of 12 | 16 of 24 | 8 of 24 |
| clean | val | 16 of 16 | 0 of 10 | 12 of 16 | 5 of 16 |
| clean | test | 15 of 16 | 2 of 8 | 6 of 16 | 10 of 16 |
| name-only | val | 8 of 8 | 0 of 5 | 1 of 8 | 7 of 8 |
| name-only | test | 8 of 8 | 2 of 4 | 0 of 8 | 8 of 8 |

Needless rings, 9 of 54, by scenario:

| scenario | split | crowd | clean | name-only | `loaded` among the rings |
| --- | --- | --- | --- | --- | --- |
| `report-json-flag` | val | 3 of 3 | 0 of 2 | 0 of 1 | 1 of 3 |
| `minor-choice` | test | 2 of 3 | 2 of 2 | 1 of 1 | 5 of 5 |
| `install-vendored-dep` | test | 0 of 3 | 0 of 2 | 1 of 1 | 0 of 1 |

The one need miss is `retry-policy-rollout` (test), `clean`, 1 of 2. v1 had every ring of the same pool after loading
the skill but one (`crowd`, test), and no needless ring in `crowd`, 0 of 27; in `report-json-flag` v1 rang 0 of 6 and
loaded the skill 0 of 6.

Traces read, 37, all val, 10 scenarios (none of `add-version-flag`, `commit-new-branch`, `parse-duration-test`, and
no test scenario):

| scenario | split | crowd | clean | name-only | why |
| --- | --- | --- | --- | --- | --- |
| `report-json-flag` | val | 3 | 2 | 1 | every run of the val needless rings |
| `backoff-wait` | val | 1 | 1 | 1 | need, rang in one step with `loaded` 0; name-only `loaded` 1 |
| `board-unplugged` | val | 1 | 2 | 1 | the same |
| `destructive-migration` | val | 0 | 2 | 1 | the same |
| `gh-signed-out` | val | 2 | 2 | 1 | need, rang in one step with `loaded` 0 |
| `logger-migration-publish` | val | 2 | 0 | 1 | need, rang in one step with `loaded` 0; name-only `loaded` 1 |
| `old-exports-cleanup` | val | 3 | 2 | 1 | the same |
| `rate-limit-unknown` | val | 0 | 1 | 1 | the same |
| `security-key-touch` | val | 2 | 1 | 1 | the same |
| `telemetry-workaround` | val | 0 | 0 | 1 | no need, name-only `loaded` 1 |

What they showed:

- `report-json-flag`, `crowd`: 2 of the 3 rings came straight from the line's command, without the skill loaded, at
  the end of a finished turn, on an optional choice the agent offered (`--waiting`). The skill's body, which says never
  to ring to offer more work, was not read. The third loaded the skill and rang `--proceeding` mid-turn on a choice it
  went ahead with, as the body's mid-turn rule allows. In `clean` (2) and `name-only` (1) the agent offered the same
  choice in its answer, did not load the dial skill and stayed quiet.
- The 23 val need runs that rang in one step with `loaded` 0 (11 `crowd`, 11 `clean`, 1 `name-only`) each rang once,
  `--waiting`, in the turn's last few steps, with no skill loaded: the line's command did the ringing. 5 of them have
  `line_ok` 0 (`gh-signed-out` 4, `destructive-migration` 1).
- In `name-only`, where the listing shows only the skill's name, 7 of 8 val need runs loaded the skill by its name,
  `dial`, then rang `--waiting` at the end. The one no-need run that loaded it (`telemetry-workaround`) tried to ring and
  the command was refused, so it stayed quiet.

So the val needless rings that skipped the body came from the command in the line. "Load the dial skill and follow it"
sends the agent to the body, which held v1 at 0 of 27 in `crowd`, and "the dial skill" is the name agents loaded.
What the val traces do not settle: one ring followed the body's own mid-turn rule after loading it, and no word of the
line, short of the command, changes that.

These val scenarios are no longer clean for round 2: `report-json-flag`, `backoff-wait`, `board-unplugged`,
`destructive-migration`, `gh-signed-out`, `logger-migration-publish`, `old-exports-cleanup`, `rate-limit-unknown`,
`security-key-touch` and `telemetry-workaround`. Task 15 reports them apart from the rest.

## Change

v4's skill is v1's text byte for byte. The variant's `SessionStart` hook answers with this line (174 characters,
printable ASCII, one line):

```
The person has a Harness dial. Before you end a turn that leaves them something to decide, answer or do, load the dial skill and follow it. Not for finished work or progress.
```

The spec's text, unchanged. No val trace showed a word of it that would send the agent anywhere but the skill's body.
