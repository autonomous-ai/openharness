---
name: data-backfills
description: "Use when existing rows need new or corrected values: writes an idempotent backfill that runs in batches, can be stopped and resumed, reports progress, and is checked on a copy of production-sized data before it runs for real."
---

Select rows by a stable cursor, update a bounded batch, commit, and move on. Make each batch safe to run twice. Log progress as counts. Throttle so normal traffic keeps its latency. Verify the result with a query that counts rows still wrong, which ends at zero.
