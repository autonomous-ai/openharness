---
name: test-fixtures
description: "Use when tests need sample data: builds small factories and fixtures that create valid objects with sensible defaults, lets each test override only the fields it cares about, and keeps shared fixtures free of state that leaks between tests."
---

Write one factory per model that returns a valid object with defaults, and let a test pass the fields it checks. Prefer building data in the test over large shared fixture files. Reset databases and clocks between tests, and give generated ids a fixed seed so failures reproduce.
