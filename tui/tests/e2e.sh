#!/usr/bin/env bash
# End-to-end check of harness-tui against tests/mock-daemon.mjs — nothing real behind it, so it is
# safe to run anywhere (and to fuzz). Needs node (with cli/node_modules installed) and tmux.
#
#   cargo build --release && tui/tests/e2e.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="${HARNESS_TUI_BIN:-$here/../target/release/harness-tui}"
port="${E2E_PORT:-18997}"
sock="harness-tui-e2e-$$"
home="$(mktemp -d)"
tmux_() { tmux -L "$sock" "$@"; }
screen() { tmux_ capture-pane -p -t t; }
fail() { echo "✗ $1"; echo "--- screen ---"; screen || true; exit 1; }
expect() { # expect <what> <text> [timeout-ms]
  local waited=0 limit="${3:-3000}"
  until screen | grep -qF -- "$2"; do
    sleep 0.05; waited=$((waited + 50))
    [ "$waited" -ge "$limit" ] && fail "$1: \"$2\" never appeared"
  done
  echo "✓ $1"
}
cleanup() { tmux_ kill-server 2>/dev/null || true; kill "$mock" 2>/dev/null || true; rm -rf "$home"; }
trap cleanup EXIT

node "$here/mock-daemon.mjs" "$port" >/dev/null &
mock=$!
sleep 0.5
tmux_ new-session -d -s t -x 120 -y 32 "HOME=$home PORT=$port HARNESS_TUI_DESK=off HARNESS_TUI_NOTIFY=off $bin"

expect "home lists the fleet" "Mock Claude"
expect "status line, tmux-style" "0:home*"
tmux_ send-keys -t t C-b s
expect "C-b s opens the fzf list" "Search harnesses"
tmux_ send-keys -t t "codex"
expect "fuzzy filter narrows" "1/"
tmux_ send-keys -t t Enter
expect "pane streams the keyframe" "Mock Codex (mock)"
tmux_ send-keys -t t "echo-me"
expect "typing round-trips" "echo-me"
tmux_ send-keys -t t C-b ":"
expect "C-b : is the command prompt" ":"
tmux_ send-keys -t t "split-window -h" Enter
expect "split-window -h asks for a harness" "split-window -h"
tmux_ send-keys -t t "remote" Enter
expect "remote machine pane beside it" "Remote shell (mock)"
expect "pane titles, tmux pane-border-status" '"Remote shell"'
tmux_ send-keys -t t C-b o
tmux_ send-keys -t t C-b z
expect "C-b z zooms (Z flag)" "*Z"
tmux_ send-keys -t t C-b z
tmux_ send-keys -t t C-b I
expect "C-b I: models for the focused harness" "Sonnet / High"
tmux_ send-keys -t t Escape
tmux_ send-keys -t t C-b M
expect "C-b M: machines" "mock-remote"
tmux_ send-keys -t t Escape
tmux_ send-keys -t t C-b c
tmux_ send-keys -t t Escape
expect "C-b c: a new window" "1:"
tmux_ send-keys -t t C-b 0
expect "C-b 0: back to window 0" "0:Mock Codex*"
tmux_ send-keys -t t C-b w
expect "C-b w: choose-tree" "windows (attached)"
tmux_ send-keys -t t q
tmux_ send-keys -t t C-b x
expect "C-b x asks first" "(y/n)"
tmux_ send-keys -t t n
tmux_ resize-window -t t -x 30 -y 8
sleep 0.3
tmux_ resize-window -t t -x 120 -y 32
expect "survives a tiny window" "Mock Codex"
tmux_ send-keys -t t C-b d
sleep 0.5
tmux_ has-session -t t 2>/dev/null && screen | grep -q "Mock" && fail "C-b d did not detach"
echo "✓ C-b d detaches"
echo "all e2e checks passed"
