#!/usr/bin/env bash
set -euo pipefail

DESKTOP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for command in docker node tmux flutter; do
  command -v "$command" >/dev/null || { echo "Missing tool: $command" >&2; exit 69; }
done
for package in cli backend; do
  [[ -x "$DESKTOP_ROOT/../$package/node_modules/.bin/tsx" ]] || {
    echo "Run npm ci in $package first." >&2; exit 69;
  }
done
# HARNESS_E2E_DOCKER_CONTEXT optionally selects an existing test Docker context.
# The fixture owns its containers, auth, ports, workspace and dedicated tmux socket.
cd "$DESKTOP_ROOT"
HARNESS_STACK_CLI_ROOT="$DESKTOP_ROOT/../cli" \
  flutter test --no-pub test/local_stack_e2e_test.dart --reporter expanded
