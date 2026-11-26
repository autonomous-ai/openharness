---
name: load-testing
description: "Use when checking how a service behaves under traffic: writes a load script with realistic requests and think time, ramps up in steps, records latency percentiles, error rate and resource use at each step, and finds the point where latency bends before production finds it."
---

Model the traffic from real logs: the mix of endpoints, payload sizes and pauses. Ramp in steps and hold each one long enough to settle. Report p50, p95 and p99, not averages. Watch CPU, memory, connections and queue depths on the server side, and stop at the first step that breaks the latency target.
