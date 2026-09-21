#!/usr/bin/env bash
OPENMONTAGE_PACKAGE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$OPENMONTAGE_PACKAGE/toolchain/runtimes.sh"
harness_node 22.12 || exit 1
export PATH="$OPENMONTAGE_PACKAGE/.venv/bin:$OPENMONTAGE_PACKAGE/.ffmpeg/bin:$PATH"
export PYTHONPATH="$OPENMONTAGE_PACKAGE/upstream${PYTHONPATH:+:$PYTHONPATH}"
export OPENMONTAGE_PROJECTS_DIR="${HARNESS_WORKSPACE:-$PWD}/projects"
export OPENMONTAGE_ROOT="$OPENMONTAGE_PACKAGE/upstream"
