#!/usr/bin/env bash
# The project's own doctor, run against the fetched copy. cwd = the install dir. It looks for node and
# a python >= 3.10 on PATH; both are handed to it the way setup made them: Harness's Node when the
# machine has none, and the wrapper's .venv as CIRCUIT_PYTHON.
set -uo pipefail
cd "$(dirname "$0")/.."
. ./VERSIONS
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
if [ ! -f upstream/.harness-commit ]; then
  echo "miss autonomous-circuit is not fetched — run toolchain/setup.sh"; exit 1
fi
[ "$(cat upstream/.harness-commit)" = "${UPSTREAM_COMMIT}" ] \
  && echo "ok   autonomous-circuit @ ${UPSTREAM_COMMIT:0:12}" \
  || echo "warn autonomous-circuit @ $(cut -c1-12 upstream/.harness-commit), VERSIONS pins ${UPSTREAM_COMMIT:0:12} — run toolchain/setup.sh"
# The project's own node line says it when there is none.
harness_node 22.12 >/dev/null || true
venv=0
.venv/bin/python -c 'import numpy' >/dev/null 2>&1 \
  || { echo "miss .venv with numpy (the board pipeline's Python) — run toolchain/setup.sh"; venv=1; }
HARNESS_DSH_DIR="$PWD/upstream" CIRCUIT_TOOLCHAIN="${CIRCUIT_TOOLCHAIN:-$PWD/upstream/toolchain}" \
  CIRCUIT_PYTHON="${CIRCUIT_PYTHON:-$PWD/toolchain/python}" upstream/harness/toolchain/doctor.sh
code=$?
exit $((code ? code : venv))
