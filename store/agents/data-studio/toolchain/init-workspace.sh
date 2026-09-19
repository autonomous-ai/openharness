#!/bin/sh
# Runs once in a fresh workspace (cwd = the workspace) after the template copy.
set -u
mkdir -p .harness
cat > .harness/verdict.json <<'JSON'
{ "spec": 1, "ready": false, "summary": "Data Studio workspace ready — open data.csv and tell me the view you want",
  "findings": [], "artifact": null, "updatedAt": "2026-09-18T00:00:00Z" }
JSON
printf 'Data Studio workspace initialized by %s\n' "${HARNESS_DSH:-data-studio}" > .harness-initialized
