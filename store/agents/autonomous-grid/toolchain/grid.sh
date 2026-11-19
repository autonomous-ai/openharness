#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
export GRID_NO_UPDATE_CHECK=1
# Same priority as Harness: explicit override, managed runtime, package fallback, user's CLI.
if [ -n "${HARNESS_GRID_BIN:-}" ]; then exec "$HARNESS_GRID_BIN" "$@"; fi
# Harness's runtime folder, as the daemon resolves it: on Linux it is in the XDG state root unless the XDG
# data root lacks the marker (.harness-root) and ~/.harness exists; a base that is not an absolute path is
# ignored, and a trailing slash dropped, so the path matches the one the daemon recorded.
harness_runtime() {
  if [ -n "${ADAPTER_RUNTIME_DIR:-}" ]; then printf '%s\n' "$ADAPTER_RUNTIME_DIR"; return; fi
  if [ "$(uname -s)" = Linux ]; then
    local data state
    case "${XDG_DATA_HOME:-}" in /*) data="${XDG_DATA_HOME%/}/harness" ;; *) data="$HOME/.local/share/harness" ;; esac
    case "${XDG_STATE_HOME:-}" in /*) state="${XDG_STATE_HOME%/}/harness" ;; *) state="$HOME/.local/state/harness" ;; esac
    if [ -f "$data/.harness-root" ] || [ ! -e "$HOME/.harness" ]; then printf '%s\n' "$state/runtime"; return; fi
  fi
  printf '%s\n' "$HOME/.harness/runtime"
}
runtime="$(harness_runtime)"
recorded="$(cat "$runtime/current-grid" 2>/dev/null || true)"
case "$recorded" in "$runtime"/*)
  if [ -x "$recorded" ]; then exec "$recorded" "$@"; fi ;;
esac
if [ -x "$here/.venv/bin/grid" ]; then exec "$here/.venv/bin/grid" "$@"; fi
if command -v grid >/dev/null 2>&1; then exec grid "$@"; fi
if [ -x "${HOME}/.local/bin/grid" ]; then exec "${HOME}/.local/bin/grid" "$@"; fi
echo 'Grid is not installed on this computer. Run `harness grid setup`.' >&2
exit 127
