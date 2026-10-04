#!/usr/bin/env bash
# End-to-end check of harness-tui against tests/mock-daemon.mjs — nothing real behind it, so it is
# safe to run anywhere (and to fuzz). Needs node (with cli/node_modules installed) and tmux.
#
#   cargo build --release && tui/tests/e2e.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="${HARNESS_TUI_BIN:-$here/../target/release/harness-tui}"
port="${E2E_PORT:-19297}"
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 19000 && port <= 19999 )) || { echo "E2E_PORT must be in the isolated test range 19000–19999" >&2; exit 2; }
unset TMUX TMUX_PANE HN_SOCKET
client="${HN_SOCKET_NAME:-e2e}-$$"
sock="harness-tui-e2e-$$"
home="$(mktemp -d /tmp/hn-e2e.XXXXXX)"
export HN_TMPDIR="$home"
export ADAPTER_DATA_DIR="$home/.harness/cli/data"
tmux_() { tmux -L "$sock" "$@"; }
screen() { tmux_ capture-pane -p -t t; }
fail() { echo "✗ $1"; echo "--- screen ---"; screen || true; hn show-messages || true; hn display -p 'key-table=#{client_key_table} prefix=#{client_prefix} mode=#{pane_mode}' || true; exit 1; }
expect() { # expect <what> <text> [timeout-ms]
  local waited=0 limit="${3:-3000}"
  until screen | grep -qF -- "$2"; do
    sleep 0.05; waited=$((waited + 50))
    [ "$waited" -ge "$limit" ] && fail "$1: \"$2\" never appeared"
  done
  echo "✓ $1"
}
hn() { env -u TMUX -u TMUX_PANE -u HN_SOCKET HOME="$home" PORT="$port" HN_SOCKET_NAME="$client" "$bin" -L "$client" --port "$port" "$@"; }
cleanup() {
  hn kill-server >/dev/null 2>&1 || true
  env -u TMUX -u TMUX_PANE -u HN_SOCKET HOME="$home" PORT="$port" HN_SOCKET_NAME="$client-2" "$bin" -L "$client-2" --port "$port" kill-server >/dev/null 2>&1 || true
  tmux_ kill-server 2>/dev/null || true
  kill "$mock" 2>/dev/null || true
  wait "$mock" 2>/dev/null || true
  # kill-server acknowledges before the UI's final session write. Wait for only
  # this fixture's clients before removing HOME, so writers cannot recreate it.
  python3 - "$bin" "$client" <<'PY'
import os, signal, subprocess, sys, time
binary, client = sys.argv[1:]
def clients():
    rows = subprocess.check_output(['ps', '-ax', '-o', 'pid=,command='], text=True).splitlines()
    return [int(parts[0]) for row in rows if len(parts := row.strip().split(None, 1)) == 2
            and parts[1].startswith(binary + ' ')
            and any(f'-L {name} ' in parts[1] for name in (client, client + '-2'))]
for pid in clients():
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
deadline = time.monotonic() + 5
while clients() and time.monotonic() < deadline:
    time.sleep(.05)
assert not clients(), 'e2e fixture client did not exit; retaining its HOME'
PY
  rm -rf "$home"
}
trap cleanup EXIT

HOME="$home" node "$here/mock-daemon.mjs" "$port" >/dev/null &
mock=$!
sleep 0.5
# Its own client socket, named: the test's shell calls must never reach a client of yours
# (an unnamed hn takes "default", which is where `hn <command>` goes).
# HN_DESKTOP=off: no desktop app here, so hn is the window the dial talks to.
tmux_ new-session -d -s t -x 120 -y 32 "env -u TMUX -u TMUX_PANE -u HN_SOCKET EDITOR=emacs VISUAL= HN_SOCKET_NAME=$client HOME=$home PORT=$port HARNESS_TUI_DESK=off HARNESS_TUI_NOTIFY=off HN_DESKTOP=off '$bin' -L '$client' --port '$port'"
# The mock's dial: what hn told it (dial <js expression over d>), and a frame to push at hn.
dial() { curl -s "http://127.0.0.1:$port/test/dial" | node -e "const d = JSON.parse(require('fs').readFileSync(0, 'utf8')).data; console.log($1)"; }
push() { curl -s -X POST --data "$1" "http://127.0.0.1:$port/test/dial" >/dev/null; }
wait_eq() { # wait_eq <what> <expected> <command…>: until the command prints what is expected, 3s
  # (The command is run again each time: a `$(…)` in the arguments would be read only once.)
  local what="$1" want="$2" waited=0 got=""; shift 2
  until got="$("$@" 2>/dev/null)" && [ "$got" = "$want" ]; do sleep 0.05; waited=$((waited + 50)); [ "$waited" -ge 3000 ] && fail "$what (got '$got', want '$want')"; done
  echo "✓ $what"
}

# The first window is ready for a task; Open Terminal is an explicit keyboard action.
expect "starts with the task-first welcome" "Welcome to Harness" 5000
tmux_ send-keys -t t Tab Tab Tab Tab Tab Tab Tab Tab Enter
expect "Open Terminal opens a shell here" "Mock terminal (mock)" 5000
status_tabs() { screen | tail -n 1 | grep -q '^ 0:' && echo yes; }
wait_eq "status line starts with window tabs, without a session label" yes status_tabs
expect "status line quotes the local machine's app name" '"mock-local"'
wait_eq "desk=off: the first session is still tmux's 0" 0 hn display -p '#{session_name}'
start_window=$(hn display -p '#{window_id}')
tmux_ send-keys -t t C-b s
expect "C-b s opens the fzf list" "Search harnesses"
tmux_ send-keys -t t 'Mock\ Claude'
expect "fuzzy filter narrows" "1/"
# Enter adds the harness beside the existing shell in the current window.
tmux_ send-keys -t t Enter
expect "C-b s Enter streams the selected harness" "Mock Claude (mock)"
wait_eq "C-b s Enter keeps the current window" "$start_window" hn display -p '#{window_id}'
wait_eq "C-b s Enter adds a pane" "2" hn display -p '#{window_panes}'
wait_eq "C-b s Enter does not add a window" "1" hn display -p '#{session_windows}'
hn kill-pane
tmux_ send-keys -t t C-b s
expect "C-b s reopens the fzf list" "Search harnesses"
tmux_ send-keys -t t 'Mock\ Claude'
expect "fuzzy filter narrows for a new window" "1/"
tmux_ send-keys -t t C-t
expect "C-b s C-t: a window of its own, name before status" "1:Mock Claude*"
idle_tab() { hn display -p "$(hn show -gwv window-status-current-format)"; }
wait_eq "idle windows have no status dot" "1:Mock Claude*" idle_tab
wait_eq "the harness window's one pane" "1" hn display -p '#{window_panes}'
hn kill-window
tmux_ send-keys -t t C-b s
tmux_ send-keys -t t "codex"
expect "fuzzy filter narrows again" "1/"
tmux_ send-keys -t t C-v
expect "pane streams the keyframe" "Mock Codex (mock)"
tmux_ send-keys -t t "echo-me"
expect "typing round-trips" "echo-me"
# tmux's copy mode (emacs keys: EDITOR is emacs here): the position top right, a word copied.
tmux_ send-keys -t t C-b "["
expect "C-b [ is copy mode, its position shown" "[0/0]"
wait_eq "#{pane_in_mode} and the copy cursor" "1 9,1" hn display -p '#{pane_in_mode} #{copy_cursor_x},#{copy_cursor_y}'
tmux_ send-keys -t t C-a C-f C-f C-Space M-f M-w
wait_eq "C-Space M-f M-w copies a word" "echo" hn show-buffer
wait_eq "and leaves copy mode" "0" hn display -p '#{pane_in_mode}'
# What a command prints goes to the pane's view mode, as tmux's; q closes it.
tmux_ send-keys -t t C-b "?"
expect "C-b ? lists the keys in view mode" "C-b Space   Select next layout"
wait_eq "#{pane_mode}" "view-mode" hn display -p '#{pane_mode}'
tmux_ send-keys -t t q
wait_eq "q leaves view mode" "0" hn display -p '#{pane_in_mode}'
tmux_ send-keys -t t C-b ":"
# Titles contain colons too. Wait for the actual status prompt before typing a command.
command_prompt() { screen | tail -n 1 | grep -q '^:' && echo yes; }
wait_eq "C-b : is the command prompt" yes command_prompt
tmux_ send-keys -t t "split-window -h" Enter
# tmux's split: a shell at once, and what is typed straight after it lands in it.
tmux_ send-keys -t t "typed-ahead"
wait_eq "split-window -h adds a pane" "3" hn display -p '#{window_panes}'
expect "split-window -h gives a shell" 'Mock terminal'
expect "keys typed while it starts go into it" "typed-ahead"
tmux_ send-keys -t t C-b x y
tmux_ send-keys -t t C-b s
tmux_ send-keys -t t "remote"
tmux_ send-keys -t t C-v
expect "C-b s then C-v: a harness beside" "Remote shell (mock)"
wait_eq "the remote harness is focused" 'Remote shell' hn display -p '#{pane_title}'
expect "pane header names the focused harness" 'Remote shell'
# From a shell, as tmux is scripted: the running client answers.
out=$(hn display -p '#{session_windows} #{pane_index}')
[ -n "$out" ] || fail "hn display -p from a shell answered nothing"
echo "✓ hn display -p from a shell: $out"
sleep 2.3
info=$(hn display -p -t 0 '#{pane_current_command} #{pane_current_path}')
[ "$info" = "zsh /home/demo/src" ] || fail "pane_current_* from the daemon's tmux: got '$info'"
echo "✓ #{pane_current_command} and #{pane_current_path} come from the pane's tmux"


# The dial (the Harness device): hn is the window, so it says what is on screen and does what the dial asks.
# Window 0: the shell hn started in, the Codex harness beside it, the remote shell.
wait_eq "the dial's ring is this window's panes, in pane order" 3 dial "d.said.app_panes?.agentIds?.length"
codex=$(dial "d.said.app_panes.agentIds[1]")
wait_eq "the dial hears the windows" 1 dial "d.said.app_swarms?.swarms?.length"
push "{\"type\":\"dial_focus\",\"payload\":{\"machineId\":\"mock0000000000000000000000000001\",\"agentId\":\"$codex\"}}"
wait_eq "turning the dial selects that pane" 1 hn display -p '#{pane_index}'
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
shell=$(dial "d.said.app_panes.agentIds[2]")
push "{\"type\":\"dial_focus\",\"payload\":{\"machineId\":\"mock0000000000000000000000000002\",\"agentId\":\"$shell\"}}"
wait_eq "the dial reaches a pane on another machine too" 2 hn display -p '#{pane_index}'

tmux_ send-keys -t t C-b o
tmux_ send-keys -t t C-b z
expect "C-b z zooms (Z flag)" "*Z"
tmux_ send-keys -t t C-b z
tmux_ send-keys -t t C-b I
# Models now shares the desktop's subscriptions/local/Grid picker. This pane is
# a shell, so it lists available sources without offering an engine model switch.
expect "C-b I opens the shared Models picker" "Subscriptions"
expect "Models lists the connected Anthropic subscription" "Anthropic"
expect "Models lists the connected OpenAI subscription" "OpenAI"
expect "Models lists the available Grid model" "demo-model"
expect "a shell must focus a harness before switching models" "Focus a harness"
tmux_ send-keys -t t Escape
tmux_ send-keys -t t C-b @
expect "C-b @: machines" "mock-remote"
tmux_ send-keys -t t -l zzz
expect "a filter after the mode character" "0/"
tmux_ send-keys -t t C-u
expect "C-u clears the filter, not the mode" "mock-remote"
screen | grep -q "Search harnesses" && fail "C-u left the machines list"
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
wait_eq "C-b 0: back to window 0 (its harness idle: ·)" "0 ·" hn display -p '#{window_index} #{window_agent_icon}'
# A harness at work, then done, as the daemon's events say it: its line, the counts, C-b a.
claude=$(dial "d.agents.find(a => a.name === 'Mock Claude').id")
csess=$(dial "d.agents.find(a => a.name === 'Mock Claude').sessionId")
ev() { push "{\"type\":\"$1\",\"agentId\":\"$claude\",\"dbSessionId\":\"$csess\",\"payload\":{\"agentId\":\"$claude\",\"sessionId\":\"$csess\"$2}}"; }
ev turn_started ',"userMessage":"run the tests"'
ev tool_start ',"id":"t1","tool":"Bash","input":{"command":"npm test","description":"Run the unit tests"}'
wait_eq "a working harness is counted (#{fleet_working})" 1 hn display -p '#{fleet_working}'
tmux_ send-keys -t t C-b s
expect "C-b s: a working harness's line says what it is doing" "Run the unit tests"
tmux_ send-keys -t t Escape
ev text_delta ',"content":"All 42 tests pass.\\n\\nNothing else changed."'
ev turn_ended ''
wait_eq "its turn done where you were not looking: done and unread (#{fleet_done})" 1 hn display -p '#{fleet_done}'
expect "the status line counts it" "✓1"
tmux_ send-keys -t t C-b s
expect "C-b s: a done harness's line is what it did" "All 42 tests pass."
tmux_ send-keys -t t Escape
tmux_ send-keys -t t C-b a
expect "C-b a goes to the harness that needs you" "Mock Claude (mock)"
wait_eq "looking at it reads it" 0 hn display -p '#{fleet_done}'
tmux_ send-keys -t t C-b 0
expect "back to window 0" "Mock Codex (mock)"
tmux_ send-keys -t t C-b w
expect "C-b w: choose-tree" "windows (attached)"
tree_pane=$(hn display -p '#{pane_id}')
tree_window=$(hn display -p '#{window_id}')
# Navigation and resize must stay in the chooser rather than type into its pane.
tmux_ send-keys -t t End Home NPage PPage Right Left t T C-t O r v v
for size in '40 12' '1 1' '120 32'; do
  read -r width height <<< "$size"
  tmux_ resize-window -t t -x "$width" -y "$height"
  tmux_ send-keys -t t End Home
done
wait_eq "window chooser survives navigation and tiny resizes" 1 hn display -p '#{pane_in_mode}'
tmux_ send-keys -t t q
wait_eq "q leaves window chooser on its original pane" "$tree_pane" hn display -p '#{pane_id}'
wait_eq "chooser navigation never changes the active window" "$tree_window" hn display -p '#{window_id}'
# A paste-buffer chooser is still keyboard-first, including Unicode and a buffer
# that disappears while it is open. Cancelling it must never paste the selection.
while IFS= read -r buffer; do
  [ -z "$buffer" ] || hn delete-buffer -b "$buffer"
done < <(hn list-buffers -F '#{buffer_name}')
hn choose-buffer
wait_eq "empty paste-buffer chooser does not capture input" 0 hn display -p '#{pane_in_mode}'
hn set-buffer -b audit-text 'BUFFER_CAFE_界'
hn choose-buffer -N -F '#{buffer_name}:#{buffer_sample}'
expect "paste-buffer chooser shows Unicode contents" 'audit-text:BUFFER_CAFE_界'
tmux_ send-keys -t t Escape
wait_eq "Escape leaves paste-buffer chooser" 0 hn display -p '#{pane_in_mode}'
hn capture-pane -p | grep -qF 'BUFFER_CAFE_界' && fail "cancel pasted the selected buffer"
hn choose-buffer -N -F '#{buffer_name}:#{buffer_sample}'
expect "paste-buffer chooser reopens" 'audit-text:BUFFER_CAFE_界'
tmux_ send-keys -t t Enter
expect "Enter pastes the selected Unicode buffer" 'BUFFER_CAFE_界'
wait_eq "pasting leaves chooser mode" 0 hn display -p '#{pane_in_mode}'
hn choose-buffer -N
wait_eq "buffer chooser is active before deletion" 1 hn display -p '#{pane_in_mode}'
hn delete-buffer -b audit-text
tmux_ send-keys -t t End Enter Escape
wait_eq "deleting the final buffer leaves no trapped mode" 0 hn display -p '#{pane_in_mode}'
tmux_ send-keys -t t C-b x
expect "C-b x asks first" "(y/n)"
tmux_ send-keys -t t n
# C-b c: the same task-first composer, with recent sessions below it.
tmux_ send-keys -t t C-b c
expect "C-b c: another new window" "2:"
expect "C-b c: the creation form and secondary session browser" "Browse All Sessions"
# Open Terminal may replace the backing shell if its resolved folder changed.
# Assert the displayed shell is killed exactly once, independently of that retirement.
tmux_ send-keys -t t Tab Tab Tab Tab Tab Tab Tab Tab Enter
expect "Open Terminal shows the new window's shell" "Mock terminal (mock)"
wait_eq "the dial's new window has one shell" 1 dial "d.said.app_panes?.agentIds?.length"
closing_window=$(hn display -p '#{window_id}')
E2E_CLOSING_AGENT=$(dial "d.said.app_panes.agentIds[0]")
export E2E_CLOSING_AGENT
tmux_ send-keys -t t C-b '&'
expect "C-b & asks first" "(y/n)"
tmux_ send-keys -t t y
wait_eq "C-b & kills the displayed shell exactly once" 1 dial "(d.deleted || []).filter(id => id === process.env.E2E_CLOSING_AGENT).length"
closed_window() { hn list-windows -F '#{window_id}' | grep -qFx -- "$closing_window" || echo yes; }
wait_eq "C-b & removes that window" yes closed_window
# A question hook is bound to its original request, even when its shell test finishes later.
# Hold the callback until the replacement question is visible, without relying on a timing race.
hook_question() { push "{\"type\":\"commander_question\",\"agentId\":\"$claude\",\"dbSessionId\":\"$csess\",\"payload\":{\"requestId\":\"$1\",\"questions\":[{\"q\":\"$2\",\"options\":[\"Yes\",\"No\"]}]}}"; }
hook_close() { push "{\"type\":\"commander_question_close\",\"agentId\":\"$claude\",\"dbSessionId\":\"$csess\",\"payload\":{\"requestId\":\"$1\",\"agentId\":\"$claude\",\"dbSessionId\":\"$csess\"}}"; }
hook_started() { [ -f "$home/hook-started" ] && echo yes; }
hn set-hook -g harness-needs "if-shell \"touch '$home/hook-started'; while [ ! -e '$home/hook-release' ]; do sleep 0.02; done\" \"answer-harness 1\""
hook_question q-hook-old 'Original question?'
wait_eq "the question hook started its shell check" yes hook_started
hn set-hook -gu harness-needs
hook_close q-hook-old
hook_question q-hook-new 'Replacement question?'
# The picker proves that hn received the replacement before the old callback is released.
tmux_ send-keys -t t C-b A
expect "replacement question is visible" "Replacement question?"
tmux_ send-keys -t t Escape
touch "$home/hook-release"
expect "the old hook refuses the replacement question" "question changed since the hook ran"
wait_eq "the replacement was not answered" 0 dial "(d.answers || []).filter(a => a.requestId === 'q-hook-new').length"
hook_close q-hook-new
# Preserve ordinary asynchronous answering and the hook's harness when another pane is focused.
hn set-hook -g harness-needs 'run-shell "sleep 0.05" ; answer-harness 2'
hook_question q-hook-same 'Unchanged question?'
wait_eq "an unchanged hook question answers on its own harness" No dial "(d.answers || []).find(a => a.requestId === 'q-hook-same' && a.agentId === '$claude')?.answers['Unchanged question?']"
hn set-hook -gu harness-needs

tmux_ resize-window -t t -x 30 -y 8
sleep 0.3
tmux_ resize-window -t t -x 120 -y 32
expect "survives a tiny window" "Mock Codex"
tmux_ send-keys -t t C-b d
sleep 0.5
tmux_ has-session -t t 2>/dev/null && screen | grep -q "Mock" && fail "C-b d did not detach"
echo "✓ C-b d detaches"
# The last window closed ends hn, as the session's end ends tmux's client.
tmux_ new-session -d -s u -x 120 -y 32 "env -u TMUX -u TMUX_PANE -u HN_SOCKET HN_SOCKET_NAME=$client-2 HOME=$home PORT=$port HARNESS_TUI_DESK=off HARNESS_TUI_NOTIFY=off HN_DESKTOP=off '$bin' -L '$client-2' --port '$port'; sleep 5"
waited=0; until tmux_ capture-pane -p -t u | grep -qF "New Window"; do sleep 0.05; waited=$((waited + 50)); [ "$waited" -ge 5000 ] && fail "a second hn showed no new-window form"; done
tmux_ send-keys -t u C-b '&'
sleep 0.3
tmux_ send-keys -t u y
waited=0; until tmux_ capture-pane -p -t u | grep -qF "[exited]"; do sleep 0.05; waited=$((waited + 50)); [ "$waited" -ge 3000 ] && { tmux_ capture-pane -p -t u; fail "killing the last window did not end hn with [exited]"; }; done
echo "✓ the last window killed: [exited]"
echo "all e2e checks passed"
