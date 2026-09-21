#!/bin/sh
# Preserve the person's source and design log on repeat initialization.
set -eu
ws="${1:-$PWD}"
mkdir -p "$ws/game" "$ws/.harness"
if [ ! -f "$ws/game/DESIGN.md" ]; then
  printf '# Game decisions — Relay\n\nRecord date, USER or AI, supplied evidence, assumptions, decisions and approved rules, components and artwork.\n' > "$ws/game/DESIGN.md"
fi
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":false,"summary":"Relay game workshop — turn your idea into a game people can play","artifact":"game/index.html","findings":[{"severity":"info","kind":"review_pending","message":"Pocket Conservatory is an example game. Author the person’s mechanics and components, then play the actual game and review its physical kit."}],"phases":[{"id":"build","name":"Plan","state":"active"},{"id":"verify","name":"Verify","state":"pending"}]}
JSON
printf 'initialized by %s\n' "${HARNESS_DSH:-autonomous/game-master}" > "$ws/.harness-initialized"
