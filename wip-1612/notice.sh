# Does an interactive `bash -ic` report a job that stops, and fg's resume? Run in a tmux pane.
cat > /tmp/l.sh <<'L'
set -m 2>/dev/null || :
st=0
sh -c 'kill -TSTP 0; echo job-resumed' || st=$?
echo "status=$st"
fg >/dev/null || st=$?
echo "after-fg status=$st"
sleep 100
L
export TMUX_TMPDIR=/tmp/tt; mkdir -p $TMUX_TMPDIR
tmux -f /dev/null new-session -d -x 100 -y 30 "/bin/bash -ic '. /tmp/l.sh'"
sleep 1.5
echo "== $(bash --version | head -1)"
tmux capture-pane -p | grep -v '^$'
tmux kill-server
