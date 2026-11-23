#!/usr/bin/env bash
# End to end on macOS, the reference, from a scratch HOME on a person's own Mac:
#
#   bash device-app/scripts/e2e/macos.sh                the smoke: a debug build against the fake CLI
#                                                       (src-tauri/tests/fake-harness)
#   bash device-app/scripts/e2e/macos.sh --update OUT   update-pair.sh's 0.0.1 becomes 0.0.2 from 127.0.0.1:8765
#
# Prints `ok: <check>` for each check and stops at the first `FAILED: <check>`, exiting 1; exits 2 before it starts when
# it could not keep to itself. Every app it runs is a test build whose bundle id is ai.autonomous.harness.device.e2e,
# run from its own folder with a scratch HOME (and CFFIXED_USER_HOME, which AppKit and WebKit read) and state that says
# the login item is done, so it never meets the installed Harness Device, its folders or its login item, and never
# registers one. Only its (empty) defaults land in the account's own Preferences, under that bundle id, and go with the
# run. It reaches no CLI but the fake, no account and no backend, and ends only the processes it started.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(dirname "$(dirname "$here")")"
fake_cli="$app/src-tauri/tests/fake-harness"
ID=ai.autonomous.harness.device.e2e
PORT=8765
# Every wait ends on what it waits for, bounded by this; an update by UPDATE_WAIT, from the launch.
WAIT=60
UPDATE_WAIT=300
# What the app finds its programs on: the system's alone, where no harness is.
APP_PATH=/usr/bin:/bin:/usr/sbin:/sbin

stop_before() {
  echo "macos.sh: $*" >&2
  exit 2
}

update=""
if [[ $# -eq 2 && "$1" == --update ]]; then
  update="$(cd "$2" 2>/dev/null && pwd)" || stop_before "no update pair at $2"
elif [[ $# -ne 0 ]]; then
  stop_before "usage: macos.sh [--update OUT]"
fi
[[ "$(uname -s)" == Darwin ]] || stop_before "runs on macOS"
[[ -z "$(PATH="$APP_PATH" command -v harness)" ]] || stop_before "a harness is on $APP_PATH: the app would find it"
# Signing and notarizing are a release's: tauri-bundler signs with APPLE_SIGNING_IDENTITY or APPLE_CERTIFICATE and sends
# the bundle to Apple's notary with APPLE_ID or APPLE_API_KEY. The test build is signed ad hoc and goes nowhere.
for name in $(compgen -e); do
  case "$name" in APPLE_* | TAURI_SIGNING_*) unset "$name" ;; esac
done
# What macOS files under a bundle id in a HOME's Library, for a menu-bar app with a webview.
filed_under() {
  local folder
  for folder in "Application Support" Logs Caches WebKit HTTPStorages Preferences "Saved Application State"; do
    compgen -G "$1/Library/$folder/$ID*" || true
  done
}
# Left by an earlier run that did not end: the checks would read its files.
leftover="$(filed_under "$HOME")"
[[ -z "$leftover" ]] || stop_before "$leftover is there: an earlier run left it"

work="$(mktemp -d "${TMPDIR:-/tmp}/harness-device-e2e.XXXXXX")"
work="$(cd "$work" && pwd -P)"
home="$work/home"
fake="$work/fake"
data="$home/Library/Application Support/$ID"
logs="$home/Library/Logs/$ID"
mkdir -p "$home" "$fake" "$work/tmp" "$work/apps"

pids=()
bundle=""

# cfprefsd files an app's defaults under the account's own home, whatever HOME says: the test's domain, which no earlier
# run left (checked above), goes once its app has ended.
forget_defaults() {
  defaults delete "$ID" >/dev/null 2>&1 || true
  rm -f "$HOME/Library/Preferences/$ID.plist"
}

cleanup() {
  set +e
  # The relaunch comes through LaunchServices, no child of this script, and joins `pids` only once it is found: every
  # process run from this run's folder ends too.
  local strays=() pid command
  while read -r pid command; do
    [[ "$command" != "$work/"* ]] || strays+=("$pid")
  done < <(ps -axo pid=,command=)
  # `${a[@]+...}`: macOS's bash 3.2 reads an empty array as unbound.
  for pid in ${pids[@]+"${pids[@]}"} ${strays[@]+"${strays[@]}"}; do kill "$pid" 2>/dev/null; done
  for pid in ${pids[@]+"${pids[@]}"} ${strays[@]+"${strays[@]}"}; do waits gone "$pid"; done
  forget_defaults
  # The fake CLI's runs, while they are still the fake's.
  if [[ -f "$fake/pids.log" ]]; then
    while read -r pid; do
      ps -p "$pid" -o command= | grep -q fake-harness && kill "$pid" 2>/dev/null
    done <"$fake/pids.log"
  fi
  # The relaunch went through LaunchServices, which keeps the bundles it opened: they leave its list with the folder.
  [[ -z "$bundle" ]] || /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$bundle" 2>/dev/null
  wait 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT

ok() { echo "ok: $1"; }

fail() {
  echo "FAILED: $1"
  echo "--- the app's log"
  log_text | tail -n 60
  echo "--- the fake CLI's calls"
  cat "$fake/calls.log" 2>/dev/null
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

log_text() { cat "$logs"/app-*.log 2>/dev/null || true; }
# The log's lines, without their time.
run_log() { log_text | cut -d' ' -f2-; }
logged() { run_log | grep -Fxq -- "$1"; }
times_logged() { run_log | grep -Fxc -- "$1" || true; }
gone() { ! kill -0 "$1" 2>/dev/null; }

# cliSeen, askedSignIn and loginItem: nothing is installed, no window opens and no login item is registered.
mkdir -p "$data"
chmod 700 "$data"
printf '%s\n' '{"version":1,"cliSeen":true,"askedSignIn":true,"loginItem":true}' >"$data/state.json"

# The app's own environment: nothing of this account's but its name.
base=(HOME="$home" CFFIXED_USER_HOME="$home" TMPDIR="$work/tmp/" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/sh
  LANG=en_US.UTF-8 PATH="$APP_PATH")

# Starts the bundle's executable, as Finder would, but with this environment.
launch() {
  env -i "${base[@]}" "$@" "$bundle/Contents/MacOS/harness-device" >>"$work/app.out" 2>&1 &
  app_pid=$!
  pids+=("$app_pid")
  # Ended by this script on purpose: bash says nothing of it.
  disown "$app_pid"
}

bundle_id() { /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist"; }
bundle_version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist"; }

# Once its defaults are gone, nothing the test's bundle id names is under the real HOME's Library: macOS filed the rest
# in the scratch HOME.
kept_to_itself() {
  local found
  forget_defaults
  found="$(filed_under "$HOME")"
  [[ -z "$found" ]] || fail "nothing of the test's is under the real HOME's Library: $found is"
  ok "nothing of the test's is under the real HOME's Library"
}

if [[ -z "$update" ]]; then
  # --- The smoke: a debug build, which reads HARNESS_DEVICE_CLI, against the fake CLI

  target_dir="$(cd "$app/src-tauri" && cargo metadata --format-version 1 --no-deps |
    sed -n 's/.*"target_directory": *"\([^"]*\)".*/\1/p')"
  # A target folder of its own: a build with the test's bundle id never replaces the developer's debug app.
  e2e_target="$target_dir/e2e-macos"
  (cd "$app/src-tauri" && CARGO_TARGET_DIR="$e2e_target" cargo tauri build --ci --debug --bundles app \
    --config "{\"identifier\":\"$ID\"}" -- --locked) >"$work/build.out" 2>&1 || {
    tail -n 40 "$work/build.out"
    fail "the debug build"
  }
  # Copied out, so the run never writes into the build's own folder.
  cp -R "$e2e_target/debug/bundle/macos/Harness Device.app" "$work/apps/"
  bundle="$work/apps/Harness Device.app"
  [[ "$(bundle_id "$bundle")" == "$ID" ]] || stop_before "the debug build's bundle id is not $ID"
  ok "the debug build is $ID"

  printf '%s\n' '{"attached":false}' '@record' >"$fake/hardware_watch_--json"
  printf '%s\n' '{"loggedIn":false}' >"$fake/auth_status_--json"
  printf '%s\n' '0.6.99' >"$fake/--version"
  # The desktop app's row follows what AppKit says of it on this Mac, as the app reads it.
  desktop="$(osascript -l JavaScript -e 'ObjC.import("AppKit");
    $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier("ai.autonomous.harness").isNil() ? "" : "y"')"
  menu="menu: Plug in your device | Sign in… | ${desktop:+Open Harness | }Export logs | About | Quit"

  launch HARNESS_DEVICE_CLI="$fake_cli" FAKE_HARNESS="$fake"
  waits logged "$menu" || fail "the menu reads ${menu#menu: }"
  grep -Fxqs 'hardware watch --json' "$fake/calls.log" || fail "the app runs the fake CLI's watch"
  # The menu line was read from the scratch HOME's log. The state there is the script's, which the app only reads, and
  # macOS takes no instance lock (main.rs): kept_to_itself shows that nothing of the app's went to the real HOME.
  ok "the app logs to the scratch HOME and runs the fake CLI's watch"
  ok "the menu reads ${menu#menu: }"
  kill -TERM "$app_pid"
  waits gone "$app_pid" || fail "the app ends on SIGTERM"
  ok "the app ends"
  kept_to_itself
  echo "0 FAILED"
  exit 0
fi

# --- The update: 0.0.1 from update-pair.sh, with nothing in its way, finds 0.0.2 at 127.0.0.1:8765 and becomes it

archive=Harness-Device.app.tar.gz
for file in "0.0.1/$archive" "0.0.2/$archive" metadata.json; do
  [[ -f "$update/$file" ]] || stop_before "no $file in $update"
done
! nc -z 127.0.0.1 "$PORT" 2>/dev/null || stop_before "127.0.0.1:$PORT is taken"

tar -xzf "$update/0.0.1/$archive" -C "$work/apps"
bundle="$work/apps/Harness Device.app"
mkdir "$work/expected"
tar -xzf "$update/0.0.2/$archive" -C "$work/expected"
[[ "$(bundle_id "$bundle")" == "$ID" && "$(bundle_id "$work/expected/Harness Device.app")" == "$ID" ]] \
  || stop_before "the pair's bundle id is not $ID: build it with update-pair.sh"
[[ "$(bundle_version "$bundle")" == 0.0.1 ]] || fail "the pair's first app is 0.0.1"
[[ "$(bundle_version "$work/expected/Harness Device.app")" == 0.0.2 ]] || fail "the pair's second app is 0.0.2"

/usr/bin/python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$update" >"$work/server.log" 2>&1 &
pids+=("$!")
disown "$!"
waits curl -fs --max-time 5 -o /dev/null "http://127.0.0.1:$PORT/0.0.1/" \
  || fail "the manifest is served on 127.0.0.1:$PORT"
served() { grep -c '"GET /metadata.json ' "$work/server.log" || true; }
checked() { [[ "$(served)" -ge "$1" ]]; }

started=$SECONDS
launch
WAIT=$UPDATE_WAIT waits logged "update: found 0.0.2" || fail "0.0.1 logs update: found 0.0.2"
WAIT=$((UPDATE_WAIT - SECONDS + started)) waits logged "update: installed 0.0.2" \
  || fail "0.0.1 logs update: installed 0.0.2"
ok "0.0.1 logs update: found 0.0.2, then update: installed 0.0.2"
[[ "$(bundle_version "$bundle")" == 0.0.2 ]] || fail "the bundle is 0.0.2"
diff -r "$bundle" "$work/expected/Harness Device.app" >/dev/null || fail "the bundle is 0.0.2's, file for file"
ok "the bundle is 0.0.2's, file for file"

# The relaunch: through LaunchServices, so not a child of this script; found by its executable's path, which only this
# run's bundle has.
waits gone "$app_pid" || fail "0.0.1 ends for the relaunch"
# 0.0.1 asks again a minute after a check or download that failed: only a request from here on is the relaunched app's.
asked="$(served)"
relaunched() {
  local pid command
  while read -r pid command; do
    if [[ "$command" == "$bundle/Contents/MacOS/harness-device" ]]; then
      app_pid="$pid"
      return 0
    fi
  done < <(ps -axo pid=,command=)
  return 1
}
waits relaunched || fail "the app runs again after the update"
pids+=("$app_pid")
WAIT=$((UPDATE_WAIT - SECONDS + started)) waits checked $((asked + 1)) || fail "the relaunched app checks the manifest"
ok "the app runs again, 0.0.2, and checks the manifest"

# A check starts only once the one before it was answered, so the relaunched app's second request shows its first was
# answered: any update it found is logged by then.
WAIT=$((UPDATE_WAIT - SECONDS + started)) waits checked $((asked + 2)) \
  || fail "the relaunched app checks again, a minute after its first check"
[[ "$(times_logged "update: found 0.0.2")" -eq 1 ]] || fail "0.0.2 finds no update: one update: found in the log"
ok "0.0.2 checks the manifest and finds no update"

kill -TERM "$app_pid"
waits gone "$app_pid" || fail "the app ends on SIGTERM"
# The relaunch went through LaunchServices: had it lost the scratch HOME, its folders would be under the real one.
kept_to_itself
echo "0 FAILED"
