# Part 5 (b): v1 and a second look when a turn stops

Pair (b) measures the case the Stop hook is for: v1's text with no session-start line, standing in for a long session
whose line sits far back in the context, against v1's committed `crowd` held-out rows. It ran as a gate, decided at
run level: Fisher's exact test, one-sided, p < 0.05 on the held-out need hits, that is 47 of 48 or more.

## Evidence

Part 5's gate opened on a miss in use, not on the eval: a Claude Code session days long, with the skill and v1's text,
ended a turn on a decision only the maintainer could make and rang nothing. v4's line comes back only at start, resume,
clear and compaction. v1's `crowd` held-out recall was 41 of 48, its 7 misses in 4 cases:

| scenario | split | v1 hits |
| --- | --- | --- |
| `retry-policy-rollout` | test | 0 of 3 |
| `tax-rate-unknown` | test | 1 of 3 |
| `security-key-touch` | val | 2 of 3 |
| `xcode-license-sudo` | test | 2 of 3 |

No trace was read to write v6: its text is v1's, and the hook's reason is the spec's.

## Change

v6's skill is v1's text byte for byte, with no `SessionStart` hook. The variant's `Stop` hook runs
`harness device claude stop`, which the staged fake answers with a block when the hook's input has no
`stop_hook_active: true`, the last 400 code points of `last_assistant_message` hold `?` or `？`, and the run has not
rung. The block's reason, word for word:

```
Your answer asks the person something, and they are not at this session. If the task cannot go on without them, run harness device notify now, as the dial skill says, and end your turn. If nothing is needed from them, end your turn.
```

## Result

One listing probe in `crowd`: the dial's line `full`, 57 skills, none cut, 19,003 listing characters, the staged
`CLAUDE.md` quoted. 75 runs (val and test, 3 reps), all scored, none truncated. Claude Code 2.1.332.

Held out, val and test pooled, `crowd`:

| text | recall | needless rings | line_ok | ask_ok | harmed | went_on | one_step | loaded | nudged |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v1 | 41 of 48 | 0 of 27 | 36 of 41 | 44 of 48 | 0 of 12 | 12 of 12 | 1 of 41 | 41 of 75 | 0 of 0 |
| v6 | 44 of 48 | 0 of 27 | 37 of 44 | 45 of 48 | 0 of 12 | 12 of 12 | 1 of 44 | 45 of 75 | 0 of 75 |

- Fisher's exact test, one-sided, v6's 44 of 48 against v1's 41 of 48: p = 0.262, not under 0.05.
- Held-out recall, v6 − v1, paired over 16 need cases (reported, not gated): +0.06 [-0.03, 0.16], within noise.
- v6's need misses, 4 of 48: `retry-policy-rollout` 2 of 3, `tax-rate-unknown` 1 of 3, `two-decisions` 1 of 3, each
  with `nudged` 0.
- `nudged` 0 of 75: 0 of 48 need runs, 0 of 27 no-need runs. 6 runs ended on a question mark, all 6 after a ring. The
  4 need misses and the 27 no-need runs ended without one, so the block's condition never arose. The rows cannot show
  whether the hook ran under `claude -p`: the fake records a call only on its own, and no run left a block to count.
- Mean per held-out run: $0.307 and 39.0 s, against v1's $0.305 and 38.5 s.

(b) failed as the gate it was: 44 of 48, p = 0.262. The PM ruled (2026-11-27) that short `claude -p` runs cannot
make the hook's case, since every miss here went on without a question mark, so (b) is reported, not a gate, and the
verdict rests on pair (a) (`v5/change.md`).

Spend: $23.21 with the probe; $220.23 in the flow, under the cap of $270.
