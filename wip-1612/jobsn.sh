export TMUX_TMPDIR=/tmp/tj; mkdir -p $TMUX_TMPDIR
cat > /tmp/j.sh <<'L'
set -m
st=0
sh -c 'kill -TSTP 0; echo job-resumed' || st=$?
echo "st=$st"
jobs -n %% 2>/dev/null; echo "--jobs-n rc=$?"
fg >/dev/null
echo "--after fg"
sleep 1
true
sleep 100
L
for b in "$@"; do
  tmux -f /dev/null new-session -d -x 120 -y 20 "$b -ic '. /tmp/j.sh'"; sleep 2.5
  echo "== $($b --version | head -1)"; tmux capture-pane -p | grep -v '^$'; tmux kill-server; sleep 0.2
done
