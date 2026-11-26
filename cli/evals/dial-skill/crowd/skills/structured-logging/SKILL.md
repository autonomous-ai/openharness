---
name: structured-logging
description: "Use when adding or changing log lines: writes structured events with a stable event name and typed fields, uses the right level, keeps personal data and secrets out of every field, and makes each line useful to someone reading it during an outage."
---

Log events, not prose: a fixed name plus fields such as ids, counts and durations. Errors carry the failure class and what was being attempted. Info is for state changes worth seeing in production; debug is off there. Never log tokens, passwords, emails or request bodies.
