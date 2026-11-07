#!/usr/bin/env bash
# The Swarm flows (desktop/test/swarm_flows/): every Swarm feature clicked through in the real Desktop screens,
# headless, against the real backend and daemon of scripts/swarm-flows-stack.mts. The Desktop release gate
# (.github/workflows/release-desktop.yml, job swarm-flows) and PR CI run it; so can anyone, from the repo root:
#
#   bash scripts/swarm-flows.sh [desktop/test/swarm_flows/<file>_test.dart ...]
#
# Exits non-zero when a flow fails, after one "FAILED FLOW: <name>" line per failing flow.
# Needs flutter, node, tmux and the backend's and CLI's npm dependencies. HARNESS_E2E_SERVICES_DIR may name a
# folder that already has mongodb-memory-server and redis-memory-server (HARNESS_E2E_MONGOD and
# HARNESS_E2E_REDIS_SERVER may name their binaries); otherwise they are installed into a temporary folder.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLUTTER="${FLUTTER:-flutter}"
work="$(mktemp -d "${TMPDIR:-/tmp}/swarm-flows.XXXXXX")"
trap 'rm -rf "$work"' EXIT

if [ -z "${HARNESS_E2E_SERVICES_DIR:-}" ]; then
  export HARNESS_E2E_SERVICES_DIR="$work/services"
  mkdir -p "$HARNESS_E2E_SERVICES_DIR"
  (cd "$HARNESS_E2E_SERVICES_DIR" && npm init -y >/dev/null &&
    npm install --no-audit --no-fund --silent mongodb-memory-server@11.2.0 redis-memory-server@0.17.1)
fi
export HARNESS_SWARM_FLOWS_CLI_ROOT="$ROOT/cli"

files=()
for path in "$@"; do files+=("${path#desktop/}"); done
[ "${#files[@]}" -gt 0 ] || files=(test/swarm_flows)

status=0
(cd "$ROOT/desktop" && "$FLUTTER" test --no-pub --concurrency=2 --reporter=json "${files[@]}") >"$work/report.jsonl" || status=$?
python3 - "$work/report.jsonl" <<'PY'
import json, sys
names, failed, passed = {}, [], 0
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    try:
        event = json.loads(line)
    except ValueError:
        continue
    if not isinstance(event, dict):
        continue
    if event.get('type') == 'testStart':
        names[event['test']['id']] = event['test']['name']
    elif event.get('type') == 'testDone' and not event.get('hidden'):
        if event.get('result') == 'success' and not event.get('skipped'):
            passed += 1
        elif event.get('result') != 'success':
            failed.append(names.get(event['testID'], '?').split(' (variant:')[0])
    elif event.get('type') == 'error':
        print(event.get('error', '').strip()[:4000], file=sys.stderr)
for name in failed:
    print(f'FAILED FLOW: {name}')
print(f'Swarm flows: {passed} passed, {len(failed)} failed')
PY
exit "$status"
