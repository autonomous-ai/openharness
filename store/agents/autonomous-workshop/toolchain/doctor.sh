#!/usr/bin/env bash
# The project's own doctor, run against the fetched copy. cwd = the install dir. It looks for uv and
# node on PATH; both are put there the way setup found them — the machine's own, else the pinned uv
# setup fetched and Harness's own Node.
set -uo pipefail
cd "$(dirname "$0")/.."
. ./VERSIONS
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
if [ ! -f upstream/.harness-commit ]; then
  echo "miss autonomous-workshop is not fetched — run toolchain/setup.sh"; exit 1
fi
[ "$(cat upstream/.harness-commit)" = "${UPSTREAM_COMMIT}" ] \
  && echo "ok   autonomous-workshop @ ${UPSTREAM_COMMIT:0:12}" \
  || echo "warn autonomous-workshop @ $(cut -c1-12 upstream/.harness-commit), VERSIONS pins ${UPSTREAM_COMMIT:0:12} — run toolchain/setup.sh"
# The project's own uv and node lines say it when there is none.
harness_uv >/dev/null || true
harness_node 20 >/dev/null || true
HARNESS_DSH_DIR="$PWD/upstream" exec upstream/harness/toolchain/doctor.sh
