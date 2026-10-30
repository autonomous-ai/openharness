#!/usr/bin/env bash
# The tmux half of the performance baseline (docs/testing/windows-pty-e2e.md). A private tmux server, never the
# user's: its own TMUX_TMPDIR, its own -L socket and no config.
# A short folder: a socket path over 104 bytes fails ("File name too long").
export TMUX_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/ohp.XXXX"); unset TMUX TMUX_PANE
trap 'rm -rf "$TMUX_TMPDIR"' EXIT
T="tmux -L e2eperf -f /dev/null"
measure() { # label seconds
  local pid; pid=$(pgrep -f "tmux -L e2eperf -f /dev/null start-server" | head -1)
  [ -n "$pid" ] || { echo "no private tmux server"; exit 1; }
  local t0 t1 sum=0 n=0 rss=0
  t0=$(ps -o time= -p "$pid" | awk -F'[:.]' '{ if (NF==3) print $1*60+$2+$3/100; else print $1*3600+$2*60+$3+$4/100 }')
  for i in $(seq 1 "$2"); do read c r < <(ps -o %cpu=,rss= -p "$pid"); sum=$(echo "$sum + $c" | bc); n=$((n+1)); rss=$r; sleep 1; done
  t1=$(ps -o time= -p "$pid" | awk -F'[:.]' '{ if (NF==3) print $1*60+$2+$3/100; else print $1*3600+$2*60+$3+$4/100 }')
  local panes; panes=$($T list-panes -a 2>/dev/null | wc -l | tr -d ' ')
  printf '{"label":"%s","panes":%s,"seconds":%s,"tmuxPid":%s,"psCpuAvgPct":%.2f,"cpuTimePct":%.2f,"rssMB":%.1f}\n' "$1" "$panes" "$2" "$pid" "$(echo "$sum / $n" | bc -l)" "$(echo "($t1 - $t0) * 100 / $2" | bc -l)" "$(echo "$rss / 1024" | bc -l)"
}
$T start-server \; set -g exit-empty off
sleep 2
measure idle-0 60
$T new-session -d -s perf -x 120 -y 40 'zsh -f'
for i in 2 3 4; do $T new-window -t perf 'zsh -f'; done
sleep 20; measure idle-4 60
for i in 5 6 7 8; do $T new-window -t perf 'zsh -f'; done
sleep 20; measure idle-8 60
$T kill-session -t perf
$T new-session -d -s stream -x 120 -y 40 'zsh -f'
# A control-mode client reads the pane's output, as the daemon's stream does.
( $T -C attach -t stream > /dev/null 2>&1 < <(sleep 100) & )
sleep 2
$T send-keys -t stream 'while true; do find /System/Library -print; done' Enter
sleep 10; measure streaming-1 60
$T send-keys -t stream C-c
$T kill-server
