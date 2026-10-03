#!/usr/bin/env bash
# One line per thing the harness needs; exit 0 only when the audit can run. warn lines are tools a
# skill can do without.
set -uo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
. ./VERSIONS
export SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0
status=0
if [ "$(cat upstream/.harness-commit 2>/dev/null)" = "${UPSTREAM_COMMIT}" ]; then echo "ok   ${UPSTREAM_NAME} @ ${UPSTREAM_COMMIT:0:12}"
else echo "miss ${UPSTREAM_NAME} @ ${UPSTREAM_COMMIT:0:12} — run toolchain/setup.sh"; status=1; fi
for tool in semgrep pip-audit uv; do
  if version=$(bin/$tool --version 2>/dev/null); then echo "ok   $tool ${version#$tool }"; else echo "miss $tool — run toolchain/setup.sh"; status=1; fi
done
if ! harness_node 20 >/dev/null; then echo "miss node 20 or newer"; exit 1; fi
echo "ok   node $(node --version)"
missing=""
for dir in $(node -e 'for (const root of require("./harness.json").agent.skills) if (root.startsWith("upstream/")) console.log(root)'); do
  [ -n "$(find "$dir" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null)" ] || missing="$missing $(basename "$(dirname "$dir")")"
done
if [ -z "$missing" ]; then echo "ok   every plugin skill harness.json links is here"; else echo "miss plugin skills:$missing — run toolchain/setup.sh"; status=1; fi
node toolchain/report.mjs --browser
if command -v rg >/dev/null 2>&1; then echo "ok   ripgrep"; else echo "warn ripgrep not on PATH: rust-review falls back to grep -E"; fi
if command -v codeql >/dev/null 2>&1; then echo "ok   codeql $(codeql version --format=terse 2>/dev/null)"; else echo "warn CodeQL not installed: static-analysis runs Semgrep alone"; fi
exit $status
