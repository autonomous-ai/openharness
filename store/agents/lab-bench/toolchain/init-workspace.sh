#!/bin/sh
# Preserve the person's source and design log on repeat initialization.
set -eu
ws="${1:-$PWD}"
mkdir -p "$ws/bench" "$ws/.harness"
if [ ! -f "$ws/bench/DESIGN.md" ]; then
  printf '# Experiment decisions — Signal\n\nRecord date, USER or AI, supplied evidence, assumptions, decisions and approved protocol, experimental units and actual evidence.\n' > "$ws/bench/DESIGN.md"
fi
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":false,"summary":"Signal experiment workshop — turn a question into a test you can carry out","artifact":"bench/index.html","findings":[{"severity":"info","kind":"review_pending","message":"The coffee plan contains no measured data. Adapt the factors and protocol, collect actual responses, and review the analysis and report."}],"phases":[{"id":"build","name":"Plan","state":"active"},{"id":"verify","name":"Verify","state":"pending"}]}
JSON
printf 'initialized by %s\n' "${HARNESS_DSH:-autonomous/lab-bench}" > "$ws/.harness-initialized"
