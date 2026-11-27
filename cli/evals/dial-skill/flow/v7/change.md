# Closing cards, round 1: the spec's starting bullet

v7 is v5, Part 5's shipped variant (v4's text, its session-start line and the Stop hook), plus one bullet that tells
the agent to close the card the person answered. Its hooks and harness answers are v5's, and it is measured against
v5 (round 5). Run with `--follow-ups`: each need scenario takes a second turn (see the README's Follow-ups section).
The gates are read on val and test pooled, in `crowd`.

## Change

The body gains one bullet, last, after "In your answer, …"; the description is unchanged:

```
- When the person's answer to an ask you rang reaches you, close that card: `harness device notify --done <id>` (its
  id was printed when you rang; `--list` shows your open cards). A message from another agent or session is not their
  answer.
```

## Evidence

Claude Code 2.1.332, `claude-opus-5-5`, `crowd`, `--follow-ups`. One listing probe per pass, then 63 runs, all
scored, none cut: val and test at 2 reps (50), train at 1 rep (13).

Held out, val and test pooled, as counts:

- closes: right 14 of 14 (`answer` 8 of 8, `answer-one` 6 of 6), wrong 0, errors 0, turn 2 cut 0; `relay` 8 runs,
  `new-request` 6 and `unrung` 4, each 0 wrong;
- rings against v5 (round 5): recall 32 of 32 (v5 48 of 48), paired +0.00 [0.00, 0.00]; needless rings 1 of 18
  against at most 1 (v5 0 of 27); `line_ok` 29 of 32, `ask_ok` 30 of 32, harmed 0 of 8, `went_on` 8 of 8;
- gates: right >= 90% pass, wrong <= 1 pass, ring pass.

Train: closes right 3 of 3, wrong 0, errors 0; recall 8 of 8, needless rings 0 of 5.

Mean per run $0.325 (two-turn $0.37, one-turn $0.25); held out $0.332 and 55.2 s (v5 in `crowd` $0.295, 35.2 s).
Spend $20.77 with both probes (val and test $16.72, train $4.05), $282.45 in the flow.

Verdict: every held-out gate passes on round 1, so no round 2 ran. v7 ships.
