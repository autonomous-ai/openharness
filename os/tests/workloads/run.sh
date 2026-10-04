#!/usr/bin/env bash
# Opt-in live-model acceptance. These projects and tools never enter the ISO.
set -uo pipefail
INPUTS=$(cd -- "$(dirname -- "$0")" && pwd)
WORK="$HOME/projects/os-workloads"
REPORT="$HOME/.local/state/harness-os/workloads"
# The disposable guest has no provider credentials. Exercise the bundled
# binary's upstream model choice, just as a clean first launch does.
mkdir -p "$WORK" "$REPORT"
if [[ -d "$INPUTS/seed" ]]; then
    cp -a "$INPUTS/seed/." "$WORK/"
    printf '%s\n' 'Reusing previously generated projects; acceptance runs again. The game agent runs only when explicitly requested.' > "$REPORT/reuse.txt"
fi
trap 'printf "%s\n" "$?" > "$REPORT/status"' EXIT
/usr/bin/opencode --version > "$REPORT/opencode-version.txt" || exit 1
printf '%s\n' 'Upstream default; no model flag or configuration override.' > "$REPORT/model.txt"
failed=0
for scenario in terminal-tool website game fullstack; do
    project="$WORK/$scenario"
    mkdir -p "$project"
    cp "$INPUTS/$scenario.txt" "$project/TASK.txt"
    cat > "$project/opencode.json" <<EOF
{"permission":{"question":"deny","task":"deny","external_directory":{"*":"deny","$HOME/projects/**":"allow","/tmp/opencode/**":"allow","/usr/share/harness-os/**":"allow"}}}
EOF
    printf '\nChecking %s with the upstream default model\n' "$scenario"
    if [[ -d "$INPUTS/seed" && ( "$scenario" != game || ! -e "$INPUTS/repair-game" ) ]]; then
        status=0
        printf '%s\n' 'Prior completed model turn reused; project checks run again.' > "$REPORT/$scenario-agent-reused.txt"
        # Dependencies are deliberately absent from the retained source artifact.
        if [[ "$scenario" == fullstack ]]; then
            (cd "$project" && npm ci --no-audit --no-fund) || exit 1
        fi
    else
      prompt='Read TASK.txt, implement the complete task, run its tests, and fix failures. Work now without questions or subagents. Browser acceptance runs separately with sandboxed system Chromium; finish after your unit tests and do not launch a browser or long-running server.'
      if [[ -d "$INPUTS/seed" ]]; then
          prompt='Read TASK.txt and the existing game. Perform ONE task: make the entire game and a compact, readable keyboard legend fit within both 1280x800 and 1024x768 viewports without scrolling or clipping. The legend may be drawn in the canvas or HTML; ensure all move, Space pause, R restart and Enter start controls are visible. Change only the layout or drawing necessary for that result. Preserve simulation and bridge behavior. Do not rewrite the game, broaden features, audit unrelated edge cases, or add test frameworks. Run node --test test.mjs, fix regressions from your change, then give your final answer and stop. An independent browser and rendered-pixel checker verifies layout. No questions or subagents.'
      fi
      (
        cd "$project" || exit 1
        timeout --signal=TERM --kill-after=15s 12m /usr/bin/opencode run --format json \
            "$prompt" \
            > "$REPORT/$scenario-agent.jsonl" 2>&1
    )
      status=$?
    fi
    printf '%s\n' "$status" > "$REPORT/$scenario-agent.status"
    # The agent's process exit alone is not evidence it made working software.
    (
        set -e
        cd "$project"
        case "$scenario" in
            terminal-tool)
                test -s logscope.py
                python3 -m unittest discover -v
                python3 "$INPUTS/check-cli.py" "$project/logscope.py"
                ;;
            website) test -s index.html; test -s app.js; node --check app.js; node --test test.mjs ;;
            game) test -s index.html; test -s game.mjs; node --check game.mjs; node --test test.mjs ;;
            fullstack) test -s package-lock.json; npm test ;;
        esac
    ) > "$REPORT/$scenario-checks.log" 2>&1
    check_status=$?
    printf '%s\n' "$check_status" > "$REPORT/$scenario-checks.status"
    if (( status || check_status )); then failed=1; fi
    printf '%s: agent=%s, checks=%s\n' "$scenario" "$status" "$check_status"
    tail -n 12 "$REPORT/$scenario-checks.log"
done
# Browser interaction and API persistence are checked independently of model-written tests.
mkdir -p "$WORK/qa"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefix "$WORK/qa" --no-audit --no-fund playwright \
    > "$REPORT/browser-install.log" 2>&1 || exit 1
cp "$INPUTS/check-browser.mjs" "$WORK/qa/check-browser.mjs"
node "$WORK/qa/check-browser.mjs" "$WORK" "$REPORT" > "$REPORT/browser-checks.log" 2>&1
browser_status=$?
printf '%s\n' "$browser_status" > "$REPORT/browser-checks.status"
cat "$REPORT/browser-checks.log"
if (( browser_status )); then failed=1; fi
exit "$failed"
