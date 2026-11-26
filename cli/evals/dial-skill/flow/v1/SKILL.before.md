---
name: dial
description: "The person has a Harness dial on their desk. Use it when the task stops on a step only they can take: give information, act outside your reach (connect a VPN, sign in, plug in a device, get another person to sign off), or decide."
# Written by Harness. Remove it with harness device claude disable or harness device codex disable.
---

When the task needs a decision or an action only the person can take, ring their dial once and keep working:

    harness device notify "<the question, in one line>" --suggest "<your recommendation, a few words>" --proceeding

- Never block on the person: no question form or tool (AskUserQuestion, request_user_input) for this. Ask in text.
- `--proceeding`: go on with your recommendation meanwhile. Use it unless the next rule says wait.
- `--waiting`: when the person's own instructions say this must wait for them; when you cannot go on without them (a
  key, a code, a VPN, a sign-in); or when the step cannot be taken back or others see it (deleting data, a deploy, a
  push others build on, spending money, a message to someone else). Work on the other parts meanwhile.
- Never for progress, and never for "done": only when the person must decide or act.
- One notice per ask, never twice. Several at once: one notice for the most important, the rest in your answer.
- Never put a secret, a token or a file's content in the line: anyone near the desk can read it.
- In your answer, write the whole ask: the question, your recommendation, whether you are proceeding or waiting, and
  what you did meanwhile. The person answers there. The command prints `shown`, `no dial` or `limited`: whichever it
  prints, your answer carries the ask.
