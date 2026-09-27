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
cleanup() { tmux_ kill-server 2>/dev/null || true; kill "$mock" ${mock_off:-} ${mock_out:-} 2>/dev/null || true; rm -rf "$home"; }
trap cleanup EXIT
# E2E_SNAPSHOTS=<dir>: the daemons' screens, as capture-pane printed them, kept there.
snap() { [ -n "${E2E_SNAPSHOTS:-}" ] && screen > "$E2E_SNAPSHOTS/$1.txt"; return 0; }

# harnessd's Unix socket is in ADAPTER_DATA_DIR (the scratch home here): the mock serves it beside the
# port, and hn connects over it — the pair brain takes keys, talk and presence only there.
ADAPTER_DATA_DIR="$home" node "$here/mock-daemon.mjs" "$port" >/dev/null &
mock=$!
sleep 0.5
# Its own client socket, named: the test's shell calls must never reach a client of yours
# (an unnamed hn takes "default", which is where `hn <command>` goes).
client="e2e-$$"
# HN_DESKTOP=off: no desktop app here, so hn is the window the dial talks to.
tmux_ new-session -d -s t -x 120 -y 32 "EDITOR=emacs VISUAL= HN_SOCKET_NAME=$client HOME=$home ADAPTER_DATA_DIR=$home PORT=$port HARNESS_TUI_DESK=off HARNESS_TUI_NOTIFY=off HN_DESKTOP=off $bin"
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

# As tmux starts: window 0 is a shell on this computer.
expect "starts in a shell, as tmux does" "Mock terminal (mock)" 5000
expect "status line, tmux-style (desk=off: the first session is tmux's 0)" "[0] 0:"
tmux_ send-keys -t t C-b s
expect "C-b s opens the fzf list" "Search harnesses"
tmux_ send-keys -t t 'Mock\ Claude'
expect "fuzzy filter narrows" "1/"
# Enter, as tmux's chooser: the harness in a window of its own (not a split of this one).
tmux_ send-keys -t t Enter
expect "C-b s Enter: a window of its own" "1:· Mock Claude*"
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
expect "C-b : is the command prompt" ":"
tmux_ send-keys -t t "split-window -h" Enter
# tmux's split: a shell at once, and what is typed straight after it lands in it.
tmux_ send-keys -t t "typed-ahead"
expect "split-window -h gives a shell" '── Mock terminal ─'
expect "keys typed while it starts go into it" "typed-ahead"
tmux_ send-keys -t t C-b x y
tmux_ send-keys -t t C-b s
tmux_ send-keys -t t "remote"
tmux_ send-keys -t t C-v
expect "C-b s then C-v: a harness beside" "Remote shell (mock)"
expect "pane titles, tmux pane-border-status" '── Remote shell ─'
# From a shell, as tmux is scripted: the running client answers.
out=$(HOME=$home "$bin" -L "$client" display -p '#{session_windows} #{pane_index}')
[ -n "$out" ] || fail "hn display -p from a shell answered nothing"
echo "✓ hn display -p from a shell: $out"
sleep 2.3
info=$(HOME=$home "$bin" -L "$client" display -p -t 0 '#{pane_current_command} #{pane_current_path}')
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
expect "C-b I: models for the focused harness" "Sonnet / High"
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
expect "C-b 0: back to window 0 (its harness idle: ·)" "0:· "
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
tmux_ send-keys -t t q
tmux_ send-keys -t t C-b x
expect "C-b x asks first" "(y/n)"
tmux_ send-keys -t t n
# C-b c: a new window on the home page (its recent harnesses and conversations; typing starts a shell there).
before=$(dial "(d.deleted || []).length")
tmux_ send-keys -t t C-b c
expect "C-b c: another new window" "2:"
expect "C-b c: the home page, a conversation Harness did not start in it" "Continue NFC device chat"
# Its shell (a key typed there makes it, as after tmux's C-b c), killed with its window (C-b &),
# goes with it, as tmux kills the pane's shell.
tmux_ send-keys -t t Enter
sleep 1
tmux_ send-keys -t t C-b '&'
expect "C-b & asks first" "(y/n)"
tmux_ send-keys -t t y
wait_eq "C-b & kills the window's shell" $((before + 1)) dial "(d.deleted || []).length"
# ── the daemons (daemons/README.md; tui/docs/daemons.md) ──
# The mock's zoo has the first egg waiting (MOCK_ZOO=egg): the status line shows it.
wait_eq "#{daemon}: the waiting egg in the status cell (ten cells)" '  \_O_/   ' hn display -p '#{daemon}'
expect "the egg in the status line" '\_O_/   '
wait_eq "prefix Z enters the daemon table (a key tmux leaves unbound)" 1 sh -c "HOME=$home $bin -L $client list-keys -T prefix Z | grep -c 'switch-client -T daemon'"
tmux_ send-keys -t t C-b Z
expect "C-b Z: the daemon's keys" "Hatch an egg"
snap table
tmux_ send-keys -t t h
expect "h: the hatch, full screen" "─ hatch ─"
# tim is drawn filled: its 0.1 plate, at the reveal size (56 columns) since 120 x 32 has room for all of it.
expect "the hatchling as a silhouette first (the reveal plate, every glyph a #)" "###################"
snap hatch-silhouette
expect "then the plate itself, its idle loop running" "##########%%%%"
snap hatch-plate
expect "its name as a banner" "| |_  (_)  _ __"
expect "fork() returned 0." "fork() returned 0."
snap hatch-fork
expect "then its card, with the server's serial" "tim 0.1  #0042"
snap hatch-card
tmux_ send-keys -t t Space
expect "then what it sees, before it watches anything" "What tim sees"
snap consent
tmux_ send-keys -t t y
wait_eq "y: zoo.consent { watching: true }" "true" dial "d.zooOps.filter(o => o.op === 'zoo.consent').map(o => o.watching).join()"
wait_eq "tim is paired, in the status line" "tim" hn display -p '#{daemon_name}'
wait_eq "#{daemon}: tim's face in the status cell (its one-line sprite)" '  (o o)   ' hn display -p '#{daemon}'
expect "tim in the status line, once its reply has gone" "(o o)" 7000
snap status-tim
wait_eq "presence over the socket (daemon_presence, trusted)" "true" dial "d.daemon.some(f => f.type === 'daemon_presence' && f.trusted)"
# A line from the pair brain, keys first; its detail is on screen before a key counts.
push "{\"type\":\"daemon_say\",\"payload\":{\"id\":\"q1\",\"about\":{\"machineId\":\"mock0000000000000000000000000001\",\"agentId\":\"$codex\"},\"mood\":\"ask\",\"line\":\"[y/n/g] codex@mock-local Bash: npm test\",\"actions\":[{\"key\":\"y\",\"label\":\"Yes\",\"choice\":\"Yes\"},{\"key\":\"n\",\"label\":\"No\",\"choice\":\"No\"},{\"key\":\"g\",\"label\":\"open\",\"choice\":\"g\"}],\"ttlMs\":30000,\"detail\":\"Bash command\\n\\n  npm test\\n  Run the unit tests\"}}"
expect "a say, keys first, in the message line" "[y/n/g] codex@mock-local Bash: npm test"
snap say
tmux_ send-keys -t t C-b Z y
expect "y first shows exactly what it answers" "exactly what a key does"
expect "the whole dialog, and the keys named" "y Yes · n No · g open"
snap detail
wait_eq "daemon_shown once the line and its detail were drawn" "true" dial "d.daemon.some(f => f.type === 'daemon_shown' && f.id === 'q1' && f.trusted)"
sleep 0.5
tmux_ send-keys -t t y
wait_eq "y, armed: daemon_act { id, choice }" "q1 Yes" dial "d.acts.map(a => a.id + ' ' + a.choice).join()"
screen | grep -qF "npm test" && fail "the answered line did not go"
echo "✓ the answered line goes (daemon_unsay)"
# Talk: words to the pair harness, its answer after its nick.
tmux_ send-keys -t t C-b Z t
expect "t: the talk prompt" "(talk)"
tmux_ send-keys -t t "hello tim" Enter
wait_eq "daemon_talk over the socket" "hello tim" dial "d.daemon.filter(f => f.type === 'daemon_talk').map(f => f.text).join()"
expect "the pair's words, after its nick" "<tim> heard you: hello tim"
# The brief on return: at most five items, the line first.
push '{"type":"daemon_brief","payload":{"desk":"local","line":"reattached. 1 done.","items":[{"id":"b1","kind":"done","machineId":"mock0000000000000000000000000001","line":"Mock Claude: all 42 tests pass"}]}}'
expect "the brief on return" "reattached. 1 done."
tmux_ send-keys -t t C-b Z Escape
sleep 0.3
screen | grep -qF "reattached. 1 done." && fail "C-b Z Escape left the brief"
echo "✓ C-b Z Escape dismisses it"
# The same question id again replaces its line in place (ids no longer move with timers or cursors).
say() { push "{\"type\":\"daemon_say\",\"payload\":{\"id\":\"q2\",\"about\":{\"machineId\":\"mock0000000000000000000000000001\",\"agentId\":\"$codex\"},\"mood\":\"ask\",\"line\":\"[n/g] codex@mock-local $1\",\"actions\":[{\"key\":\"n\",\"label\":\"No\",\"choice\":\"No\"},{\"key\":\"g\",\"label\":\"open\",\"choice\":\"g\"}],\"ttlMs\":30000}}"; }
say "Edit src/app.ts (1)"
expect "a keyed line" "codex@mock-local Edit src/app.ts (1)"
say "Edit src/app.ts (2)"
expect "the same id replaces it in place" "codex@mock-local Edit src/app.ts (2)"
# daemon_state, pushed unasked: a need across the fleet makes the face need…
push '{"type":"daemon_state","payload":{"pair":"tim","needs":[{"machineId":"mock0000000000000000000000000002","agentId":"x","requestId":"r1","question":"Bash: make"}],"working":0,"failing":[],"machines":[],"asks":[],"acted":[],"autonomy":"watch","confirms":[]}}'
wait_eq "daemon_state pushed: its needs make the face need" "need" hn display -p '#{daemon_mood}'
# …and the off result (pair: null) takes the brain's lines with it, and has the zoo read again.
reads=$(dial "d.zooReads")
push '{"type":"daemon_state","payload":{"pair":null,"needs":[],"working":0,"failing":[],"machines":[],"asks":[],"acted":[],"autonomy":"watch","confirms":[]}}'
wait_eq "pair: null reads the zoo again" 1 dial "d.zooReads > $reads ? 1 : 0"
waited=0; while screen | grep -qF "Edit src/app.ts (2)"; do sleep 0.05; waited=$((waited + 50)); [ "$waited" -ge 3000 ] && fail "pair: null left the brain's line up"; done
echo "✓ pair: null takes the brain's line down"
wait_eq "and the face is itself again" "idle" hn display -p '#{daemon_mood}'
# The server's switch goes off: the next read (here, after the off result) is a 404, and hn is as before daemons.
curl -s -X POST "http://127.0.0.1:$port/test/zoo-mode?mode=off" >/dev/null
push '{"type":"daemon_state","payload":{"pair":"tim","needs":[],"working":0,"failing":[],"machines":[],"asks":[],"acted":[],"autonomy":"watch","confirms":[]}}'
push '{"type":"daemon_state","payload":{"pair":null,"needs":[],"working":0,"failing":[],"machines":[],"asks":[],"acted":[],"autonomy":"watch","confirms":[]}}'
wait_eq "switched off: no status cell" "" hn display -p '#{daemon}'
wait_eq "switched off: no prefix Z" 0 sh -c "HOME=$home $bin -L $client list-keys | grep -c 'switch-client -T daemon' || true"
# …and on again: zoo_changed asks, and it all comes back.
curl -s -X POST "http://127.0.0.1:$port/test/zoo-mode?mode=egg" >/dev/null
push '{"type":"zoo_changed","payload":{"revision":999}}'
wait_eq "on again after zoo_changed" "tim" hn display -p '#{daemon_name}'
wait_eq "prefix Z back" 1 sh -c "HOME=$home $bin -L $client list-keys -T prefix Z | grep -c 'switch-client -T daemon'"
# The zoo: the box back and what's next.
tmux_ send-keys -t t C-b Z z
expect "z: the zoo's box back (drop 1 is init; unix and tty are on hold, shown nowhere)" "zoo: drop 1 init  1/9"
expect "an empty numbered slot" "[ ? ]"
expect "tim's portrait plate over the zoo" "#####%"
snap zoo
screen | grep -qiF "unix" && fail "the zoo shows a drop on hold"
echo "✓ no drop on hold in the zoo"
tmux_ send-keys -t t Escape
out=$(hn zoo)
echo "$out" | grep -qF "zoo: drop 1 init  1/9" || fail "hn zoo from a shell: $out"
echo "$out" | grep -qF ";x###%x," || fail "hn zoo: tim's portrait plate: $out"
echo "✓ hn zoo from a shell, tim's portrait plate at its head"
out=$(hn card)
echo "$out" | grep -qF "| #01/09  DROP 1: INIT            COMMON |" || fail "hn card: $out"
echo "✓ hn card prints the card"
# A filled daemon's card is its portrait plate: byte for byte what daemons/tools/card.mjs draws.
out=$(hn card tim --version 2.0)
hatched=$(curl -s "http://127.0.0.1:$port/api/zoo" | node -e "const v = JSON.parse(require('fs').readFileSync(0, 'utf8')); console.log((v.data ?? v).zoo.daemons.find(d => d.id === 'tim').hatchedAt.slice(0, 10))")
want=$(node --input-type=module -e "
import { readFileSync } from 'node:fs'
import { cardLines } from '$here/../../daemons/tools/card.mjs'
const roster = JSON.parse(readFileSync('$here/../../daemons/roster.json', 'utf8'))
const plates = JSON.parse(readFileSync('$here/../../daemons/plates.json', 'utf8'))
const tim = roster.daemons.find(d => d.id === 'tim')
const plate = plates.daemons.tim.portrait['2.0'].idle[0].split('\\n')
console.log(cardLines(roster, tim, { version: '2.0', plate, serial: 42, hatched: '$hatched', egg: 'first' }).join('\\n'))")
[ "$out" = "$want" ] || fail "hn card tim --version 2.0 is not card.mjs's card:
$out
--- card.mjs ---
$want"
[ -n "${E2E_SNAPSHOTS:-}" ] && printf '%s\n' "$out" > "$E2E_SNAPSHOTS/card-tim-2.0.txt"
echo "✓ hn card tim --version 2.0: the portrait plate card, as card.mjs draws it"
out=$(hn card --version 9.9 2>&1 || true)
echo "$out" | grep -qF 'no version "9.9"' || fail "hn card --version 9.9: $out"
out=$(hn card tmux 2>&1 || true)
echo "$out" | grep -qF "no daemon is called tmux" || fail "hn card tmux: a daemon on hold is shown: $out"
echo "✓ hn card: a version it knows; a daemon on hold is not one it knows"
hn card --svg | grep -qF "<svg" || fail "hn card --svg"
echo "✓ hn card --svg"
# Quiet: no line nobody asked for.
hn set -g @daemon-quiet on
push "{\"type\":\"daemon_say\",\"payload\":{\"id\":\"f1\",\"about\":{\"machineId\":\"mock0000000000000000000000000002\",\"agentId\":\"x\"},\"mood\":\"fail\",\"line\":\"remote failed: tests\",\"actions\":[],\"ttlMs\":5200}}"
tmux_ send-keys -t t Enter
sleep 0.6
screen | grep -qF "remote failed" && fail "@daemon-quiet on still spoke"
echo "✓ set -g @daemon-quiet on: silent"
hn set -g @daemon-quiet off
push "{\"type\":\"daemon_say\",\"payload\":{\"id\":\"f2\",\"about\":{\"machineId\":\"mock0000000000000000000000000002\",\"agentId\":\"x\"},\"mood\":\"fail\",\"line\":\"remote failed again: tests\",\"actions\":[],\"ttlMs\":5200}}"
sleep 0.2
tmux_ send-keys -t t Enter
expect "a line nobody asked for waits for a pause (Enter), then speaks" "remote failed again: tests"

# The daemons off (the server's switch: GET /api/zoo answers 404): nothing of them at all.
port_off=$((port + 1))
MOCK_ZOO=off node "$here/mock-daemon.mjs" "$port_off" >/dev/null &
mock_off=$!
home_off="$home/off"; mkdir -p "$home_off"
sleep 0.5
tmux_ new-session -d -s o -x 120 -y 32 "HN_SOCKET_NAME=$client-off HOME=$home_off PORT=$port_off HARNESS_TUI_DESK=off HARNESS_TUI_NOTIFY=off HN_DESKTOP=off $bin"
waited=0; until tmux_ capture-pane -p -t o | grep -qF "Mock terminal (mock)"; do sleep 0.05; waited=$((waited + 50)); [ "$waited" -ge 5000 ] && fail "the off client started no shell"; done
sleep 0.8
[ -z "$(HOME=$home_off $bin -L $client-off display -p '#{daemon}')" ] || fail "#{daemon} with the daemons off"
tmux_ capture-pane -p -t o | tail -1 | grep -qF '\_O_/' && fail "a status cell with the daemons off"
[ "$(HOME=$home_off $bin -L $client-off list-keys | grep -c 'switch-client -T daemon')" = 0 ] || fail "prefix Z bound with the daemons off"
off=$(curl -s "http://127.0.0.1:$port_off/test/dial" | node -e "const d = JSON.parse(require('fs').readFileSync(0, 'utf8')).data; console.log(d.daemon.length + d.zooOps.length)")
[ "$off" = 0 ] || fail "daemon_* frames or zoo ops with the daemons off ($off)"
echo "✓ the daemons off: no cell, no key table, no frames, no habits"
tmux_ kill-session -t o
out=$(HOME=$home_off "$bin" --port "$port_off" zoo 2>&1 || true)
echo "$out" | grep -qF "the daemons are off here" || fail "hn zoo with the daemons off: $out"
echo "✓ hn zoo with the daemons off says so"
# Signed out: the nest, and how to hatch.
port_out=$((port + 2))
MOCK_ZOO=signedout node "$here/mock-daemon.mjs" "$port_out" >/dev/null &
mock_out=$!
sleep 0.5
out=$(HOME=$home_off "$bin" --port "$port_out" zoo)
echo "$out" | grep -qF "sign in to hatch" || fail "hn zoo signed out: $out"
echo "✓ signed out: the nest, and sign in to hatch"
kill "$mock_out"; wait "$mock_out" 2>/dev/null || true
MOCK_ZOO=disabled node "$here/mock-daemon.mjs" "$port_out" >/dev/null &
mock_out=$!
sleep 0.5
out=$(HOME=$home_off "$bin" --port "$port_out" tim 2>&1 || true)
echo "$out" | grep -qF "the daemons are off here" || fail "hn tim with { enabled: false }: $out"
echo "✓ { enabled: false } is off too"

tmux_ resize-window -t t -x 30 -y 8
sleep 0.3
tmux_ resize-window -t t -x 120 -y 32
expect "survives a tiny window" "Mock Codex"
tmux_ send-keys -t t C-b d
sleep 0.5
tmux_ has-session -t t 2>/dev/null && screen | grep -q "Mock" && fail "C-b d did not detach"
echo "✓ C-b d detaches"
# The last window closed ends hn, as the session's end ends tmux's client.
tmux_ new-session -d -s u -x 120 -y 32 "HN_SOCKET_NAME=$client-2 HOME=$home PORT=$port HARNESS_TUI_DESK=off HARNESS_TUI_NOTIFY=off HN_DESKTOP=off $bin; sleep 5"
waited=0; until tmux_ capture-pane -p -t u | grep -qF "Mock terminal (mock)"; do sleep 0.05; waited=$((waited + 50)); [ "$waited" -ge 5000 ] && fail "a second hn started no shell"; done
tmux_ send-keys -t u C-b '&'
sleep 0.3
tmux_ send-keys -t u y
waited=0; until tmux_ capture-pane -p -t u | grep -qF "[exited]"; do sleep 0.05; waited=$((waited + 50)); [ "$waited" -ge 3000 ] && { tmux_ capture-pane -p -t u; fail "killing the last window did not end hn with [exited]"; }; done
echo "✓ the last window killed: [exited]"
echo "all e2e checks passed"
