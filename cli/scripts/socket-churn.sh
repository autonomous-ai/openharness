#!/usr/bin/env bash
# The WebSocket roadmap's scenario (cli/e2e/socketChurn.e2e.ts): one account's daemons, Desktop windows and
# browser tab on a local backend, measured by a recording proxy. Prints the checks and keeps the full report
# (per endpoint: connects a minute, lifetimes, close codes, selects and their answers; HTTP requests per route).
#
#   HARNESS_E2E_SERVICES_DIR=<dir with mongodb-memory-server and redis-memory-server> \
#     scripts/socket-churn.sh [minutes, default 3] [report.json, default a new file in the temp folder]
#
# A report path is read from where the script was called, never from cli/, so no report lands in the checkout.
# HARNESS_E2E_MONGOD / HARNESS_E2E_REDIS_SERVER point at system binaries instead of downloaded ones.
set -euo pipefail
: "${HARNESS_E2E_SERVICES_DIR:?must name a folder with mongodb-memory-server and redis-memory-server}"
export SOCKET_SCENARIO_MINUTES="${1:-3}"
report="${2:-$(mktemp "${TMPDIR:-/tmp}/socket-report.XXXXXX")}"
export SOCKET_REPORT_FILE="$(cd "$(dirname "$report")" && pwd)/$(basename "$report")"
cd "$(dirname "$0")/.."
status=0
npx vitest run --config vitest.e2e.config.ts e2e/socketChurn.e2e.ts || status=$?
echo "report: $SOCKET_REPORT_FILE"
exit "$status"
