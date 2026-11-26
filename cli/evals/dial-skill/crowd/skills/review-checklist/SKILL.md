---
name: review-checklist
description: "Use when reviewing a pull request or a diff, yours or a colleague's. Walks a fixed checklist: correctness, error paths, tests that fail first, naming, dead code, performance on hot paths and security of inputs. Produces findings ranked by severity with file and line for each."
---

Read the description, then the diff file by file. For each change ask whether it is correct, whether its errors are handled, whether a test covers it, and whether a simpler change would do. Rank findings as blocking, should fix or nit, and give each a file, a line and a one-line reason.
