#!/bin/sh
# Keep the box alive, and bring the daemon up when — and only when — it has a session to come up with.
#
# The container is a BOX, not a daemon supervisor. `harness start` self-daemonizes on a real machine
# and does the same here, so the adapter is not what holds the box open: that way a `harness stop`
# from a test, or a daemon that exits on its own, does not take the whole container down and strand
# the SSO session and computer id that the next step needs.
#
# First run has no session at all — SSO is interactive and cannot be automated, so there is nothing to
# do but say so and wait. `scripts/remote-machine.sh login` is what drives the sign-in from outside.
set -eu

echo "[entrypoint] harness $(harness version 2>/dev/null || echo '(version unavailable)')"
echo "[entrypoint] computer id: ${ADAPTER_COMPUTER_ID:-<from volume>}"

if harness auth status --json 2>/dev/null | grep -q '"loggedIn":[[:space:]]*true'; then
  echo "[entrypoint] session found — starting the adapter"
  # Never fatal: a backend that is briefly unreachable must leave the box up and retryable, not kill
  # it and take the volume's session out of reach with it.
  harness start || echo "[entrypoint] WARNING: 'harness start' failed; the box stays up — retry from the host"
else
  echo "[entrypoint] no SSO session yet — sign in with:"
  echo "[entrypoint]     bash cli/scripts/remote-machine.sh login"
fi

echo "[entrypoint] ready; holding the container open"
# `exec` so tini's one child is tail itself, and the SIGTERM tini forwards on `docker stop` ends it at
# once rather than waiting out the 10s grace period on a shell that is ignoring it. Reaping is tini's
# job (pid 1, see the Dockerfile's ENTRYPOINT) — tail never waits on anything.
exec tail -f /dev/null
