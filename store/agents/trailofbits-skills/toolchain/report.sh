#!/usr/bin/env bash
# $TOB_REPORT: rebuild the report from security-audit/findings.json and refresh the verdict. Run it
# in the workspace after every change to the findings; --pdf also prints security-audit/report.pdf.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=runtimes.sh
. "$here/runtimes.sh"
harness_node 20 >/dev/null || { echo "miss node 20 or newer"; exit 1; }
exec node "$here/report.mjs" "$PWD" "$@"
