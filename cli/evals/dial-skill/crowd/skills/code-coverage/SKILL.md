---
name: code-coverage
description: "Use when reading or raising test coverage: runs the coverage report, looks at the uncovered branches in code that matters rather than the overall percentage, writes tests for real behavior in those branches, and keeps generated code and test helpers out of the numbers."
---

Open the per-file report and sort by uncovered lines in business logic. A missed branch in error handling or a boundary is worth a test; a getter is not. Write tests that assert outcomes, not lines executed. Exclude generated files from the report so the number means something.
