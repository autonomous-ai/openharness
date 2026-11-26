---
name: shell-scripts
description: "Use when writing or fixing shell scripts: strict mode, quoted variables, checks for required tools, cleanup with traps, and a script that behaves the same on macOS and Linux or says plainly which it supports."
---

Start with set -euo pipefail. Quote every expansion. Check for each external command before using it. Use mktemp and a trap to clean up. Prefer portable flags, and run shellcheck before committing.
