---
name: rate-limiting
description: "Use when an endpoint or a worker needs protection from bursts: counts requests in a token bucket or sliding window, limits per client and globally, returns 429 with a Retry-After header, and keeps clients from all coming back in lockstep."
---

Count requests per limited unit in the shared store the service already uses. Return the limit and the remaining budget in headers, and 429 with Retry-After once it is spent. Clients wait as Retry-After says and give up after a bounded number of attempts.
