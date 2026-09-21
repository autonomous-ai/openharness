#!/bin/sh
# Runs once in a fresh workspace (cwd = the workspace) after the template copy.
set -u
mkdir -p .harness
cat > .harness/verdict.json <<'JSON'
{ "spec": 1, "ready": false, "summary": "Sheet & Docs workspace ready — tell me the document to write",
  "findings": [], "artifact": null, "updatedAt": "2026-09-18T00:00:00Z" }
JSON
printf 'Sheet & Docs workspace initialized by %s\n' "${HARNESS_DSH:-sheet-docs}" > .harness-initialized
