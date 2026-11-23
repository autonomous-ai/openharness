#!/usr/bin/env bash
# Does an AppImage start the way a double-click starts it, on a computer with no libfuse2: its runtime mounts the image
# with FUSE and runs what is in it. Within 60 s a process of the run must have its executable under the runtime's mount
# ($TMPDIR/.mount_*), with APPIMAGE_EXTRACT_AND_RUN unset; the runtime exiting first is a failure, named by the first
# line it printed.
#
#   bash device-app/scripts/e2e/appimage-starts.sh <AppImage> <name>
#
# Run it under `xvfb-run -a dbus-run-session --`, where `ldconfig -p` names no libfuse.so.2: it refuses otherwise, as
# a runtime that needs libfuse2 would start there too. It prints `note: <name>: <file -L's description of the AppImage>`
# (the runtime in front: `static-pie linked` needs no libfuse2), then `ok: <name> starts from its FUSE mount`, or
# `FAILED: <name>: <why>` and exits 1.
#
# Everything it starts runs in a session of its own, under a scratch HOME, XDG folders and TMPDIR, and goes with it;
# the Device app's state is seeded so it installs nothing.
set -euo pipefail

WAIT=60

[[ $# -eq 2 && -f "$1" && -x "$1" && -n "$2" ]] || {
  echo "usage: appimage-starts.sh <AppImage> <name>" >&2
  exit 2
}
appimage="$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
name="$2"
: "${DISPLAY:?appimage-starts.sh: run it under xvfb-run -a dbus-run-session --}"
: "${DBUS_SESSION_BUS_ADDRESS:?appimage-starts.sh: run it under xvfb-run -a dbus-run-session --}"
: "${XAUTHORITY:?appimage-starts.sh: run it under xvfb-run -a dbus-run-session --}"
# From /sbin too, which a person's PATH may leave out (Debian's): no list is a refusal, never a pass.
libs="$(PATH="$PATH:/usr/sbin:/sbin" ldconfig -p)" || {
  echo "appimage-starts.sh: ldconfig -p gave no list: it cannot tell whether libfuse2 is here" >&2
  exit 2
}
if grep -q 'libfuse\.so\.2' <<<"$libs"; then
  echo "appimage-starts.sh: ldconfig -p names libfuse.so.2: an ok here would not say the AppImage needs no libfuse2" >&2
  exit 2
fi

# Resolved, so the executables' paths under the mount begin with it.
work="$(cd "$(mktemp -d)" && pwd -P)"
mkdir -p "$work"/{home,config,data,cache,state,run,tmp}
chmod 700 "$work/run"

app_pid=""

gone() { [[ ! -e "/proc/$1" ]] || [[ "$(sed 's/.*) //' "/proc/$1/stat" | cut -d' ' -f1)" == Z ]]; }
group_gone() {
  local pid
  for pid in $(pgrep -g "$1"); do gone "$pid" || return 1; done
}

# Runs the command until it succeeds, for WAIT seconds at most.
waits() {
  local deadline=$((SECONDS + WAIT))
  until "$@"; do
    ((SECONDS < deadline)) || return 1
    sleep 0.1
  done
}

cleanup() {
  set +e
  if [[ -n "$app_pid" ]]; then
    # TERM first: the runtime unmounts on it, a KILL leaves the mount behind.
    kill -TERM -- "-$app_pid" 2>/dev/null
    WAIT=10 waits group_gone "$app_pid" || kill -KILL -- "-$app_pid" 2>/dev/null
    wait "$app_pid" 2>/dev/null
  fi
  # A mount left behind holds the scratch folder: it is let go lazily, then the folder can be removed.
  awk -v under="$work/tmp/.mount_" 'index($2, under) == 1 { print $2 }' /proc/mounts | while read -r mount; do
    fusermount3 -uz "$mount" 2>/dev/null || fusermount -uz "$mount" 2>/dev/null
  done
  rm -rf "$work"
}
trap cleanup EXIT

# Only this machine's system folders and the scratch ones; APPIMAGE_EXTRACT_AND_RUN is left out. XAUTHORITY is
# xvfb-run's cookie: without it Xvfb refuses the app ("Authorization required").
base=(HOME="$work/home" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/sh LANG=C.UTF-8 TMPDIR="$work/tmp"
  PATH=/usr/local/bin:/usr/bin:/bin
  XDG_CONFIG_HOME="$work/config" XDG_DATA_HOME="$work/data" XDG_CACHE_HOME="$work/cache" XDG_STATE_HOME="$work/state"
  XDG_RUNTIME_DIR="$work/run" XDG_SESSION_TYPE=x11 DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY"
  DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" NO_AT_BRIDGE=1)

# The Device app's state: the CLI was seen and sign-in and the login item asked, so it installs nothing and opens no
# window. Another app never reads it.
mkdir -p "$work/data/ai.autonomous.harness.device"
printf '%s\n' '{"version":1,"cliSeen":true,"askedSignIn":true,"loginItem":true}' \
  >"$work/data/ai.autonomous.harness.device/state.json"

echo "note: $name: $(file -L -b "$appimage")"

from_mount() {
  local pid exe
  for pid in $(pgrep -g "$app_pid"); do
    exe="$(readlink "/proc/$pid/exe" 2>/dev/null)" || continue
    [[ "$exe" != "$work/tmp/.mount_"* ]] || return 0
  done
  return 1
}

# In a session of its own, so its whole process group, the runtime's FUSE server in it, ends together.
setsid env -i "${base[@]}" "$appimage" >"$work/out" 2>&1 &
app_pid=$!
why=""
deadline=$((SECONDS + WAIT))
until from_mount; do
  if group_gone "$app_pid"; then
    why="$(head -n 1 "$work/out" | tr -d '\r')"
    why="${why:-it exited and printed nothing}"
    break
  fi
  if ((SECONDS >= deadline)); then
    why="nothing ran from a FUSE mount within $WAIT s"
    break
  fi
  sleep 0.1
done

if [[ -n "$why" ]]; then
  echo "FAILED: $name: $why"
  echo "--- its output"
  head -n 20 "$work/out" | sed 's/^/  /'
  exit 1
fi
echo "ok: $name starts from its FUSE mount"
