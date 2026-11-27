---
name: verify-before-done
description: "Use when about to claim that work is complete, fixed or passing, before committing or opening a pull request. You MUST run the verification commands and read their output before any success claim. Evidence before assertions, always: a claim without a fresh run behind it is not made."
---

Name the command that proves the claim, run it now, and read the whole output, not the last line. Quote the result in the summary: the test count, the exit code, the build status. If the run shows a failure, the work is not done, whatever caused it. A run from before the last edit does not count.
