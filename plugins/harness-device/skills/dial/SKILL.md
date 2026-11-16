---
name: dial
description: "The person has a Harness dial on their desk. Use it when you need them to do something you cannot: give information, act outside your reach (connect a VPN, sign in, plug in a device), or decide."
---

When you need the person to act, ring their dial:

    harness device notify "<what you need, in one line>"

- Never for progress, and never for "done": only when the person must act.
- At most once for the same need.
- Never put a secret, a token or a file's content in the line: anyone near the desk can read it.
- Still write the full ask in your answer. The command prints `shown`, `no dial` or `limited`: whichever it prints, your answer carries the ask.
