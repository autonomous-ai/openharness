#!/usr/bin/env bash
# Opt-in live-model acceptance. These projects and tools never enter the ISO.
set -uo pipefail
INPUTS=$(cd -- "$(dirname -- "$0")" && pwd)
WORK="$HOME/Projects/os-workloads"
REPORT="$HOME/.local/state/harness-os/workloads"
MODEL=${HN_TEST_MODEL:-opencode/big-pickle}
export PATH="$HOME/.opencode/bin:$PATH"
case "$MODEL" in opencode/big-pickle|opencode/*-free) ;; *) echo 'Use an explicitly free OpenCode model.' >&2; exit 2 ;; esac
mkdir -p "$WORK" "$REPORT"
if [[ -d "$INPUTS/seed" ]]; then
    cp -a "$INPUTS/seed/." "$WORK/"
    printf '%s\n' 'Reusing previously generated projects; only the interrupted game agent runs again.' > "$REPORT/reuse.txt"
fi
trap 'printf "%s\n" "$?" > "$REPORT/status"' EXIT
opencode --version > "$REPORT/opencode-version.txt" || exit 1
printf '%s\n' "$MODEL" > "$REPORT/model.txt"
failed=0
for scenario in terminal-tool website game fullstack; do
    project="$WORK/$scenario"
    mkdir -p "$project"
    cp "$INPUTS/$scenario.txt" "$project/TASK.txt"
    cat > "$project/opencode.json" <<EOF
{"model":"$MODEL","permission":{"question":"deny","task":"deny","external_directory":{"*":"deny","$HOME/Projects/**":"allow","/tmp/opencode/**":"allow","/usr/share/harness-os/**":"allow"}}}
EOF
    printf '\nChecking %s with %s\n' "$scenario" "$MODEL"
    if [[ -d "$INPUTS/seed" && "$scenario" != game ]]; then
        status=0
        printf '%s\n' 'Prior completed model turn reused; project checks run again.' > "$REPORT/$scenario-agent-reused.txt"
        # Dependencies are deliberately absent from the retained source artifact.
        if [[ "$scenario" == fullstack ]]; then
            (cd "$project" && npm ci --no-audit --no-fund) || exit 1
        fi
    else
      (
        cd "$project" || exit 1
        timeout --signal=TERM --kill-after=15s 12m opencode run --model "$MODEL" --format json \
            'Read TASK.txt, implement the complete task, run its tests, and fix failures. Work now without questions or subagents. If a project already exists, finish and verify it. Browser acceptance runs separately with sandboxed system Chromium; finish after your unit tests and do not launch a browser or long-running server.' \
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
