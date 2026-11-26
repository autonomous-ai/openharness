---
name: caching-strategy
description: "Use when adding a cache in front of slow work: chooses what to key on, how long entries live and how they are invalidated, bounds the cache size, and measures the hit rate so the cache earns its complexity."
---

Cache only what is measured as slow and read often. Key on every input that changes the result. Pick expiry or explicit invalidation and write down which. Bound the size with an eviction policy. Guard against a stampede when a popular entry expires, and log the hit rate.
