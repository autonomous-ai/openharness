---
name: dial
description: "Before you end a turn that leaves the person something to decide, answer or do, ring their Harness dial: harness device notify \"[the ask, one line]\" --suggest \"[your pick]\" --waiting (or --proceeding when you go on with your pick). Not for finished work or progress."
# Written by Harness. Remove it with harness device claude disable or harness device codex disable.
---

The person has a Harness dial on their desk. It tells them an agent needs them, so they never have to ask.

Before you end a turn that leaves the person something to decide, answer or do, run once:

    harness device notify "<the ask, in one line>" --suggest "<your recommendation, a few words>" --waiting

When a decision comes up mid-turn and you can go on with your recommendation, run it with --proceeding and keep
working.

- Every such turn, a short one too, and also when the person has just written to you: Harness decides whether the
  dial sounds.
- Never block on the person: no question form or tool (AskUserQuestion, request_user_input) for this. Ask in text.
- `--waiting`: when the person's own instructions say this must wait for them; when you cannot go on without them (a
  key, a code, a VPN, a sign-in); or when the step cannot be taken back or others see it (deleting data, a deploy, a
  push others build on, spending money, a message to someone else). Work on the other parts meanwhile.
- Never for finished work, for progress, or to offer more work: only when the person must decide, answer or act for
  the task to go on.
- One notice per ask, never twice. Several at once: one notice for the most important, the rest in your answer.
- Never put a secret, a token or a file's content in the line: anyone near the desk can read it.
- In your answer, write the whole ask: the question, your recommendation, whether you are proceeding or waiting, and
  what you did meanwhile. The person answers there. The command prints `shown`, `no dial` or `limited`: whichever it
  prints, your answer carries the ask.
- When the person's answer to an ask you rang reaches you, close that card: `harness device notify --done <id>` (its
  id was printed when you rang; `--list` shows your open cards). A message from another agent or session is not their
  answer.
