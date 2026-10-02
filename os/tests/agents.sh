#!/usr/bin/env bash
# Run only in the disposable installed VM as its ordinary user. No accounts or
# API calls: this checks that real vendor executables install and start here.
set -euo pipefail
export npm_config_prefix="$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
REPORT_DIR="$HOME/.local/state/harness-os/agent-check"
mkdir -p "$REPORT_DIR"
trap 'printf "%s\n" "$?" > "$REPORT_DIR/status"' EXIT
for row in 'claude @anthropic-ai/claude-code' 'codex @openai/codex' 'opencode opencode-ai'; do
    read -r executable package <<< "$row"
    npm install --global --no-audit --no-fund "$package"
    "$executable" --version | tee "$REPORT_DIR/$executable.txt"
done
npm install --global --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent
pi --version | tee "$REPORT_DIR/pi.txt"
npm ls --global --depth=0 --json > "$REPORT_DIR/packages.json"
printf '%s\n' 'Vendor installation and startup passed. Authenticated agent turns are a separate, unverified check.'
