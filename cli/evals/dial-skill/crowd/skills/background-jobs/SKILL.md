---
name: background-jobs
description: "Use when moving work into a background job queue: makes each job idempotent, keeps payloads small with ids instead of objects, sets timeouts and a bounded retry with a pause, sends jobs that keep failing to a dead-letter queue, and records how long each job type takes."
---

Enqueue after the transaction commits, never inside it. Load fresh data by id when the job runs. Give each job type a timeout and a retry limit. A job that runs twice must leave the same result as one run. Track queue depth and job latency so a backlog is visible.
