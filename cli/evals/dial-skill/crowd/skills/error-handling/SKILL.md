---
name: error-handling
description: "Use when writing code that can fail: network calls, file access, parsing, user input. Handles each failure where something useful can be done, adds context when rethrowing, never swallows an error silently, and gives every timeout and retry a bound."
---

For each call, know what failure means and who can act on it. Catch only where you can recover or add context; otherwise let it propagate. Wrap errors with what was being done and keep the original as the cause. Test the error paths, not only the happy one.
