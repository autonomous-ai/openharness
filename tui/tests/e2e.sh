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
# Its own client socket, named: the test's shell calls must never reach a client of yours
# (an unnamed hn takes "default", which is where `hn <command>` goes).
client="e2e-$$"
# HN_DESKTOP=off: no desktop app here, so hn is the window the dial talks to.
tmux_ new-session -d -s t -x 120 -y 32 "HN_SOCKET_NAME=$client HOME=$home PORT=$port HARNESS_TUI_DESK=off HARNESS_TUI_NOTIFY=off HN_DESKTOP=off $bin"
# The mock's dial: what hn told it (dial <js expression over d>), and a frame to push at hn.
dial() { curl -s "http://127.0.0.1:$port/test/dial" | node -e "const d = JSON.parse(require('fs').readFileSync(0, 'utf8')).data; console.log($1)"; }
push() { curl -s -X POST --data "$1" "http://127.0.0.1:$port/test/dial" >/dev/null; }
hn() { HOME=$home "$bin" -L "$client" "$@"; }
wait_eq() { # wait_eq <what> <expected> <command…>: until the command prints what is expected, 3s
  # (The command is run again each time: a `$(…)` in the arguments would be read only once.)
  local what="$1" want="$2" waited=0 got=""; shift 2
  until got="$("$@" 2>/dev/null)" && [ "$got" = "$want" ]; do sleep 0.05; waited=$((waited + 50)); [ "$waited" -ge 3000 ] && fail "$what (got '$got', want '$want')"; done
  echo "✓ $what"
}

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
# tmux's split: a shell at once, and what is typed straight after it lands in it.
tmux_ send-keys -t t "typed-ahead"
expect "split-window -h gives a shell" '"Mock terminal"'
expect "keys typed while it starts go into it" "typed-ahead"
tmux_ send-keys -t t C-b x y
tmux_ send-keys -t t C-b s
tmux_ send-keys -t t "remote"
tmux_ send-keys -t t C-v
expect "C-b s then C-v: a harness beside" "Remote shell (mock)"
expect "pane titles, tmux pane-border-status" '"Remote shell"'
# From a shell, as tmux is scripted: the running client answers.
out=$(HOME=$home "$bin" -L "$client" display -p '#{session_windows} #{pane_index}')
[ -n "$out" ] || fail "hn display -p from a shell answered nothing"
echo "✓ hn display -p from a shell: $out"
sleep 2.3
info=$(HOME=$home "$bin" -L "$client" display -p -t 0 '#{pane_current_command} #{pane_current_path}')
[ "$info" = "zsh /home/demo/src" ] || fail "pane_current_* from the daemon's tmux: got '$info'"
echo "✓ #{pane_current_command} and #{pane_current_path} come from the pane's tmux"


# The dial (the Harness device): hn is the window, so it says what is on screen and does what the dial asks.
wait_eq "the dial's ring is this window's panes, in pane order" 2 dial "d.said.app_panes?.agentIds?.length"
codex=$(dial "d.said.app_panes.agentIds[0]")
wait_eq "the dial hears the windows" 1 dial "d.said.app_swarms?.swarms?.length"
push "{\"type\":\"dial_focus\",\"payload\":{\"machineId\":\"mock0000000000000000000000000001\",\"agentId\":\"$codex\"}}"
wait_eq "turning the dial selects that pane" 0 hn display -p '#{pane_index}'
wait_eq "and the dial hears it back (app_focus)" "$codex" dial "d.said.app_focus?.agentId"
push '{"type":"dial_scroll","payload":{"phase":"down","dy":0,"velocity":0}}'
push '{"type":"dial_scroll","payload":{"phase":"move","dy":40,"velocity":0}}'
push '{"type":"dial_scroll","payload":{"phase":"up","dy":0,"velocity":0}}'
wait_eq "a finger on the dial scrolls the pane into copy mode, as tmux's wheel does" 1 hn display -p '#{pane_in_mode}'
push '{"type":"dial_scroll","payload":{"phase":"move","dy":-40,"velocity":0}}'
wait_eq "and back down to the bottom leaves it" 0 hn display -p '#{pane_in_mode}'
push '{"type":"voice_route_request","payload":{"voiceId":"v1","text":"sure: run the tests"}}'
wait_eq "a spoken task the router is sure of is sent" "sure: run the tests" dial "d.messages.at(-1)?.content"
wait_eq "and answered taken, then sent" "taken,sent" dial "d.replies.filter(r => r.voiceId === 'v1').map(r => r.state).join(',')"
push '{"type":"voice_route_request","payload":{"voiceId":"v2","text":"unsure: which one"}}'
expect "one it is not sure of is put to you" "Send: unsure: which one"
tmux_ send-keys -t t Escape
wait_eq "esc cancels it on the dial" "taken,cancelled" dial "d.replies.filter(r => r.voiceId === 'v2').map(r => r.state).join(',')"
shell=$(dial "d.said.app_panes.agentIds[1]")
push "{\"type\":\"dial_focus\",\"payload\":{\"machineId\":\"mock0000000000000000000000000002\",\"agentId\":\"$shell\"}}"
wait_eq "the dial reaches a pane on another machine too" 1 hn display -p '#{pane_index}'

tmux_ send-keys -t t C-b o
tmux_ send-keys -t t C-b z
expect "C-b z zooms (Z flag)" "*Z"
tmux_ send-keys -t t C-b z
tmux_ send-keys -t t C-b I
expect "C-b I: models for the focused harness" "Sonnet / High"
tmux_ send-keys -t t Escape
tmux_ send-keys -t t C-b @
expect "C-b @: machines" "mock-remote"
tmux_ send-keys -t t Escape
tmux_ send-keys -t t C-b c
tmux_ send-keys -t t Escape
expect "C-b c: a new window" "1:"
wait_eq "the dial hears the new window" 2 dial "d.said.app_swarms?.swarms?.length"
first=$(dial "d.said.app_swarms.swarms[0].id")
push "{\"type\":\"dial_swarm\",\"payload\":{\"swarmId\":\"$first\"}}"
wait_eq "picking a window on the dial selects it" 0 hn display -p '#{window_index}'
tmux_ send-keys -t t C-b 1
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
