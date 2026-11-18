# Harness's runtime folder, as the daemon resolves it: on Linux it is in the XDG state root unless only
# ~/.harness exists; a base that is not an absolute path is ignored, and a trailing slash dropped.
local_ai_runtime_dir() {
  if [ -n "${ADAPTER_RUNTIME_DIR:-}" ]; then printf '%s\n' "$ADAPTER_RUNTIME_DIR"; return; fi
  if [ "$(uname -s)" = Linux ]; then
    case "${XDG_DATA_HOME:-}" in /*) local_ai_data="${XDG_DATA_HOME%/}/harness" ;; *) local_ai_data="$HOME/.local/share/harness" ;; esac
    case "${XDG_STATE_HOME:-}" in /*) local_ai_state="${XDG_STATE_HOME%/}/harness" ;; *) local_ai_state="$HOME/.local/state/harness" ;; esac
    if [ -e "$local_ai_data" ] || [ ! -e "$HOME/.harness" ]; then printf '%s\n' "$local_ai_state/runtime"; return; fi
  fi
  printf '%s\n' "$HOME/.harness/runtime"
}
# Use this Mac's Node or the interpreter managed by Harness, including GUI launches.
local_ai_node_candidate="$(command -v node 2>/dev/null || true)"
if [ -n "$local_ai_node_candidate" ] && "$local_ai_node_candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
  LOCAL_AI_NODE="$local_ai_node_candidate"
else
  local_ai_node_record="$(local_ai_runtime_dir)/current-node"
  local_ai_node_candidate="$(cat "$local_ai_node_record" 2>/dev/null || true)"
  if [ -n "$local_ai_node_candidate" ] && [ -x "${local_ai_node_candidate%/*}/node" ] && "${local_ai_node_candidate%/*}/node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
    LOCAL_AI_NODE="${local_ai_node_candidate%/*}/node"
  else
    echo 'miss Node.js 22 or newer — update Harness or install Node.js 22' >&2
    return 1
  fi
fi
export LOCAL_AI_NODE
