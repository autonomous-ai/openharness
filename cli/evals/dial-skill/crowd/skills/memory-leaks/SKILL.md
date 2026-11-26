---
name: memory-leaks
description: "Use when a process grows in memory over time: takes heap snapshots under steady load, compares them to find the objects that accumulate, traces what still references them, and confirms the fix with a long run whose memory stays flat."
---

Reproduce the growth with a load script and record memory over time. Take two or three heap snapshots minutes apart and diff them by retained size. Follow the retainer chain to the listener, cache, timer or closure that holds on. Fix it, then run long enough to show the line stays flat.
