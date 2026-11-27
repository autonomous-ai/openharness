---
name: ci-pipelines
description: "Use when adding or changing a CI workflow: keeps jobs fast with caching and parallel steps, pins action versions, runs only the checks a change affects, and makes every failure name the step and the command that failed."
---

Cache dependency installs by lockfile hash. Split long suites into parallel jobs. Pin third-party actions to a full commit. Give jobs a timeout. Keep the workflow readable: one job per concern, and the same commands a developer runs locally.
