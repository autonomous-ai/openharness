#!/bin/sh
# Runs once in a fresh workspace (cwd = the workspace) after the template copy.
# Seeds the first verdict so the pane header has something before the first prompt.
set -u
mkdir -p .harness
cat > .harness/verdict.json <<'JSON'
{ "spec": 1, "ready": false, "summary": "Score workspace ready — describe a piece to engrave",
  "findings": [], "artifact": null, "updatedAt": "2026-09-18T00:00:00Z" }
JSON
printf 'Score workspace initialized by %s\n' "${HARNESS_DSH:-score}" > .harness-initialized
