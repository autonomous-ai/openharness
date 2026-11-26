---
name: sql-query-tuning
description: "Use when a database query is slow or a page makes too many queries: reads the query plan, adds or adjusts indexes for the filters and sort order, removes N+1 patterns with joins or batched loads, and measures the query time before and after."
---

Capture the exact query and its parameters, run EXPLAIN ANALYZE on realistic data, and look for sequential scans on large tables and sorts that spill. Add the narrowest index that serves the filter and the order. Replace per-row queries in loops with one batched query. Keep the numbers in the pull request.
