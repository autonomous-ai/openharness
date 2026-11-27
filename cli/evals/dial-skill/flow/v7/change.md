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

Numbers to come, from the pass.
