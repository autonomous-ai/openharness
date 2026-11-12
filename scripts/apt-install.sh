#!/usr/bin/env bash
# Installs Ubuntu packages on a CI runner, as root (`sudo bash scripts/apt-install.sh PACKAGE...`), riding out an
# outage of the runner's Ubuntu mirrors.
#
# One DNS outage there failed all eight CLI end-to-end shards before any test ran (run 43039005877, 2026-11-11,
# #4186): `apt-get update` could not resolve a mirror for six minutes, said the indexes were "ignored, or old ones used
# instead" and exited 0, and the one `apt-get install` after it could not fetch a package. So the network part (the
# indexes, then the packages, downloaded only) is tried up to three times, each command bounded, with a wait that
# doubles between attempts, and apt retries each file itself as well. A blip costs a wait; an outage that lasts fails
# in under 20 minutes, naming apt. The install from what was downloaded needs no network and runs once.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: apt-install.sh PACKAGE..." >&2
  exit 2
fi

ATTEMPTS=3
# A healthy update and download take seconds; one that could not resolve a mirror took three and a half minutes.
COMMAND_S=180
apt=(apt-get -q -o Acquire::Retries=3)

attempt=1
wait_s=30
until timeout "$COMMAND_S" "${apt[@]}" update \
  && timeout "$COMMAND_S" "${apt[@]}" install -y --no-install-recommends --download-only "$@"; do
  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "::error title=apt::apt could not download $* from the runner's Ubuntu mirrors after $ATTEMPTS attempts"
    exit 1
  fi
  echo "apt: attempt $attempt of $ATTEMPTS could not download; trying again in ${wait_s}s"
  sleep "$wait_s"
  attempt=$((attempt + 1))
  wait_s=$((wait_s * 2))
done
exec "${apt[@]}" install -y --no-install-recommends "$@"
