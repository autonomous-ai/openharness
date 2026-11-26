---
name: caching-strategy
description: "Use when adding a cache in front of slow work: keys on every input of the result, says how long entries live and when they go stale, bounds the cache size, and measures the hit rate so the cache earns its complexity."
---

Cache only what is measured as slow and read often. Key on every input that changes the result. Write down when an entry stops being served. Bound the size with an eviction policy. Guard against a stampede when a popular entry expires, and log the hit rate.
