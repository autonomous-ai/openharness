#!/bin/sh
# Preserve the person's source and design log on repeat initialization.
set -eu
ws="${1:-$PWD}"
mkdir -p "$ws/flight" "$ws/.harness"
if [ ! -f "$ws/flight/DESIGN.md" ]; then
  printf '# Survey decisions — Vector\n\nRecord date, USER or AI, supplied evidence, assumptions, decisions and preserved geometry.\n' > "$ws/flight/DESIGN.md"
fi
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":false,"summary":"Vector field studio — bring a site boundary and capture requirements","artifact":"flight/index.html","findings":[{"severity":"info","kind":"review_pending","message":"The orchard is example geometry. Supply a real boundary and camera, then review geometry, timing, exports and model limits."}],"phases":[{"id":"build","name":"Plan","state":"active"},{"id":"verify","name":"Verify","state":"pending"}]}
JSON
printf 'initialized by %s\n' "${HARNESS_DSH:-autonomous/drone-pilot}" > "$ws/.harness-initialized"
