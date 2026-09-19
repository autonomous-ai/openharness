#!/bin/sh
# Runs once in a fresh workspace (cwd = the workspace) after the template copy.
set -u
mkdir -p .harness
cat > .harness/verdict.json <<'JSON'
{ "spec": 1, "ready": false, "summary": "Orca Slicer workspace ready — describe a part to print",
  "findings": [], "artifact": null, "updatedAt": "2026-09-18T00:00:00Z" }
JSON
printf 'Orca Slicer workspace initialized by %s\n' "${HARNESS_DSH:-orca-slicer}" > .harness-initialized
