---
name: rate-limiting
description: "Use when an endpoint or a worker needs protection from bursts: picks token bucket or sliding window, limits per client and globally, returns 429 with a Retry-After header, and makes clients back off with jitter instead of retrying in lockstep."
---

Decide the unit being limited and the limit from measured capacity. Keep counters in the shared store the service already uses. Return the limit and remaining budget in headers. On the client side, retry with exponential backoff and jitter, and give up after a bounded number of attempts.
