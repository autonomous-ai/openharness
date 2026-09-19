#!/bin/sh
set -u
mkdir -p .harness
cat > .harness/verdict.json <<'JSON'
{ "spec": 1, "ready": false, "summary": "GIS workspace ready — describe a map to make",
  "findings": [], "artifact": "index.html", "updatedAt": "2026-09-18T00:00:00Z" }
JSON
printf 'GIS workspace initialized by %s\n' "${HARNESS_DSH:-gis}" > .harness-initialized
