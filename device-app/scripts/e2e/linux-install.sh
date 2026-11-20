#!/usr/bin/env bash
# End to end on Linux: the one-line install (website/scripts/device-install.sh), run exactly as a person runs it, on an
# Ubuntu with no libfuse2.
#
#   bash device-app/scripts/e2e/linux-install.sh <AppImage>
#
# The AppImage is this run's debug build. cdn.autonomous.ai is pointed at a local HTTPS server (https-fake-cdn.py)
# under a throwaway CA the system trusts, which serves the AppImage as release 0.0.0, a stand-in manifest naming it and
# the repository's install script, so the script runs unchanged and nothing reaches the real CDN or bucket. The line
# runs with a scratch HOME (with a space, as a person's may have) on a display and session bus of its own; the Device
# app's state is seeded so it installs nothing and opens no window.
#
# Prints `ok: <check>` for each check and stops at the first `FAILED: <check>`, exiting 1. It removes libfuse2 and
# changes /etc/hosts and the trust store, so it runs only on a GitHub-hosted runner, which is thrown away after; it
# puts /etc/hosts and the trust store back and ends what it started.
set -euo pipefail

stop_before() {
  echo "linux-install.sh: $*" >&2
  exit 2
}

[[ "${GITHUB_ACTIONS:-}" == true && -n "${RUNNER_TEMP:-}" ]] \
  || stop_before "it runs only on a GitHub-hosted runner: it removes libfuse2 and changes /etc/hosts and the trust store"
[[ $# -eq 1 && -f "$1" ]] || {
  echo "usage: linux-install.sh <AppImage>" >&2
  exit 2
}

# A display and a session bus of its own, which end with it. xvfb-run hands the app its XAUTHORITY.
if [[ -z "${E2E_OWN_DISPLAY:-}" ]]; then
  E2E_OWN_DISPLAY=1 exec xvfb-run -a -s '-screen 0 1280x800x24' dbus-run-session -- bash "$0" "$@"
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$(dirname "$(dirname "$here")")")"
vectors="$repo/tests/fixtures/app-list-entry-vectors.json"
python=/usr/bin/python3
# Every wait ends on what it waits for, bounded by this: a slow arm64 runner starts the AppImage in seconds.
WAIT=60
VERSION=0.0.0
CDN=cdn.autonomous.ai
CA_FILE=/usr/local/share/ca-certificates/harness-device-e2e.crt
APP_PATH=/usr/local/bin:/usr/bin:/bin

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64) arch=arm64 ;;
  *) stop_before "no Harness Device AppImage for $(uname -m)" ;;
esac
# The app runs a harness it finds there: that harness's daemon would outlive the run.
[[ -z "$(PATH="$APP_PATH" command -v harness)" ]] || stop_before "a harness is on $APP_PATH: the app would find it"
[[ ! -e "$CA_FILE" ]] || stop_before "$CA_FILE is there already"
grep -qw "$CDN" /etc/hosts && stop_before "/etc/hosts names $CDN already"

# Resolved, so the executables' paths under the AppImage's mount begin with it.
work="$(cd "$(mktemp -d -p "$RUNNER_TEMP")" && pwd -P)"
home="$work/home p"
data="$home/.local/share/ai.autonomous.harness.device"
place="$home/.local/opt/Harness-Device.AppImage"
entry="$home/.local/share/applications/harness-device.desktop"
icon="$home/.local/share/icons/harness-device.png"
cdn="$work/cdn"
served="$cdn/harness/device/$VERSION/Harness-Device-linux-$arch.AppImage"
mkdir -p "$home" "$work"/{run,tmp,tls,extract} "$(dirname "$served")" "$cdn/e2e"
chmod 700 "$work/run"
# The vectors' entry for a home with a space is this one's only when no other character needs quoting.
[[ "$place" =~ ^[A-Za-z0-9/._\ -]+$ ]] \
  || stop_before "the scratch folder's path holds a character the expected Exec= line does not quote"
cp "$1" "$served"
chmod 755 "$served"

server_pid=""
hosts_changed=""
app_pid=""

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

# Runs the command until it succeeds, for WAIT seconds at most.
waits() {
  local deadline=$((SECONDS + WAIT))
  until "$@"; do
    ((SECONDS < deadline)) || return 1
    sleep 0.1
  done
}

# Ends the app's whole session, TERM first: the runtime unmounts on it, a KILL leaves the mount behind.
end_app() {
  local group
  group="$(ps -o pgid= -p "$app_pid" | tr -d ' ')"
  app_pid=""
  [[ -n "$group" ]] || return 0
  kill -TERM -- "-$group" 2>/dev/null
  WAIT=10 waits group_gone "$group" || kill -KILL -- "-$group" 2>/dev/null
}

cleanup() {
  set +e
  [[ -z "$app_pid" ]] || end_app
  for pid in $(with_scratch_home); do
    kill "$pid" 2>/dev/null
    WAIT=10 waits gone "$pid" || kill -KILL "$pid" 2>/dev/null
  done
  # A mount left behind holds the scratch folder: it is let go lazily, then the folder can be removed.
  awk -v under="$work/tmp/.mount_" 'index($2, under) == 1 { print $2 }' /proc/mounts | while read -r mount; do
    fusermount3 -uz "$mount" 2>/dev/null || fusermount -uz "$mount" 2>/dev/null
  done
  # sudo hands the server the signal.
  [[ -z "$server_pid" ]] || sudo kill "$server_pid" 2>/dev/null
  wait 2>/dev/null
  [[ -z "$hosts_changed" ]] || sudo cp "$work/hosts.before" /etc/hosts
  if [[ -e "$CA_FILE" ]]; then
    sudo rm -f "$CA_FILE"
    sudo update-ca-certificates --fresh >/dev/null
  fi
  rm -rf "$work"
}
trap cleanup EXIT

ok() { echo "ok: $1"; }

fail() {
  echo "FAILED: $1"
  echo "--- the line's output"
  cat "$work/line.out" 2>/dev/null
  echo "--- the requests served"
  cat "$work/requests.log" 2>/dev/null
  echo "--- the app's log"
  cat "$data"/logs/app-*.log 2>/dev/null | tail -n 60
  exit 1
}

# --- libfuse2 gone, FUSE 3's fusermount3 there, as on a stock Ubuntu desktop

# dpkg-query exits 1 for a name this release does not know (libfuse2t64 on 22.04, libfuse2 on 24.04).
fuse2_installed() {
  dpkg-query -W -f='${db:Status-Status} ${Package}\n' libfuse2 libfuse2t64 2>/dev/null \
    | awk '$1 == "installed" { print $2 }' || true
}
mapfile -t installed < <(fuse2_installed)
if [[ ${#installed[@]} -gt 0 ]]; then sudo apt-get -q remove -y "${installed[@]}" >/dev/null; fi
if ! command -v fusermount3 >/dev/null; then
  echo "note: fusermount3 was missing: fuse3 installed"
  sudo bash "$repo/scripts/apt-install.sh" fuse3 >/dev/null
fi
[[ -z "$(fuse2_installed)" ]] || fail "libfuse2 is not on this computer: dpkg still has $(fuse2_installed)"
[[ "$(ldconfig -p | grep -c 'libfuse\.so\.2' || true)" == 0 ]] \
  || fail "libfuse2 is not on this computer: ldconfig -p names libfuse.so.2"
ok "libfuse2 is not on this computer (removed: ${installed[*]:-none, it was not installed})"

# --- The stand-in CDN

# A CA that lives only in this run, and the CDN's certificate it signs.
tls="$work/tls"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=Harness Device e2e throwaway CA" \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
  -keyout "$tls/ca.key" -out "$tls/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=$CDN" -keyout "$tls/cdn.key" -out "$tls/cdn.csr" 2>/dev/null
printf '%s\n' "subjectAltName=DNS:$CDN" basicConstraints=CA:FALSE extendedKeyUsage=serverAuth >"$tls/cdn.ext"
openssl x509 -req -days 1 -in "$tls/cdn.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
  -extfile "$tls/cdn.ext" -out "$tls/cdn.crt" 2>/dev/null
sudo cp "$tls/ca.crt" "$CA_FILE"
sudo update-ca-certificates >/dev/null
cp /etc/hosts "$work/hosts.before"
hosts_changed=1
printf '127.0.0.1 %s\n' "$CDN" | sudo tee -a /etc/hosts >/dev/null
[[ "$(getent hosts "$CDN" | awk '{ print $1 }')" == 127.0.0.1 ]] || fail "$CDN resolves to 127.0.0.1"

cp "$repo/website/scripts/device-install.sh" "$cdn/harness/device/install.sh"
# The manifest as device-manifest.py writes it (json.dumps, indent=2), naming only this arch's AppImage; and the same
# with its sha256 one hex digit off.
"$python" -I - "$served" "$VERSION" "$arch" "$cdn/e2e" <<'PY'
import hashlib, json, os, sys
served, version, arch, out = sys.argv[1:]
with open(served, "rb") as file:
    sha = hashlib.sha256(file.read()).hexdigest()
name = f"Harness-Device-linux-{arch}.AppImage"
for file_name, digest in (("metadata.json", sha), ("tampered.json", ("1" if sha[0] == "0" else "0") + sha[1:])):
    entry = {"version": version, "url": f"https://cdn.autonomous.ai/harness/device/{version}/{name}",
             "sha256": digest, "size": os.path.getsize(served)}
    with open(os.path.join(out, file_name), "w", encoding="utf-8") as file:
        file.write(json.dumps({"version": version, f"device-linux-{arch}-appimage": entry}, indent=2) + "\n")
PY

# Root only for port 443; its output is this run's file, written as this user.
# shellcheck disable=SC2024
sudo "$python" -I "$here/https-fake-cdn.py" "$cdn" "$tls/cdn.crt" "$tls/cdn.key" </dev/null >"$work/server.out" 2>&1 &
server_pid=$!
serving() { curl -fsS --max-time 5 -o /dev/null "https://$CDN/harness/device/install.sh" 2>/dev/null; }
waits serving || fail "the stand-in CDN serves https://$CDN under the throwaway CA: $(cat "$work/server.out")"

# --- The line

# A person's session: the scratch HOME, its XDG folders the defaults under it, this display and bus. The app's state
# says the CLI was seen and sign-in and the login item asked, so it installs nothing and opens no window.
base=(HOME="$home" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/bash LANG=C.UTF-8 TMPDIR="$work/tmp"
  PATH="$APP_PATH" XDG_RUNTIME_DIR="$work/run" XDG_SESSION_TYPE=x11 DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY"
  DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" NO_AT_BRIDGE=1)
mkdir -p "$data"
chmod 700 "$data"
printf '%s\n' '{"version":1,"cliSeen":true,"askedSignIn":true,"loginItem":true}' >"$data/state.json"

line_pid=""
# Runs the line a person pastes, naming the stand-in manifest `$1`, in a shell that ends when the line does and leads a
# session of its own, as a terminal's shell does; waits until it ends and leaves its exit code in `status`.
run_line() {
  local line="curl -fsSL https://$CDN/harness/device/install.sh | HARNESS_DEVICE_METADATA_URL=https://$CDN/e2e/$1 bash"
  setsid env -i "${base[@]}" bash -c "$line" </dev/null >"$work/line.out" 2>&1 &
  line_pid=$!
  status=0
  wait "$line_pid" || status=$?
}
said() { grep -Fxq -- "$1" "$work/line.out"; }
# A file's bytes and time, to tell a run that left it.
stamp() { sha256sum <"$1" && stat -c %y "$1"; }

run_line tampered.json
[[ "$status" -eq 1 ]] || fail "a manifest whose sha256 is off: the line exits 1, not $status"
refused="Harness Device installer: downloaded AppImage checksum does not match the release metadata"
said "$refused" || fail "a manifest whose sha256 is off: the line says $refused"
[[ -z "$(ls -A "$home/.local/opt")" ]] || fail "a manifest whose sha256 is off: nothing is left at the place"
ok "a manifest whose sha256 is off: the line exits 1, says the checksum does not match, and leaves nothing"

run_line metadata.json
[[ "$status" -eq 0 ]] || fail "the line exits 0, not $status"
said "Harness Device $VERSION installed at $place" || fail "the line says Harness Device $VERSION installed at $place"
[[ "$(stat -c %a "$place")" == 755 ]] || fail "the AppImage at the place is mode 0755, not $(stat -c %a "$place")"
cmp -s "$served" "$place" || fail "the AppImage at the place is the served bytes"
for path in /harness/device/install.sh /e2e/metadata.json "/harness/device/$VERSION/${served##*/}"; do
  grep -Fxq "GET $path HTTP/1.1 200" "$work/requests.log" || fail "the stand-in CDN served $path"
done
ok "the line exits 0 and says Harness Device $VERSION installed at $place, mode 0755, the served bytes"

# Task 47's rule: a process of the app's has its executable under the runtime's mount.
from_mount() {
  local pid exe
  for pid in $(with_scratch_home); do
    exe="$(readlink "/proc/$pid/exe" 2>/dev/null)" || continue
    if [[ "$exe" == "$work/tmp/.mount_"* ]]; then
      app_pid="$pid"
      return 0
    fi
  done
  return 1
}
if ! waits from_mount; then
  # The installer sends the app's output nowhere: started again, the app names why it stops.
  why="$(timeout 10 env -i "${base[@]}" "$place" </dev/null 2>&1 | head -n 1 || true)"
  fail "the app runs from its FUSE mount within $WAIT s; started again, it first prints: ${why:-nothing}"
fi
grep -sqzFx -- "APPIMAGE=$place" "/proc/$app_pid/environ" || fail "the app's environment names APPIMAGE=$place"
ok "the app runs from its FUSE mount, its environment naming APPIMAGE=$place"

# The line's shell has ended. Closing its terminal hangs up the session the line ran in; the app has a session of its
# own, so the hangup does not reach it.
[[ "$(ps -o sid= -p "$app_pid" | tr -d ' ')" != "$line_pid" ]] || fail "the app runs in a session of its own"
kill -HUP -- "-$line_pid" 2>/dev/null || true
first_line() { [[ -n "$(cat "$data"/logs/app-*.log 2>/dev/null | head -n 1)" ]]; }
waits first_line || fail "the app's log has its first line within $WAIT s"
gone "$app_pid" && fail "the app outlives the shell that ran the line"
ok "the app outlives the shell that ran the line"

# The vectors' entry for a home with a space, for this home.
"$python" -I - "$vectors" "$home" >"$work/entry.expected" <<'PY'
import json, sys
vectors, home = sys.argv[1:]
with open(vectors, encoding="utf-8") as file:
    case = next(
        c for c in json.load(file)["entries"]
        if c["icon"] and c["appImage"] == "/home/p q/.local/opt/Harness-Device.AppImage"
    )
sys.stdout.write(case["entry"].replace("/home/p q", home))
PY
cmp -s "$work/entry.expected" "$entry" || fail "harness-device.desktop is the vectors' entry for the place"
# The icon is the image's own member, as the app reads it under its APPDIR and Desktop extracts it.
icon_member=usr/share/icons/hicolor/128x128/apps/harness-device.png
(cd "$work/extract" && "$served" --appimage-extract "$icon_member" >/dev/null </dev/null) \
  || fail "the AppImage extracts its icon"
cmp -s "$work/extract/squashfs-root/$icon_member" "$icon" || fail "the entry's icon is the image's"
cmp -s -n 8 <(printf '\x89PNG\r\n\x1a\n') "$icon" || fail "the entry's icon is a PNG"
stamp "$entry" >"$work/entry.stamp"
stamp "$icon" >"$work/icon.stamp"
ok "harness-device.desktop is the vectors' entry for the place, its icon a PNG, the image's own"

stamp "$place" >"$work/place.stamp"
run_line metadata.json
[[ "$status" -eq 1 ]] || fail "a second run while the app runs exits 1, not $status"
running="Harness Device installer: Harness Device is running from $place. Quit it, then run this installer again."
said "$running" || fail "a second run while the app runs says $running"
stamp "$place" | cmp -s "$work/place.stamp" - || fail "a second run while the app runs leaves the AppImage at the place"
ok "a second run while the app runs exits 1, says it is running from the place, and leaves the AppImage"

gone "$app_pid" && fail "the app runs until it is ended"
end_app
# The app has ended: whatever its first run did to the entry, it has done.
stamp "$entry" | cmp -s "$work/entry.stamp" - || fail "the app's first run leaves the installer's entry, bytes and mtime"
stamp "$icon" | cmp -s "$work/icon.stamp" - || fail "the app's first run leaves the installer's icon, bytes and mtime"
grep -qs 'app list:' "$data"/logs/app-*.log \
  && fail "the app's first run leaves the installer's entry: its log has an app list: line"
ok "the app's first run leaves the installer's entry and icon, and its log has no app list: line"

echo "0 FAILED"
