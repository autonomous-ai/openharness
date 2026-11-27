---
name: root-cause-first
description: "Use when encountering any bug, test failure or unexpected behavior, before proposing a fix. You MUST find the root cause before any change to the code: reproduce the failure, trace it to where it starts, and test one hypothesis at a time. A fix without a known cause is a guess."
---

Reproduce the failure reliably and write the exact steps down. Read the error and the stack trace in full. Trace the bad value back to where it was first wrong, form one hypothesis, and test it with the smallest change or probe. After three failed hypotheses, step back and question the architecture rather than trying a fourth patch.
