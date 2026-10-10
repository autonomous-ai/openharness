#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace): write the first verdict so the pane header says
# something true before the agent's first turn.
set -euo pipefail
: "${HARNESS_DSH_DIR:?}"
mkdir -p .harness
node --disable-warning=ExperimentalWarning --input-type=module -e "
const { snapshot, writeVerdict } = await import(process.argv[1] + '/lib/state.mjs')
writeVerdict(process.cwd(), await snapshot())
" "$HARNESS_DSH_DIR" >/dev/null 2>&1 || true
