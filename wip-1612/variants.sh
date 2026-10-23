export TMUX_TMPDIR=/tmp/tv; mkdir -p $TMUX_TMPDIR
job="sh -c 'kill -TSTP 0; echo job-resumed'"
printf '%s\n' 'set -m' "$job"' || st=$?' 'echo "st=$st"; jobs; echo "--jobs-done"; fg >/dev/null; sleep 100' > /tmp/a.sh
printf '%s\n' 'set -m; set -b' "$job"' || st=$?' 'echo "st=$st"; fg >/dev/null; sleep 100' > /tmp/b.sh
run() { tmux -f /dev/null new-session -d -x 120 -y 20 "$1"; sleep 1.2; echo "== $2"; tmux capture-pane -p | grep -v '^$'; tmux kill-server; sleep 0.2; }
run "/bin/bash -ic '. /tmp/a.sh'" "bash -ic source, jobs after"
run "/bin/bash -ic '. /tmp/b.sh'" "bash -ic source, set -b"
run "/bin/bash -i /tmp/a.sh" "bash -i file"
run "/bin/bash --posix -ic '. /tmp/a.sh'" "bash --posix -ic"
