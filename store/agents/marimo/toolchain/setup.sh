#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. One venv with the pinned marimo and the libraries a
# notebook reaches for first (numpy, pandas, polars, altair, matplotlib, duckdb, pyarrow). marimo wants
# Python 3.10+ and duckdb and pyarrow have wheels up to 3.14, so the venv is on 3.12 whatever this
# machine has (uv downloads it when it is not here); a venv already on 3.10–3.14 is kept.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
VERSION="$(cat MARIMO_VERSION)"
harness_venv .venv 3.12 3.10 3.15 || exit 1
echo "     installing marimo ${VERSION} and the usual libraries (a minute or two)"
harness_pip .venv "marimo==${VERSION}" numpy pandas polars altair matplotlib duckdb pyarrow
echo "ok   marimo $(.venv/bin/marimo --version 2>/dev/null | tail -1)"
