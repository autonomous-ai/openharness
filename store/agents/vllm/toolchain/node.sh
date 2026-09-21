# Use this Mac's Node or the interpreter managed by Harness, including GUI launches.
local_ai_node_candidate="$(command -v node 2>/dev/null || true)"
if [ -n "$local_ai_node_candidate" ] && "$local_ai_node_candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
  LOCAL_AI_NODE="$local_ai_node_candidate"
else
  local_ai_node_record="${ADAPTER_RUNTIME_DIR:-${HOME}/.harness/runtime}/current-node"
  local_ai_node_candidate="$(cat "$local_ai_node_record" 2>/dev/null || true)"
  if [ -n "$local_ai_node_candidate" ] && [ -x "${local_ai_node_candidate%/*}/node" ] && "${local_ai_node_candidate%/*}/node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
    LOCAL_AI_NODE="${local_ai_node_candidate%/*}/node"
  else
    echo 'miss Node.js 22 or newer — update Harness or install Node.js 22' >&2
    return 1
  fi
fi
export LOCAL_AI_NODE
