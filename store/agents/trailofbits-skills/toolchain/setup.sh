#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Everything lands in this package, nothing on the
# machine: Trail of Bits' plugins at the pinned commit (upstream/), a Python 3.12 venv with the
# semgrep and pip-audit their skills run (.venv/), bin/ — the one directory the agent puts in front
# of PATH for those tools, uv and python3 — and playwright-core for the PDF report (node_modules/),
# with a headless Chromium only when this machine has no Chrome (browsers/).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
. ./VERSIONS
toolchain/fetch-upstream.sh
harness_venv .venv 3.12 3.10 || exit 1
echo "     installing semgrep ${SEMGREP_VERSION} and pip-audit ${PIP_AUDIT_VERSION} (a minute or two the first time)"
harness_pip .venv "semgrep==${SEMGREP_VERSION}" "pip-audit==${PIP_AUDIT_VERSION}" || exit 1
harness_uv || exit 1
rm -rf bin && mkdir bin
ln -s ../.venv/bin/semgrep bin/semgrep
ln -s ../.venv/bin/pip-audit bin/pip-audit
ln -s ../.venv/bin/python bin/python3
ln -s "$(command -v uv)" bin/uv
echo "ok   bin/: semgrep $(bin/semgrep --version 2>/dev/null) · pip-audit · uv · python3"
harness_node 20 || exit 1
npm ci --no-audit --no-fund --loglevel=error >/dev/null || { echo "miss npm ci failed in $PWD"; exit 1; }
node toolchain/report.mjs --browser --install
