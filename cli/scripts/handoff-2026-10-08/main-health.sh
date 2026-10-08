#!/bin/zsh
# On each new origin/main commit: tsc, architecture, and the 100% gates. One line per commit: MAIN <sha> OK | FAIL: <gates>.
S=${0:A:h}; W=$S/main-health; unset TMUX TMUX_PANE
last=$(cat $S/mh-last 2>/dev/null)
while true; do
  git -C $W fetch -q origin 2>/dev/null
  head=$(git -C $W rev-parse --short origin/main)
  if [[ $head != $last ]]; then
    git -C $W checkout -q --detach origin/main
    fails=()
    (cd $W/cli && npx tsc --noEmit -p . > $S/mh-tsc.log 2>&1) || fails+=(tsc)
    (cd $W/cli && npx vitest run src/architecture.spec.ts > $S/mh-arch.log 2>&1) || fails+=(architecture)
    for g in test:core test:harnessd test:local-models test:resume; do
      (cd $W/cli && npm run -s $g > "$S/mh-$g.log" 2>&1) || (cd $W/cli && npm run -s $g > "$S/mh-$g.log" 2>&1) || fails+=($g)
    done
    subject=$(git -C $W log -1 --format=%s | cut -c1-60)
    if (( ${#fails} )); then echo "MAIN $head FAIL: ${fails[*]} ($subject)"; else echo "MAIN $head OK"; fi
    last=$head; echo $last > $S/mh-last
  fi
  sleep 60
done
