#!/usr/bin/env bash
# One About You build by OpenCode with <model>, in a made-up home (make-person.mjs), as Harness runs it:
# the package's AGENTS.md, its about-you skill, automatic approvals. Nothing on this computer is read
# or written outside eval/runs/<label>. Usage: eval/run-opencode.sh opencode/space-bunny-free <label>
set -uo pipefail
model="$1"; label="$2"
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
run="$here/runs/$label"
rm -rf "$run"; mkdir -p "$run/ws/.harness"
H="$run/home"; mkdir -p "$H"
node "$here/make-person.mjs" "$H" > "$run/person.txt"
cp "$pkg/template/NOTES.md" "$run/ws/"
{ cat "$pkg/AGENTS.md"; printf '\n## Skills\n\n- about-you: read %s/skills/about-you/SKILL.md before building or updating About You.\n' "$pkg"; } > "$run/ws/AGENTS.md"
cat > "$run/ws/opencode.json" <<'JSON'
{ "$schema": "https://opencode.ai/config.json", "permission": { "edit": "allow", "bash": "allow", "webfetch": "deny", "external_directory": "allow" } }
JSON
start=$(date +%s)
( cd "$run/ws" && env HOME="$H" ADAPTER_DATA_DIR="$H/.harness/cli/data" MEMORIES_HOME="$H/.harness/memory" \
    MEM_CLI="$pkg/toolchain/mem" MEMORIES_DSH_DIR="$pkg" \
    timeout 1500 "${OPENCODE:-opencode}" run --model "$model" "Build my About You." ) > "$run/log.txt" 2>&1
echo "exit $? · $(( $(date +%s) - start ))s" | tee "$run/time.txt"
node "$here/score.mjs" "$H/.harness/memory/about-you.md"
