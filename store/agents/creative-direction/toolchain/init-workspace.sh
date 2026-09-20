#!/bin/sh
# Harness copies the template before this runs. Preserve the user's design log on repeat calls.
set -eu
ws="${1:-$PWD}"
mkdir -p "$ws/board" "$ws/.harness"
if [ ! -f "$ws/board/DESIGN.md" ]; then
  printf '# Design log — Creative Direction\n\nRecord date, USER or AI, decision, rationale, and whether it remains in the build.\n' > "$ws/board/DESIGN.md"
fi
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":false,"summary":"Forme brand studio — describe the business you want to launch","artifact":"board/index.html","findings":[{"severity":"info","kind":"review_pending","message":"The bakery is an authored example. Your brief needs original design and exported-output review."}],"phases":[{"id":"build","name":"Build","state":"active"},{"id":"verify","name":"Verify","state":"pending"}],"updatedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
JSON
printf 'initialized by %s\n' "${HARNESS_DSH:-autonomous/creative-direction}" > "$ws/.harness-initialized"
