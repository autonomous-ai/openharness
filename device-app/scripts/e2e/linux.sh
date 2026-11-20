#!/usr/bin/env bash
# End to end on Linux: a debug build's AppImage against the fake CLI (src-tauri/tests/fake-harness), a fake tray host
# (sni-watcher.py), X11, headless sway and a scripted Hyprland (hypr-fake.py).
#
#   bash device-app/scripts/e2e/linux.sh <AppImage>
#   bash device-app/scripts/e2e/linux.sh --update OUT   update-pair.sh's 0.0.1 becomes 0.0.2 from 127.0.0.1:8765
#
# Prints `ok: <check>` for each check, `note:` for what it saw but does not judge, and stops at the first
# `FAILED: <check>`, exiting 1. Everything it runs is its own and goes with it: a scratch HOME and XDG folders, its own
# D-Bus session, Xvfb display, window manager and compositor, a fake xdg-open and a fake desktop app; never an account,
# a backend or a person's apps. On a GitHub-hosted runner only, a last part runs the app's own install lines: the CDN's
# install script, sudo for its packages, and the CLI it installs, signed out, with a backend that does not resolve.
# It needs xvfb openbox xdotool xterm sway foot dbus-x11 python3-dbus python3-gi and FUSE for the AppImage (libfuse2);
# where FUSE is missing, APPIMAGE_EXTRACT_AND_RUN=1 runs it unpacked.
set -euo pipefail

# Its own session bus, which ends with it.
if [[ -z "${E2E_OWN_BUS:-}" ]]; then
  E2E_OWN_BUS=1 exec dbus-run-session -- bash "$0" "$@"
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fake_cli="$(dirname "$(dirname "$here")")/src-tauri/tests/fake-harness"
python=/usr/bin/python3
# Every wait ends on what it waits for, bounded by this: a slow arm64 runner starts the AppImage in seconds. An update
# by UPDATE_WAIT, from the launch.
WAIT=60
UPDATE_WAIT=300
PORT=8765
# The system's folders, where the app looks for a CLI after the scratch HOME's.
APP_PATH=/usr/local/bin:/usr/bin:/bin

stop_before() {
  echo "linux.sh: $*" >&2
  exit 2
}

update=""
if [[ $# -eq 2 && "$1" == --update && -d "$2" ]]; then
  update="$(cd "$2" && pwd)"
  case "$(uname -m)" in
    x86_64) released=Harness-Device-linux-x64.AppImage ;;
    aarch64) released=Harness-Device-linux-arm64.AppImage ;;
  esac
  set -- "$update/0.0.1/${released:-}"
fi
[[ $# -eq 1 && -f "$1" ]] || {
  echo "usage: linux.sh <AppImage> | linux.sh --update OUT (update-pair.sh's, for this arch)" >&2
  exit 2
}
# The app runs a harness it finds there whenever it runs without the fake, as a release build (the update's) does: that
# harness's daemon would outlive the run.
[[ -z "$(PATH="$APP_PATH" command -v harness)" ]] || stop_before "a harness is on $APP_PATH: the app would find it"
if [[ -n "$update" ]] && timeout 5 bash -c ": </dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then
  stop_before "127.0.0.1:$PORT is taken"
fi

work="$(mktemp -d)"
home="$work/home"
config="$work/config"
data_home="$work/data"
runtime="$work/run"
fake="$work/fake"
data="$data_home/ai.autonomous.harness.device"
entry="$config/autostart/harnessd.desktop"
mkdir -p "$home/My Apps" "$home/Desktop" "$config" "$data_home" "$runtime" "$fake" "$work/bin" "$work/procs" \
  "$work/apps" "$work/cache" "$work/state" "$work/tmp"
chmod 700 "$runtime"
# A folder with a space, as a person's may be: the entry's Exec= must quote it.
appimage="$home/My Apps/Harness-Device.AppImage"
cp "$1" "$appimage"
chmod +x "$appimage"
[[ "$appimage" =~ ^[A-Za-z0-9/._\ -]+$ ]] || {
  echo "linux.sh: the scratch folder's path holds a character the expected Exec= line does not quote" >&2
  exit 2
}

pids=()
app_pid=""
mark=0

gone() { [[ ! -e "/proc/$1" ]] || [[ "$(sed 's/.*) //' "/proc/$1/stat" | cut -d' ' -f1)" == Z ]]; }
group_gone() {
  local pid
  for pid in $(pgrep -g "$1"); do gone "$pid" || return 1; done
}
# Every process whose environment's HOME is the scratch one, which only this run's have.
with_scratch_home() {
  local proc
  for proc in /proc/[0-9]*; do
    ! grep -sqzFx -- "HOME=$home" "$proc/environ" || echo "${proc#/proc/}"
  done
}

cleanup() {
  set +e
  if [[ -n "$app_pid" ]]; then
    # TERM first: a KILL leaves the AppImage runtime's FUSE mount behind.
    kill -TERM -- "-$app_pid" 2>/dev/null
    WAIT=10 waits group_gone "$app_pid" || kill -KILL -- "-$app_pid" 2>/dev/null
  fi
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null; done
  # The fake CLI's runs, while they are still the fake's.
  if [[ -f "$fake/pids.log" ]]; then
    while read -r pid; do
      grep -qs fake-harness "/proc/$pid/cmdline" && kill "$pid" 2>/dev/null
    done <"$fake/pids.log"
  fi
  # What runs with the scratch HOME outside the app's group: the daemon a real `harness start` leaves, its tmux, a
  # terminal the app opened.
  for pid in $(with_scratch_home); do
    kill "$pid" 2>/dev/null
    WAIT=10 waits gone "$pid" || kill -KILL "$pid" 2>/dev/null
  done
  wait 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT

ok() { echo "ok: $1"; }
note() { echo "note: $1"; }

fail() {
  echo "FAILED: $1"
  echo "--- the app's log"
  log_text | tail -n 60
  echo "--- the fake CLI's calls"
  cat "$fake/calls.log" 2>/dev/null
  echo "--- the tray items registered"
  cat "$work/tray-items" 2>/dev/null
  echo "--- the requests served"
  cat "$work/server.log" 2>/dev/null
  echo "--- the app's output"
  tail -n 40 "$work/app.out" 2>/dev/null
  exit 1
}

# Runs the command until it succeeds, for WAIT seconds at most.
waits() {
  local deadline=$((SECONDS + WAIT))
  until "$@"; do
    ((SECONDS < deadline)) || return 1
    sleep 0.1
  done
}

started() { pids+=("$!"); }

# The app's own environment: nothing of this machine's but its system folders.
base=(HOME="$home" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/sh LANG=C.UTF-8 TMPDIR="$work/tmp"
  PATH="$work/bin:$APP_PATH"
  XDG_CONFIG_HOME="$config" XDG_DATA_HOME="$data_home" XDG_CACHE_HOME="$work/cache" XDG_STATE_HOME="$work/state"
  XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" NO_AT_BRIDGE=1)
[[ -z "${APPIMAGE_EXTRACT_AND_RUN:-}" ]] || base+=(APPIMAGE_EXTRACT_AND_RUN="$APPIMAGE_EXTRACT_AND_RUN")

# --- The display, its window manager, the tray host

exec 3>"$work/display"
Xvfb -displayfd 3 -screen 0 1280x800x24 -nolisten tcp >"$work/xvfb.out" 2>&1 &
started
exec 3>&-
waits grep -q '[0-9]' "$work/display" || fail "Xvfb starts"
DISPLAY=":$(head -n 1 "$work/display")"
export DISPLAY
base+=(DISPLAY="$DISPLAY")
env -i "${base[@]}" openbox --sm-disable >"$work/openbox.out" 2>&1 &
started
# Only a window manager that follows EWMH sets the desktops' count, as it sets the active window.
waits xdotool get_num_desktops >/dev/null 2>&1 || fail "openbox starts"

watcher_pid=""
start_watcher() {
  rm -f "$work/tray-items"
  env -i "${base[@]}" "$python" "$here/sni-watcher.py" serve "$work/tray-items" >>"$work/watcher.out" 2>&1 &
  watcher_pid=$!
  pids+=("$watcher_pid")
  waits test -e "$work/tray-items" || fail "the fake tray host takes its name"
}

watcher_owned() {
  dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
    org.freedesktop.DBus.NameHasOwner string:org.kde.StatusNotifierWatcher | grep -q 'boolean true'
}

stop_watcher() {
  kill "$watcher_pid"
  waits eval '! watcher_owned' || fail "the fake tray host lets its name go"
}

tray_items() { if [[ -f "$work/tray-items" ]]; then wc -l <"$work/tray-items"; else echo 0; fi; }
tray_registered() { [[ "$(tray_items)" -ge 1 ]]; }

# Clicks a row of the tray's menu, as a tray host does.
click() {
  waits "$python" "$here/sni-watcher.py" click "$work/tray-items" "$1" 2>>"$work/click.err" \
    || fail "the menu's $1 row can be clicked"
}

# --- The fake CLI, xdg-open and desktop app

script() {
  local name="$1"
  shift
  printf '%s\n' "$@" >"$fake/$name"
}
script 'hardware_watch_--json' '{"attached":false}' '@record'
script 'auth_status_--json' '{"loggedIn":false}'
script '--version' '0.6.99'
script 'logs_export_--json' "{\"path\":\"$home/Desktop/harness-logs-20261120-1200.zip\"}"
# .invalid never resolves: whatever opens the page reaches no one.
script 'login_--json' '{"type":"authorize_url","url":"https://example.invalid/e2e?state=S"}' '@stdin'

# A GTK program, as a browser or the desktop app is: what it prints, then `ran` if it got that far.
cat >"$work/gtk-probe.py" <<'PY'
import sys
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf, Gio, Gtk
if not Gtk.init_check(sys.argv)[0]:
    sys.exit("no display")
Gio.AppInfo.get_all()
GdkPixbuf.Pixbuf.get_formats()
window = Gtk.Window(title="probe")
window.show_all()
while Gtk.events_pending():
    Gtk.main_iteration()
print("ran")
PY

# What it was given goes last: a run waits on that line, then reads the rest.
for opener in xdg-open desktop-app; do
  cat >"$work/$opener" <<SH
#!/bin/sh
env >"$work/$opener.env"
$python "$work/gtk-probe.py" >"$work/$opener.probe" 2>&1
printf '%s\n' "\$*" >>"$work/$opener.log"
SH
  chmod +x "$work/$opener"
done
mv "$work/xdg-open" "$work/bin/xdg-open"
mv "$work/desktop-app" "$work/apps/Harness.AppImage"

env -i "${base[@]}" "$python" "$work/gtk-probe.py" >"$work/clean.probe" 2>&1
grep -qx ran "$work/clean.probe" || fail "a GTK program runs on the test display: $(cat "$work/clean.probe")"

# The variables a program the app starts gets from the AppImage's runtime, not from the app's own environment.
from_appimage() {
  comm -13 <(sort "$work/launch.env") <(sort "$1") | cut -d= -f1 | grep -vx 'PWD\|SHLVL\|_\|OLDPWD' | sort -u \
    | tr '\n' ' '
}

# Whether a GTK program started from the app runs as it does without the AppImage's environment: kept, with what that
# environment held, for the last check.
probe() {
  local stem="$1" who="$2" extra
  note "$who inherits from the AppImage: $(from_appimage "$work/$stem.env")"
  if ! grep -qx ran "$work/$stem.probe"; then
    broken+=("$who: $(grep -m 1 -i error "$work/$stem.probe" || tail -n 1 "$work/$stem.probe");")
    return
  fi
  extra="$(grep -vxFf "$work/clean.probe" "$work/$stem.probe" || true)"
  [[ -z "$extra" ]] || note "a GTK program run by $who prints what it does not without the AppImage: $extra"
}
broken=()

# --- The app

log_text() { cat "$data"/logs/app-*.log 2>/dev/null || true; }
# This run's log lines, without their time.
run_log() { log_text | tail -c +$((mark + 1)) | cut -d' ' -f2-; }
logged() { run_log | grep -Fxq -- "$1"; }
times_logged() { run_log | grep -Fxc -- "$1" || true; }
fronts() { grep -c '^{"front":' "$fake/stdin.log" 2>/dev/null || true; }
told() { grep -Fxqs -- "{\"front\":\"$1\"}" "$fake/stdin.log"; }
# The watch was told more than `$1` apps, the last `$2`.
told_since() {
  [[ "$(fronts)" -gt "$1" && "$(grep '^{"front":' "$fake/stdin.log" | tail -n 1)" == "{\"front\":\"$2\"}" ]]
}
# Runs the command after `$1`, which brings that app to the front, and waits until a new line tells the watch so.
brought() {
  local name="$1" since
  shift
  since="$(fronts)"
  "$@"
  waits told_since "$since" "$name"
}

MENU="menu: Plug in your device | Sign in… | Export logs | About | Quit"

# Starts the app in a session of its own, so its whole process group ends together. The arguments are the session's
# variables.
launch() {
  mark=$(log_text | wc -c)
  printf '%s\n' "${base[@]}" "$@" >"$work/launch.env"
  setsid env -i "${base[@]}" "$@" "$appimage" >>"$work/app.out" 2>&1 &
  app_pid=$!
}

fakes_gone() {
  local pid
  while read -r pid; do
    if grep -qs fake-harness "/proc/$pid/cmdline"; then return 1; fi
  done < <(cat "$fake/pids.log" 2>/dev/null)
}

# Ends the app, then waits for the fake CLI's runs, which end when its pipes close, and clears what they wrote.
stop_app() {
  gone "$app_pid" && fail "the app runs until it is ended"
  kill -TERM -- "-$app_pid"
  waits gone "$app_pid" || fail "the app ends on SIGTERM"
  wait "$app_pid" 2>/dev/null || true
  app_pid=""
  waits fakes_gone || fail "the fake CLI's runs end with the app"
  rm -f "$fake"/{calls,pids,ends,stdin}.log "$work"/{xdg-open,desktop-app}.{log,env,probe}
}

save_state() {
  mkdir -p "$data"
  chmod 700 "$data"
  printf '{"version":1,"cliSeen":true,"askedSignIn":%s,"loginItem":%s}\n' "$1" "$2" >"$data/state.json"
}

# The entry's Exec= for this AppImage and the launcher in the scratch HOME: loginitem_linux.rs exec_line.
own_exec="Exec=/bin/sh -c \"[ -x '$appimage' ] && exec '$appimage'; exec '$home/.local/bin/harness' start\""

# --- The update: 0.0.1 from update-pair.sh, with no CLI and nothing in its way, finds 0.0.2 at 127.0.0.1:8765 and
# becomes it

served() { grep -c '"GET /metadata.json ' "$work/server.log" || true; }
checked() { [[ "$(served)" -ge "$1" ]]; }
# Tauri starts the new AppImage, which stays in the session's process group, then the old one exits.
relaunched() {
  local pid
  for pid in $(pgrep -g "$app_pid"); do
    [[ "$(readlink "/proc/$pid/exe")" == */usr/bin/harness-device ]] && ! gone "$pid" && return 0
  done
  return 1
}

if [[ -n "$update" ]]; then
  # cliSeen, askedSignIn and loginItem: nothing is installed and no window opens.
  save_state true true
  "$python" -m http.server "$PORT" --bind 127.0.0.1 --directory "$update" >"$work/server.log" 2>&1 &
  started
  waits curl -fs --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/0.0.1/" \
    || fail "the manifest is served on 127.0.0.1:$PORT"

  from=$SECONDS
  launch XDG_SESSION_TYPE=x11
  WAIT=$UPDATE_WAIT waits logged "update: found 0.0.2" || fail "0.0.1 logs update: found 0.0.2"
  WAIT=$((UPDATE_WAIT - SECONDS + from)) waits logged "update: installed 0.0.2" \
    || fail "0.0.1 logs update: installed 0.0.2"
  ok "0.0.1 logs update: found 0.0.2, then update: installed 0.0.2"
  [[ "$(sha256sum <"$appimage")" == "$(sha256sum <"$update/0.0.2/$released")" ]] || fail "the AppImage is 0.0.2's"
  ok "the AppImage is 0.0.2's, byte for byte"

  waits gone "$app_pid" || fail "0.0.1 ends for the relaunch"
  # 0.0.1 asks again a minute after a check or download that failed: only a request from here on is the relaunched
  # app's.
  asked="$(served)"
  waits relaunched || fail "the app runs again after the update"
  WAIT=$((UPDATE_WAIT - SECONDS + from)) waits checked $((asked + 1)) || fail "the relaunched app checks the manifest"
  logged "instance: already running" && fail "the relaunched app takes the lock 0.0.1 let go"
  ok "the app runs again, 0.0.2, past its own lock, and checks the manifest"

  # A check starts only once the one before it was answered, so the relaunched app's second request shows its first was
  # answered: any update it found is logged by then.
  WAIT=$((UPDATE_WAIT - SECONDS + from)) waits checked $((asked + 2)) \
    || fail "the relaunched app checks again, a minute later"
  [[ "$(times_logged "update: found 0.0.2")" -eq 1 ]] || fail "0.0.2 finds no update: one update: found in the log"
  ok "0.0.2 checks the manifest and finds no update"
  echo "0 FAILED"
  exit 0
fi
# The install part's environment, which has no fake.
bare=("${base[@]}")
base+=(HARNESS_DEVICE_CLI="$fake_cli" FAKE_HARNESS="$fake")

# --- 1, 3, 7, 8, 9: X11, the tray host there, the first run

start_watcher
save_state true false
launch XDG_SESSION_TYPE=x11
waits logged "$MENU" || fail "the menu reads Plug in your device | Sign in… | Export logs | About | Quit"
waits tray_registered || fail "the tray registers with the tray host"
ok "the tray registers with the tray host"
ok "the menu reads Plug in your device | Sign in… | Export logs | About | Quit"

waits logged "login item: registered" || fail "the first run registers the login item"
printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=Harness' "$own_exec" 'X-GNOME-Autostart-enabled=true' \
  >"$work/entry.expected"
cmp -s "$work/entry.expected" "$entry" || fail "the first run writes harnessd.desktop with the app's Exec="
[[ "$(ls -A "$config/autostart")" == harnessd.desktop ]] || fail "the login item is the one harnessd.desktop"
ok "the first run writes the one harnessd.desktop, with the app's Exec="

cp "$(command -v xterm)" "$work/procs/code"
env -i "${base[@]}" xterm -T e2e-xterm -e sleep 600 >>"$work/xterm.out" 2>&1 &
started
env -i "${base[@]}" "$work/procs/code" -T e2e-code -e sleep 600 >>"$work/xterm.out" 2>&1 &
started
waits xdotool search --name '^e2e-xterm$' >/dev/null || fail "an xterm opens"
waits xdotool search --name '^e2e-code$' >/dev/null || fail "an xterm copied as code opens"
xterm_window="$(xdotool search --name '^e2e-xterm$' | head -n 1)"
code_window="$(xdotool search --name '^e2e-code$' | head -n 1)"
activate() { timeout 10 xdotool windowactivate --sync "$1" || fail "xdotool brings a window to the front"; }
# openbox brings each window to the front as it maps, so the watch may know both already: the moves count from code.
activate "$code_window"
waits told_since 0 code || fail "X11: the watch is told code, in front"
brought xterm activate "$xterm_window" || fail "X11: the watch is told xterm when it comes to the front"
brought code activate "$code_window" || fail "X11: the watch is told code when it comes to the front"
brought xterm activate "$xterm_window" || fail "X11: the watch is told xterm when it comes back to the front"
ok "X11: the watch is told xterm, code, then xterm again, each as it comes to the front"

click "Export logs"
waits grep -Fxqs "$home/Desktop" "$work/xdg-open.log" || fail "Export logs opens the zip's folder with xdg-open"
logged "logs: exported" || fail "Export logs logs logs: exported"
ok "Export logs hands xdg-open the zip's folder"

# In a session of its own too, so one that hangs ends with its whole group, the AppImage runtime's FUSE server in it.
setsid env -i "${base[@]}" XDG_SESSION_TYPE=x11 "$appimage" >>"$work/app.out" 2>&1 &
second=$!
if ! waits gone "$second"; then
  # Its group may end between the wait and the kill: the check still fails, by name.
  kill -TERM -- "-$second" 2>/dev/null || true
  fail "a second launch exits by itself"
fi
wait "$second" || fail "a second launch exits with 0"
[[ "$(times_logged "instance: already running")" -eq 1 ]] || fail "a second launch logs instance: already running"
gone "$app_pid" && fail "the first launch keeps running"
[[ "$(tray_items)" -eq 1 ]] || fail "a second launch adds no tray icon"
ok "a second launch exits with instance: already running, and the first keeps its one tray icon"

logged "tray: no host" && fail "with a tray host, the log has no tray: no host"
ok "with a tray host, the log has no tray: no host"
stop_app

# --- 2, 6, 7: no tray host, a Wayland desktop with no source, the second run

stop_watcher
cp "$entry" "$work/entry.before"
launch XDG_SESSION_TYPE=wayland
waits logged "$MENU" || fail "Wayland: the menu reads as on X11"
waits logged "tray: no host" || fail "with no tray host, the log has tray: no host"
[[ "$(times_logged "tray: no host")" -eq 1 ]] || fail "tray: no host is logged once"
ok "with no tray host, the log has tray: no host, once"

activate "$xterm_window"
activate "$code_window"
[[ "$(fronts)" -eq 0 ]] || fail "a Wayland session with neither sway nor Hyprland tells the watch no app"
run_log | grep -q '^front:' && fail "a Wayland session with neither sway nor Hyprland logs no front: line"
ok "a Wayland session with neither sway nor Hyprland tells no app and logs no front: line"

cmp -s "$work/entry.before" "$entry" || fail "a second run leaves the entry's bytes"
ok "a second run leaves harnessd.desktop as it is"
stop_app

# --- 4, 7: sway, an entry the person turned off

printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=Harness' 'Exec="/opt/other/harness" start' 'Hidden=true' \
  >"$entry"
cp "$entry" "$work/entry.before"

printf 'xwayland disable\n' >"$work/sway.conf"
env -i "${base[@]}" WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman sway -c "$work/sway.conf" \
  >"$work/sway.out" 2>&1 &
started
sway_pid=$!
swaysock="$runtime/sway-ipc.$(id -u).$sway_pid.sock"
waits swaymsg -s "$swaysock" -t get_version >/dev/null 2>&1 || fail "headless sway starts: $(tail -n 5 "$work/sway.out")"
wayland="$(cd "$runtime" && find . -maxdepth 1 -name 'wayland-*' ! -name '*.lock' -printf '%f\n' | head -n 1)"
[[ -n "$wayland" ]] || fail "headless sway has a Wayland socket"
cp "$(command -v foot)" "$work/procs/kitty"
env -i "${base[@]}" WAYLAND_DISPLAY="$wayland" foot --title=e2e-foot sleep 600 >>"$work/sway.out" 2>&1 &
started
env -i "${base[@]}" WAYLAND_DISPLAY="$wayland" "$work/procs/kitty" --title=e2e-kitty sleep 600 >>"$work/sway.out" 2>&1 &
started
sway_has() { swaymsg -s "$swaysock" -t get_tree | grep -Eq "\"name\": ?\"$1\""; }
waits sway_has e2e-foot || fail "foot opens on sway"
waits sway_has e2e-kitty || fail "foot copied as kitty opens on sway"

launch XDG_SESSION_TYPE=wayland SWAYSOCK="$swaysock" WAYLAND_DISPLAY="$wayland" GDK_BACKEND=x11
waits logged "$MENU" || fail "sway: the menu reads as on X11"
focus() { swaymsg -s "$swaysock" "[title=\"^e2e-$1\$\"] focus" >/dev/null || fail "swaymsg focuses $1"; }
# The source first tells the window in focus, kitty, opened last: the moves count from it.
focus kitty
waits told_since 0 kitty || fail "sway: the watch is told kitty, in focus"
brought foot focus foot || fail "sway: the watch is told foot when it takes the focus"
brought kitty focus kitty || fail "sway: the watch is told kitty when it takes the focus"
brought foot focus foot || fail "sway: the watch is told foot when it takes the focus back"
ok "sway: the watch is told foot, kitty, then foot again, each as it takes the focus"

cmp -s "$work/entry.before" "$entry" || fail "an entry with Hidden=true and another Exec= is left as it is"
ok "an entry turned off (Hidden=true), with another Exec=, is left as it is"
stop_app
kill "$sway_pid"

# --- 5, 7: Hyprland, the installer's entry

# The installer's own entry, and a line of the person's that a take-over keeps.
installers() {
  printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=Harness' "$1" 'X-GNOME-Autostart-enabled=true' 'X-E2E=kept'
}
installers "Exec=\"$home/.local/bin/harness\" start" >"$entry"
cp "$(command -v sleep)" "$work/procs/alacritty"
cp "$(command -v sleep)" "$work/procs/wezterm-gui"
"$work/procs/alacritty" 600 &
started
alacritty_pid=$!
"$work/procs/wezterm-gui" 600 &
started
wezterm_pid=$!

coproc HYPR { exec "$python" "$here/hypr-fake.py" "$runtime/hypr/e2e"; }
pids+=("$HYPR_PID")
hypr_in="${HYPR[1]}"
read -r -t "$WAIT" ready <&"${HYPR[0]}" && [[ "$ready" == ready ]] || fail "the scripted Hyprland listens"

launch XDG_SESSION_TYPE=wayland HYPRLAND_INSTANCE_SIGNATURE=e2e GDK_BACKEND=x11
waits logged "$MENU" || fail "Hyprland: the menu reads as on X11"
echo "$alacritty_pid" >&"$hypr_in"
waits told alacritty || fail "Hyprland: the watch is told the exe name of the pid j/activewindow answers"
echo "$wezterm_pid" >&"$hypr_in"
waits told wezterm-gui || fail "Hyprland: the watch is told the next one's"
ok "Hyprland: the watch is told alacritty, then wezterm-gui, the exe name of each pid j/activewindow answers"

waits logged "login item: updated" || fail "an entry that is on, with the installer's Exec=, is taken over"
installers "$own_exec" | cmp -s - "$entry" || fail "a taken-over entry has the app's Exec= and keeps the rest"
ok "an entry that is on, with the installer's Exec=, takes the app's Exec= and the log has login item: updated"
stop_app
exec {hypr_in}>&-

# --- 7, and a page and Open Harness from the AppImage: the sign-in window, the desktop app installed

rm "$entry"
save_state false true
mkdir -p "$data_home/applications"
printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=Harness' "Exec=\"$work/apps/Harness.AppImage\" %U" \
  >"$data_home/applications/harness.desktop"
start_watcher
launch XDG_SESSION_TYPE=x11
waits logged "menu: Plug in your device | Sign in… | Open Harness | Export logs | About | Quit" \
  || fail "with the desktop app installed, the menu has Open Harness"
[[ ! -e "$entry" ]] || fail "a deleted entry stays deleted"
ok "a deleted harnessd.desktop stays deleted"

# Return takes the window's primary answer, Sign in, once the page has drawn it.
sign_in() {
  local window
  window="$(xdotool search --onlyvisible --name '^Harness$' | head -n 1)" || return 1
  [[ -n "$window" ]] && timeout 10 xdotool windowactivate --sync "$window" key Return \
    && WAIT=3 waits grep -Fxqs 'login --json' "$fake/calls.log"
}
waits sign_in || fail "the Sign in window's Return starts harness login --json"
waits grep -Fxqs "https://example.invalid/e2e?state=S" "$work/xdg-open.log" \
  || fail "the sign-in page opens with xdg-open"
ok "the sign-in page opens with xdg-open"
probe xdg-open xdg-open

click "Open Harness"
waits test -s "$work/desktop-app.log" || fail "Open Harness runs the desktop app's AppImage"
ok "Open Harness runs the desktop app's AppImage"
probe desktop-app "the desktop app"
stop_app

[[ ${#broken[@]} -eq 0 ]] \
  || fail "a GTK program xdg-open or the desktop app starts runs in the environment the AppImage hands it: ${broken[*]}"
ok "a GTK program xdg-open or the desktop app starts runs in the environment the AppImage hands it"

# --- The app's own install lines, from a first run with no CLI and no state (Verification 7): a GitHub-hosted runner
# only, where sudo asks no password. Elsewhere `install.sh --host` would ask for one in a terminal on the test display,
# which nobody sees.

# cli.rs INSTALL_DEADLINE, each run's bound, and START_DEADLINE, the start's that follows.
INSTALL_WAIT=600
START_WAIT=90
# The line that says how the run named by its flag ended, once it has.
install_result() {
  run_log | grep -m 1 -E "^install: $1 (exit -?[0-9]+|killed|timed out after .*|could not start: .*)$" || true
}
install_ended() { [[ -n "$(install_result "$1")" ]]; }

if [[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]; then
  rm -rf "$data" "$config/autostart" "$data_home/applications"
  base=("${bare[@]}")
  # terminal.rs CANDIDATES: the first there is the app's.
  for terminal in x-terminal-emulator gnome-terminal xterm; do
    PATH="$APP_PATH" command -v "$terminal" >/dev/null && break
  done
  note "the terminal: $terminal, $(readlink -f "$(PATH="$APP_PATH" command -v "$terminal")")"
  # Only the CDN's install script and the public files it downloads are read. The CLI it installs and the daemon its
  # start runs stay signed out, and are given a backend that does not resolve.
  launch XDG_SESSION_TYPE=x11 BACKEND_WS_URL=wss://harness-e2e.invalid
  WAIT=$((INSTALL_WAIT + WAIT)) waits install_ended --host || fail "install.sh --host ends in its terminal"
  # Without one the app runs the line behind the screen, which would prove nothing of the terminal.
  logged "install: --host no terminal; run here" && fail "the app finds $terminal and runs install.sh --host in it"
  [[ "$(install_result --host)" == "install: --host exit 0" ]] \
    || fail "install.sh --host, in a terminal, exits 0: the log has $(install_result --host)"
  ok "install.sh --host runs in a terminal on the display and its host-<n>.exit reads 0"
  WAIT=$((INSTALL_WAIT + WAIT)) waits install_ended --desktop || fail "install.sh --desktop ends"
  [[ "$(install_result --desktop)" == "install: --desktop exit 0" ]] \
    || fail "install.sh --desktop exits 0: the log has $(install_result --desktop)"
  ok "install.sh --desktop exits 0"
  WAIT=$((START_WAIT + WAIT)) waits logged "$MENU" \
    || fail "with the CLI it installed, the menu reads Plug in your device | Sign in… | Export logs | About | Quit"
  ok "with the CLI it installed, the menu reads Plug in your device | Sign in… | Export logs | About | Quit"
  stop_app
else
  note "not a GitHub-hosted runner: the app's own install lines are not run here"
fi

echo "0 FAILED"
