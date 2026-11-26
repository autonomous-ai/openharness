---
name: cpu-profiling
description: "Use when code is slower than expected or a hot path needs tuning: records a CPU profile under a realistic load, reads the flame graph for the widest frames, and measures before and after each change so a speedup is a number, not an impression."
---

Reproduce the slow case with a benchmark or a load script first and record the baseline. Profile with the runtime's own profiler, look for the widest self-time frames, and change one thing at a time. Rerun the benchmark after each change and keep only the changes that move the number.
