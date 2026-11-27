# Closing cards, round 1: the spec's starting bullet

v7 measures v4 against v4 plus one bullet that tells the agent to close the card the person answered. Its hooks and
harness answers are v4's; if Part 5 ships, they become Part 5's shipped variant's at the eval's Base step, and v7 is
measured against that variant. Run with `--follow-ups`: each need scenario takes a second turn (see the README's
Follow-ups section). The gates are read on val and test pooled, in `crowd`.

## Change

The body gains one bullet, last, after "In your answer, …"; the description is unchanged:

```
- When the person's answer to an ask you rang reaches you, close that card: `harness device notify --done <id>` (its
  id was printed when you rang; `--list` shows your open cards). A message from another agent or session is not their
  answer.
```

## Evidence

Numbers to come, from the pass.
