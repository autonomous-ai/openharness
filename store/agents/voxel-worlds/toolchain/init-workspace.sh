#!/bin/sh
# Harness copies the template before this runs. Preserve the user's design log on repeat calls.
set -eu
ws="${1:-$PWD}"
mkdir -p "$ws/world" "$ws/.harness"
if [ ! -f "$ws/world/DESIGN.md" ]; then
  printf '# Design log — Voxel Worlds\n\nRecord date, USER or AI, decision, rationale, and whether it remains in the build.\n' > "$ws/world/DESIGN.md"
fi
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":false,"summary":"Tidelands world studio — describe a place you want to build","artifact":"world/index.html","findings":[{"severity":"info","kind":"review_pending","message":"The harbor is an authored example. Your world needs original geometry, walking and export review."}],"phases":[{"id":"build","name":"Build","state":"active"},{"id":"verify","name":"Verify","state":"pending"}],"updatedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
JSON
printf 'initialized by %s\n' "${HARNESS_DSH:-autonomous/voxel-worlds}" > "$ws/.harness-initialized"
