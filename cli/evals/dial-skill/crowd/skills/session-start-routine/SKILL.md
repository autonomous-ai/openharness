---
name: session-start-routine
description: "Use when starting any conversation, before any response or tool call, including clarifying questions. Establishes how to find and load the skills that fit the task. If there is even a small chance a skill applies to what you are doing, you MUST load it and follow it before anything else."
---

At the start of every task, list the skills whose descriptions match the request and load each one before acting. Process skills come first, because they decide how the work is done; implementation skills come second. A skill that turns out not to fit is dropped once read. Never skip this step because the task looks small: small tasks are where an overlooked rule costs the most.
