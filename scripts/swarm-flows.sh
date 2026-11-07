#!/usr/bin/env bash
# The Swarm flows (desktop/test/swarm_flows/): every Swarm feature clicked through in the real Desktop screens,
# headless, against the real backend and daemon of scripts/swarm-flows-stack.mts. The Desktop release gate
# (.github/workflows/release-desktop.yml, job swarm-flows) and PR CI run it; so can anyone, from the repo root:
#
#   bash scripts/swarm-flows.sh [desktop/test/swarm_flows/<file>_test.dart ...]
#
# Exits non-zero when a flow fails, after one "FAILED FLOW: <name>" line per failing flow and what it said.
# Needs flutter, node, tmux and the backend's and CLI's npm dependencies. HARNESS_E2E_SERVICES_DIR may name a
# folder that already has mongodb-memory-server and redis-memory-server (HARNESS_E2E_MONGOD and
# HARNESS_E2E_REDIS_SERVER may name their binaries); otherwise scripts/swarm-flows-services/ is installed from its
# lockfile into a temporary folder.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLUTTER="${FLUTTER:-flutter}"
work="$(mktemp -d "${TMPDIR:-/tmp}/swarm-flows.XXXXXX")"
trap 'rm -rf "$work"' EXIT

if [ -z "${HARNESS_E2E_SERVICES_DIR:-}" ]; then
  export HARNESS_E2E_SERVICES_DIR="$work/services"
  mkdir -p "$HARNESS_E2E_SERVICES_DIR"
  cp "$ROOT/scripts/swarm-flows-services/package.json" "$ROOT/scripts/swarm-flows-services/package-lock.json" \
    "$HARNESS_E2E_SERVICES_DIR/"
  (cd "$HARNESS_E2E_SERVICES_DIR" && npm ci --no-audit --no-fund --silent)
fi
export HARNESS_SWARM_FLOWS_CLI_ROOT="$ROOT/cli"

files=()
for path in "$@"; do files+=("${path#desktop/}"); done
[ "${#files[@]}" -gt 0 ] || files=(test/swarm_flows)

# Runs the flows in [files], reports them, and lists in $work/retry the files that only failed to start.
run() {
  local attempt="$1" status=0
  shift
  (cd "$ROOT/desktop" && "$FLUTTER" test --no-pub --concurrency=2 --reporter=json "$@") >"$work/report.jsonl" || status=$?
  python3 - "$work/report.jsonl" "$work/retry" "$attempt" <<'PY' || status=1
import json, sys
# Flutter's own startup failure, not a flow's: scripts/test-desktop.py retries a file once for it too.
LOADER = 'Unable to connect to flutter_tester process: WebSocketException: Invalid WebSocket upgrade request'
names, errors, failed, starting, passed = {}, {}, [], [], 0
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    try:
        event = json.loads(line)
    except ValueError:
        continue
    if not isinstance(event, dict):
        continue
    kind = event.get('type')
    if kind == 'testStart':
        names[event['test']['id']] = event['test']['name'].split(' (variant:')[0]
    elif kind in ('error', 'print'):
        # A widget test's exception arrives as printed lines; its error event only says "see above".
        text = (event.get('error') if kind == 'error' else event.get('message')) or ''
        if 'See exception logs above' not in text:
            errors.setdefault(event.get('testID'), []).append(text.strip())
    elif kind == 'testDone' and not event.get('hidden'):
        if event.get('result') == 'success' and not event.get('skipped'):
            passed += 1
        elif event.get('result') != 'success':
            test = event['testID']
            loading = names.get(test, '').startswith('loading ')
            (starting if loading and LOADER in ' '.join(errors.get(test, [])) else failed).append(test)
retry = [names[t][len('loading '):] for t in starting] if not failed and sys.argv[3] == 'first' else []
open(sys.argv[2], 'w').write(''.join(path + '\n' for path in retry))
# Each failing flow by name, then what it said: what it waited for, or what the app showed.
for test in failed + ([] if retry else starting):
    print(f'FAILED FLOW: {names.get(test, "?")}')
    for error in errors.get(test, []):
        print('    ' + error[:3000].replace('\n', '\n    '))
print(f'Swarm flows: {passed} passed, {len(failed) + (0 if retry else len(starting))} failed'
      + (f', {len(retry)} to start again' if retry else ''))
sys.exit(1 if failed or starting else 0)
PY
  return "$status"
}

status=0
run first "${files[@]}" || status=$?
if [ "$status" -ne 0 ] && [ -s "$work/retry" ]; then
  again=()
  while IFS= read -r path; do again+=("$path"); done <"$work/retry"
  if [ "${#again[@]}" -gt 0 ]; then
    echo "Flutter did not start ${#again[@]} test file(s); running them once more."
    status=0
    run last "${again[@]}" || status=$?
  fi
fi
exit "$status"
