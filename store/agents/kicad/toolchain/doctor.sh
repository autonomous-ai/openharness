#!/usr/bin/env bash
# The package's own doctor, run against the fetched copy. cwd = the install dir.
# The copy at the pin, the venv, the vendored KiCad, then the KiCad package's doctor: engine CLI,
# node, kicadpy on the venv, kicad-cli and pcbnew (the vendored ones), Freerouting, the viewer.
set -uo pipefail
cd "$(dirname "$0")/.."
. ./VERSIONS
. toolchain/runtimes.sh
. toolchain/kicad.sh
if [ ! -f upstream/.harness-commit ]; then
  echo "miss autonomous-circuit is not fetched — run toolchain/setup.sh"; exit 1
fi
[ "$(cat upstream/.harness-commit)" = "${UPSTREAM_COMMIT}" ] \
  && echo "ok   autonomous-circuit @ ${UPSTREAM_COMMIT:0:12} (KiCad, v2 branch)" \
  || echo "warn autonomous-circuit @ $(cut -c1-12 upstream/.harness-commit), VERSIONS pins ${UPSTREAM_COMMIT:0:12} — run toolchain/setup.sh"
harness_node 22.12 >/dev/null || true
venv=0
.venv/bin/python -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1 \
  || { echo "miss .venv (the pipeline's Python >= 3.10) — run toolchain/setup.sh"; venv=1; }
kicad=0
have="$(harness_kicad_version || true)"
if [ "$have" = "$KICAD_VERSION" ]; then
  echo "ok   KiCad $have vendored at kicad/KiCad.app"
else
  echo "miss KiCad $KICAD_VERSION is not vendored (have '${have:-none}') — run toolchain/setup.sh"; kicad=1
fi
[ -x upstream/harness/kicad/toolchain/doctor.sh ] || { echo "miss upstream/harness/kicad/toolchain/doctor.sh"; exit 1; }
CIRCUIT_TOOLCHAIN="${CIRCUIT_TOOLCHAIN:-$PWD/upstream/toolchain}" CIRCUIT_PYTHON="${CIRCUIT_PYTHON:-$PWD/toolchain/python}" \
  KICADPY_CLI="${KICADPY_CLI:-$KICAD_CLI}" KICADPY_PYTHON="${KICADPY_PYTHON:-$KICAD_PYTHON}" CIRCUIT_KICAD_CLI="${CIRCUIT_KICAD_CLI:-$KICAD_CLI}" \
  upstream/harness/kicad/toolchain/doctor.sh
code=$?
exit $((code ? code : venv ? venv : kicad))
