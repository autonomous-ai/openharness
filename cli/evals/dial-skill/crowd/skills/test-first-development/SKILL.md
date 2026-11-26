---
name: test-first-development
description: "Use when implementing any feature or bugfix, before writing implementation code. You MUST write a failing test first, run it and watch it fail for the expected reason, then write the minimal code that makes it pass. Code written before its test is deleted and written again from the test."
---

Red, green, refactor. Write one small test for one behavior, run it and read the failure; a test that passes at once tests nothing new. Write the least code that turns it green, run the whole file, then clean up names and duplication while it stays green. Repeat for the next behavior. Mocks only where a real dependency cannot run in a test.
