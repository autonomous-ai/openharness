#!/bin/sh
# Runs once in a fresh workspace (cwd = the workspace) after the template copy.
set -u
mkdir -p .harness
cat > .harness/verdict.json <<'JSON'
{ "spec": 1, "ready": false, "summary": "Quantum workspace ready — describe a circuit to simulate",
  "findings": [], "artifact": null, "updatedAt": "2026-09-18T00:00:00Z" }
JSON
printf 'Quantum workspace initialized by %s\n' "${HARNESS_DSH:-quantum-studio}" > .harness-initialized
if [ -f circuit.json ]; then
  script_dir="$(CDPATH= cd "$(dirname "$0")" && pwd)"
  node "$script_dir/../skills/quantum/scripts/build.mjs"
fi
