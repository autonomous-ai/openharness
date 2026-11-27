# Harness's runtime folder, as the daemon resolves it: on Linux it is in the XDG state root unless the XDG
# data root lacks the marker (.harness-root) and ~/.harness exists; a base that is not an absolute path is
# ignored, and a trailing slash dropped. A relative ADAPTER_RUNTIME_DIR is under the home, as the CLI reads it: a setup
# runs in its package.
local_ai_runtime_dir() {
  case "${ADAPTER_RUNTIME_DIR:-}" in
    '') ;;
    /*) printf '%s\n' "$ADAPTER_RUNTIME_DIR"; return ;;
    *) printf '%s\n' "$HOME/$ADAPTER_RUNTIME_DIR"; return ;;
  esac
  if [ "$(uname -s)" = Linux ]; then
    case "${XDG_DATA_HOME:-}" in /*) local_ai_data="${XDG_DATA_HOME%/}/harness" ;; *) local_ai_data="$HOME/.local/share/harness" ;; esac
    case "${XDG_STATE_HOME:-}" in /*) local_ai_state="${XDG_STATE_HOME%/}/harness" ;; *) local_ai_state="$HOME/.local/state/harness" ;; esac
    if [ -f "$local_ai_data/.harness-root" ] || [ ! -e "$HOME/.harness" ]; then printf '%s\n' "$local_ai_state/runtime"; return; fi
  fi
  printf '%s\n' "$HOME/.harness/runtime"
}
# local_ai_node_dir RECORDED — the folder of the Node a current-node names, as this shell reads paths. Windows writes
# it as C:\…\node.exe with a CRLF (install.ps1, selfUpdate.ts), which ${x%/*} cannot cut: Ollama's, vLLM's and
# MLX-LM's viewer, setup and doctor stopped in Git Bash on a computer whose own Node is older. These packages install
# alone and carry no runtimes.sh, so this is its own copy of _harness_node_dir's rule, in POSIX sh, calling no program
# for a path that is not a drive letter's.
local_ai_node_dir() {
  local_ai_node_path="${1%"$(printf '\r')"}"
  case "$local_ai_node_path" in
    [A-Za-z]:[\\/]*)
      if command -v cygpath >/dev/null 2>&1; then local_ai_node_path="$(cygpath -u "$local_ai_node_path")"
      else local_ai_node_path="/$(printf %s "${local_ai_node_path%%:*}" | tr '[:upper:]' '[:lower:]')$(printf %s "${local_ai_node_path#?:}" | tr '\\' /)"; fi ;;
  esac
  printf '%s\n' "${local_ai_node_path%/*}"
}
# Use this Mac's Node or the interpreter managed by Harness, including GUI launches.
local_ai_node_candidate="$(command -v node 2>/dev/null || true)"
if [ -n "$local_ai_node_candidate" ] && "$local_ai_node_candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
  LOCAL_AI_NODE="$local_ai_node_candidate"
else
  local_ai_node_record="$(local_ai_runtime_dir)/current-node"
  local_ai_node_candidate="$(cat "$local_ai_node_record" 2>/dev/null || true)"
  if [ -n "$local_ai_node_candidate" ]; then
    local_ai_node_candidate="$(local_ai_node_dir "$local_ai_node_candidate")/node"
    [ -x "$local_ai_node_candidate" ] || local_ai_node_candidate="$local_ai_node_candidate.exe"
  fi
  if [ -n "$local_ai_node_candidate" ] && [ -x "$local_ai_node_candidate" ] && "$local_ai_node_candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
    LOCAL_AI_NODE="$local_ai_node_candidate"
  else
    echo 'miss Node.js 22 or newer — update Harness or install Node.js 22' >&2
    return 1
  fi
fi
export LOCAL_AI_NODE
