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
#
# A regional mirror that answers but crawls cut off all three attempts of the dial hosts job (run 45331534043,
# 2026-11-24, #4578 and #4586): apt's mirror list moves to the next mirror only on an error, never on slowness. So the
# retries fetch from Ubuntu's main archive instead.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: apt-install.sh PACKAGE..." >&2
  exit 2
fi

ATTEMPTS=3
# A healthy update and download take seconds; one that could not resolve a mirror took three and a half minutes.
COMMAND_S=180
apt=(apt-get -q -o Acquire::Retries=3)

# Points apt's sources, and the mirror lists they read (`mirror+file:PATH`), from regional mirrors
# (us-east-2.ec2.archive.ubuntu.com, azure.archive.ubuntu.com) to archive.ubuntu.com. Every other host stays. Sets
# main_archive only when the sources then name archive.ubuntu.com: an ARM runner's are all on ports.ubuntu.com, and its
# log must not claim a mirror it never used.
main_archive=
use_main_archive() {
  local SOURCELIST SOURCEPARTS file files=() mirror_lists
  eval "$(apt-config shell SOURCELIST Dir::Etc::sourcelist/f SOURCEPARTS Dir::Etc::sourceparts/d)"
  for file in "$SOURCELIST" "$SOURCEPARTS"*.list "$SOURCEPARTS"*.sources; do
    [ -f "$file" ] && files+=("$file")
  done
  # With no file named, grep and perl would read the step's input and could wait there for good.
  [ "${#files[@]}" -gt 0 ] || return 0
  mirror_lists=$(grep -ho 'mirror+file:[^[:space:]]*' "${files[@]}" | sed 's/^mirror+file://' | sort -u)
  for file in $mirror_lists; do
    [ -f "$file" ] && files+=("$file")
  done
  perl -pi -e 's{://[A-Za-z0-9.-]+\.archive\.ubuntu\.com}{://archive.ubuntu.com}g' "${files[@]}"
  grep -q '://archive\.ubuntu\.com' "${files[@]}" && main_archive=archive.ubuntu.com
}

attempt=1
wait_s=30
until timeout "$COMMAND_S" "${apt[@]}" update \
  && timeout "$COMMAND_S" "${apt[@]}" install -y --no-install-recommends --download-only "$@"; do
  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "::error title=apt::apt could not download $* from the runner's Ubuntu" \
      "mirrors${main_archive:+ and $main_archive} after $ATTEMPTS attempts"
    exit 1
  fi
  [ "$attempt" -eq 1 ] && use_main_archive
  echo "apt: attempt $attempt of $ATTEMPTS could not download; trying again" \
    "in ${wait_s}s${main_archive:+ from $main_archive}"
  sleep "$wait_s"
  attempt=$((attempt + 1))
  wait_s=$((wait_s * 2))
done
exec "${apt[@]}" install -y --no-install-recommends "$@"
