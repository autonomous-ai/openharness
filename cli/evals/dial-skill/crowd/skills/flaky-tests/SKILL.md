---
name: flaky-tests
description: "Use when a test passes and fails without a code change: reruns it in a loop to measure the failure rate, finds the shared state, timing or order dependence behind it, and fixes the cause instead of adding retries or longer sleeps."
---

Run the test alone and in the suite many times to measure how often it fails. Look for shared globals, real clocks, network calls, unordered collections and tests that depend on each other. Replace sleeps with waiting on the condition. A test is fixed when the loop runs clean.
