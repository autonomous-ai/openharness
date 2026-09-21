#!/usr/bin/env bash
# Runs once at install, cwd = this directory. Makes the one venv the viewer runs from: the pinned
# `cadgen` release, which carries the CAD Viewer's server and built client (no Node at run time).
# `cadquery-ocp` comes with it — that is the OpenCascade the viewer tessellates STEP with. cadgen wants
# Python 3.11+ and cadquery-ocp has wheels for 3.11–3.14, so the venv is on 3.12 whatever this machine
# has (uv downloads it when it is not here); a venv already on 3.11–3.14 is kept.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=runtimes.sh
. ./runtimes.sh
CADGEN_VERSION="$(cat CADGEN_VERSION)"
harness_venv .venv 3.12 3.11 3.15 || exit 1
echo "     installing cadgen $CADGEN_VERSION (this pulls OpenCascade; a few minutes the first time)"
harness_pip .venv "cadgen==${CADGEN_VERSION}"
echo "ok   $(.venv/bin/cadgen --version 2>/dev/null || echo "cadgen $CADGEN_VERSION")"
# The doctor's check, once here: the first load of a fresh OpenCascade is slow on macOS (every new
# library is scanned once, minutes on a busy machine), and setup has the time a doctor or a pane has not.
echo "     loading OpenCascade once"
.venv/bin/python -c 'import build123d' || { echo "miss build123d (OpenCascade) does not load in .venv"; exit 1; }
echo "ok   build123d + OpenCascade"
# The client the pane serves (pane_client.py): the bundled one with its fetches kept on loopback.
if [ -n "$(.venv/bin/python pane_client.py 2>/dev/null)" ]; then echo "ok   pane client"; else echo "warn pane client not made — the pane serves the bundled client"; fi
