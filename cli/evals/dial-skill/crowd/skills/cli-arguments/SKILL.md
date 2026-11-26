---
name: cli-arguments
description: "Use when adding commands or flags to a command-line tool: consistent flag names, short help text with an example, clear errors for bad input with the exit code set, machine-readable output on request, and tests that run the built binary with real arguments and check both its output and its exit code."
---

Follow the existing naming of commands and flags. Validate arguments up front and print what was wrong and the correct form. Exit non-zero on failure. Offer a --json output for scripts. Keep the help text short and update it in the same change.
