#!/bin/bash
# land-direct.sh <worktree> <branch> <pr>: mark ready, wait for ci/required on the head, merge with make merge-pr;
# when main moved past the head's base, merge main in, push, and go again. Prints MERGED <sha> or why not.
set -u
W=$1; B=$2; PR=$3; R=autonomous-ai/openharness

cd "$W" || exit 1
git fetch -q origin
# The worktree is on the PR's branch, or on its pushed head (a detached landing worktree); pushes go to the PR's branch.
[ "$(git branch --show-current)" = "$B" ] || [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$B")" ] || { echo "worktree is not on $B"; exit 1; }
gh pr ready "$PR" --repo $R >/dev/null 2>&1
for attempt in 1 2 3 4; do
  git fetch -q origin
  if ! git merge-base --is-ancestor origin/main HEAD; then
    git merge -q --no-edit origin/main || { echo "MERGE CONFLICT with main"; git merge --abort; exit 2; }
    git push -q origin "HEAD:refs/heads/$B" || { echo "PUSH FAILED"; exit 3; }
  fi
  head=$(git rev-parse HEAD)
  [ "$(gh pr view "$PR" --repo $R --json headRefOid --jq .headRefOid)" = "$head" ] || { git push -q origin "HEAD:refs/heads/$B"; sleep 5; }
  sleep 45
  # Every check on this head finished, and ci/required among them: a draft run's failed ci/required can sit beside
  # the ready run's pending checks, and only the finished set says which one stands.
  s=""
  for i in $(seq 1 120); do
    pending=$(gh pr view "$PR" --repo $R --json headRefOid,statusCheckRollup --jq 'select(.headRefOid=="'"$head"'") | [.statusCheckRollup[] | select((.status // "COMPLETED") != "COMPLETED" or ((.state // "") == "PENDING"))] | length' 2>/dev/null)
    s=$(gh pr view "$PR" --repo $R --json headRefOid,statusCheckRollup --jq 'select(.headRefOid=="'"$head"'") | [.statusCheckRollup[] | select(.name=="ci/required") | (.conclusion // .state // .status)] | if index("SUCCESS") then "SUCCESS" else last end' 2>/dev/null)
    [ "${pending:-1}" = "0" ] && [ -n "$s" ] && [ "$s" != "null" ] && break
    sleep 60
  done
  case "$s" in SUCCESS) ;; *) echo "CI NOT PASSED on $head: $s"; gh pr checks "$PR" --repo $R 2>&1 | grep -vE "skipping|pass" | head -8; exit 5;; esac
  git fetch -q origin
  if ! git merge-base --is-ancestor origin/main "$head"; then echo "main moved during CI; again"; continue; fi
  out=$(make merge-pr ARGS="$PR --reviewed-head $head --reviewed-base $(git rev-parse origin/main) --merge" 2>&1)
  state=$(gh pr view "$PR" --repo $R --json state,mergeCommit --jq '"\(.state) \(.mergeCommit.oid // "")"')
  case "$state" in MERGED*) echo "$state"; exit 0;; esac
  echo "MERGE REFUSED: $(echo "$out" | tail -2 | tr '\n' ' ')"
done
echo "GAVE UP"; exit 7
