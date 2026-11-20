#!/usr/bin/env bash
# Does an AppImage start the way a double-click starts it: its runtime mounts the image with FUSE and runs what is in
# it. Within 60 s a process of the run must have its executable under the runtime's mount ($TMPDIR/.mount_*), with
# APPIMAGE_EXTRACT_AND_RUN unset; the runtime exiting first is a failure, named by the first line it printed.
#
#   bash device-app/scripts/e2e/appimage-starts.sh <AppImage> <name>
#   bash device-app/scripts/e2e/appimage-starts.sh --wm-class <Device AppImage>
#
# Run it under `xvfb-run -a dbus-run-session --`. It prints `note: <name>: <file -L's description of the AppImage>`
# (the runtime in front: `static-pie linked` needs no libfuse2, `dynamically linked` may), then
# `ok: <name> starts from its FUSE mount` or `FAILED: <name>: <why>`. Before a runtime is fixed, an AppImage that needs
# FUSE is the finding, not a broken run: a FAILED exits 1 only with EXPECT=start, else 0.
#
# --wm-class starts the Device app unpacked (APPIMAGE_EXTRACT_AND_RUN=1, so FUSE plays no part) with an empty state and
# the fake CLI signed out, so its first window, Sign in, opens; it prints
# `note: Harness Device window WM_CLASS = "<instance>", "<class>"`, or a note that no window opened within 60 s.
#
# Everything it starts runs in a session of its own, under a scratch HOME, XDG folders and TMPDIR, and goes with it;
# the Device app's state is seeded so it installs nothing.
set -euo pipefail

WAIT=60

usage() {
  echo "usage: appimage-starts.sh <AppImage> <name> | appimage-starts.sh --wm-class <Device AppImage>" >&2
  exit 2
}

wm_class=""
if [[ $# -eq 2 && "$1" == --wm-class ]]; then
  wm_class=1
  set -- "$2" "Harness Device"
fi
[[ $# -eq 2 && -f "$1" && -x "$1" && -n "$2" ]] || usage
appimage="$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"
name="$2"
: "${DISPLAY:?appimage-starts.sh: run it under xvfb-run -a dbus-run-session --}"
: "${DBUS_SESSION_BUS_ADDRESS:?appimage-starts.sh: run it under xvfb-run -a dbus-run-session --}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fake_cli="$(dirname "$(dirname "$here")")/src-tauri/tests/fake-harness"
# With no CLI and an empty state, the app would run the real install lines.
[[ -z "$wm_class" || -x "$fake_cli" ]] || {
  echo "appimage-starts.sh: no fake CLI at $fake_cli" >&2
  exit 2
}

# Resolved, so the executables' paths under the mount begin with it.
work="$(cd "$(mktemp -d)" && pwd -P)"
mkdir -p "$work"/{home,config,data,cache,state,run,tmp,fake}
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

# Only this machine's system folders and the scratch ones; APPIMAGE_EXTRACT_AND_RUN is left out.
base=(HOME="$work/home" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/sh LANG=C.UTF-8 TMPDIR="$work/tmp"
  PATH=/usr/local/bin:/usr/bin:/bin
  XDG_CONFIG_HOME="$work/config" XDG_DATA_HOME="$work/data" XDG_CACHE_HOME="$work/cache" XDG_STATE_HOME="$work/state"
  XDG_RUNTIME_DIR="$work/run" XDG_SESSION_TYPE=x11 DISPLAY="$DISPLAY"
  DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" NO_AT_BRIDGE=1)

# In a session of its own, so its whole process group, the runtime's FUSE server in it, ends together.
launch() {
  setsid env -i "${base[@]}" "$@" "$appimage" >"$work/out" 2>&1 &
  app_pid=$!
}

window=""
# A window of the run's on the display, by the pid the toolkit gives it.
shown() {
  local pid
  for pid in $(pgrep -g "$app_pid"); do
    window="$(xdotool search --onlyvisible --pid "$pid" 2>/dev/null | head -n 1 || true)"
    [[ -z "$window" ]] || return 0
  done
  return 1
}

if [[ -n "$wm_class" ]]; then
  printf '%s\n' '{"loggedIn":false}' >"$work/fake/auth_status_--json"
  printf '%s\n' '0.6.99' >"$work/fake/--version"
  printf '%s\n' '{"attached":false}' '@stdin' >"$work/fake/hardware_watch_--json"
  launch APPIMAGE_EXTRACT_AND_RUN=1 HARNESS_DEVICE_CLI="$fake_cli" FAKE_HARNESS="$work/fake"
  if waits shown; then
    # A window gone again, or one with no WM_CLASS, prints xprop's own words.
    class="$(xprop -id "$window" WM_CLASS 2>&1 || true)"
    echo "note: $name window WM_CLASS = ${class#*= }"
  else
    echo "note: $name opened no window within $WAIT s; its first output line: $(head -n 1 "$work/out")"
  fi
  exit 0
fi

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

launch
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

if [[ -z "$why" ]]; then
  echo "ok: $name starts from its FUSE mount"
else
  echo "FAILED: $name: $why"
  echo "--- its output"
  head -n 20 "$work/out" | sed 's/^/  /'
  if [[ "${EXPECT:-}" == start ]]; then exit 1; fi
fi
