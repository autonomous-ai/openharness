#!/bin/sh
set -u
mkdir -p .harness
cat > .harness/verdict.json <<'JSON'
{ "spec": 1, "ready": false, "summary": "Web workspace ready — describe a page to build",
  "findings": [], "artifact": "index.html", "updatedAt": "2026-09-18T00:00:00Z" }
JSON
printf 'Web workspace initialized by %s\n' "${HARNESS_DSH:-web-studio}" > .harness-initialized
