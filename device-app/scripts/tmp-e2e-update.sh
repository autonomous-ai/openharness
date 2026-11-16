#!/usr/bin/env bash
# TEMPORARY: removed before the merge, with tmp-device-app-release.yml, its only caller.
# Builds Harness Device 0.0.1 and 0.0.2 with updater keys made here, serves 0.0.2 on 127.0.0.1, then checks that 0.0.1
# skips the update from a folder it cannot write, and from a writable one updates itself to 0.0.2 and relaunches.
# The relaunch goes through LaunchServices, which gives the app the account's own HOME, so this seeds the runner's HOME
# and runs on a disposable GitHub runner only.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(dirname "$here")"

die() {
  echo "tmp-e2e-update: $*" >&2
  exit 1
}

[[ "${GITHUB_ACTIONS:-}" == true ]] || die "runs on GitHub Actions only (it seeds HOME and starts the app)"
[[ "$(uname -s)" == Darwin ]] || die "runs on a Mac only"

id=ai.autonomous.harness.device
launcher="$HOME/.local/bin/harness"
state_dir="$HOME/Library/Application Support/$id"
log_dir="$HOME/Library/Logs/$id"
# A HOME that holds any of these is not a fresh runner's: the app would run that CLI (~/.harness is the one it prefers
# to the launcher), start from that state, or the checks read an older log.
for path in "$launcher" "$HOME/.harness" "$state_dir" "$log_dir"; do
  [[ ! -e "$path" && ! -L "$path" ]] || die "$path exists: this is not a fresh runner's HOME"
done

# The real path: the app's process is matched by its executable's full path, as LaunchServices starts it.
work="$(cd "${RUNNER_TEMP:?}" && pwd -P)/device-e2e"
mkdir -p "$work/serve" "$work/logs" "$work/old" "$work/new"

# Runs COMMAND once a second until it succeeds; fails once SECONDS have passed.
wait_until() {
  local bound="$1" start=$SECONDS
  shift
  until "$@"; do
    ((SECONDS - start < bound)) || return 1
    sleep 1
  done
}

# Every day of the log: a run may cross midnight UTC.
logged() { grep -qF -- "$1" "$log_dir"/app-*.log 2>/dev/null; }

# While the update swaps the bundles there may be no Info.plist: that is not the version yet.
at_version() {
  local plist="$1/Contents/Info.plist"
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist" 2>/dev/null)" == "$2" ]]
}

# The pids of the app running from the bundle in FOLDER. The path reaches awk through its environment, so awk's own
# command line never matches.
pids_in() {
  ps -axww -o pid=,command= |
    EXE="$1/Harness Device.app/Contents/MacOS/harness-device" awk 'index($0, ENVIRON["EXE"]) { print $1 }'
}

running() { [[ -n "$(pids_in "$1")" ]]; }

gone() { ! running "$1"; }

stop() {
  local pid
  while read -r pid; do
    kill "$pid" 2>/dev/null || true
  done < <(pids_in "$1")
}

server=""
cleanup() {
  local folder
  for folder in "$work/locked" "$work/run"; do
    stop "$folder"
    if ! wait_until 15 gone "$folder"; then
      pids_in "$folder" | xargs kill -KILL 2>/dev/null || true
    fi
  done
  if [[ -n "$server" ]]; then
    kill "$server" 2>/dev/null || true
  fi
  cat "$log_dir"/app-*.log >"$work/logs/app.log" 2>/dev/null || true
}
trap cleanup EXIT

# Keys made here, for this run only: no secret is read.
cargo tauri signer generate --ci -w "$work/key"
cargo tauri signer generate --ci -w "$work/other"
export TAURI_SIGNING_PRIVATE_KEY="$work/key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" APPLE_SIGNING_IDENTITY=-
pub="$(cat "$work/key.pub")"
other="$(cat "$work/other.pub")"

# Started before the builds: its port goes into their endpoints.
python3 -u -m http.server 0 --bind 127.0.0.1 --directory "$work/serve" >"$work/logs/server.log" 2>&1 &
server=$!
serving() { grep -q '^Serving HTTP on 127\.0\.0\.1 port [1-9]' "$work/logs/server.log"; }
wait_until 10 serving || die "the file server did not start"
port="$(sed -n 's/^Serving HTTP on 127\.0\.0\.1 port \([0-9]*\) .*/\1/p' "$work/logs/server.log")"

# Only 0.0.1 may read plain http (a release build refuses it without the dangerous key). 0.0.2 asks https of this plain
# server, which fails, so the relaunched app reaches nothing.
config() { printf '{"plugins":{"updater":{"pubkey":"%s","endpoints":["%s"]%s}}}' "$pub" "$1" "$2"; }
bash "$here/release-build.sh" 0.0.1 "$work/old" \
  "$(config "http://127.0.0.1:$port/metadata.json" ',"dangerousInsecureTransportProtocol":true')"
bash "$here/release-build.sh" 0.0.2 "$work/new" "$(config "https://127.0.0.1:$port/metadata.json" '')"

# Informational, never a failure (PM, 2026-11-16): requireSignedVersion needs the version in the signature's trusted
# comment, tab-separated key:value fields that minisign's global signature covers.
trusted="$(base64 --decode <"$work/new/Harness-Device.app.tar.gz.sig" | sed -n 's/^trusted comment: //p')" || trusted=""
if [[ $'\t'"$trusted"$'\t' == *$'\t'version:0.0.2$'\t'* ]]; then
  echo "signed-version: yes"
else
  echo "signed-version: no"
fi

bash "$here/release-check.sh" "$work/old" 0.0.1 "$pub"
bash "$here/release-check.sh" "$work/new" 0.0.2 "$pub"

# release-check.sh must fail, and at CHECK: a failure anywhere else would prove nothing about CHECK.
refuses() {
  local check="$1" output
  shift
  if output="$(bash "$here/release-check.sh" "$@")"; then
    printf '%s\n' "$output"
    die "release-check.sh passed what it must refuse: $check"
  fi
  printf '%s\n' "$output"
  grep -qxF "FAILED: $check" <<<"$output" || die "release-check.sh failed, but not at: $check"
  echo "expected: release-check.sh refused \"$check\""
}
refuses "the app is 0.0.3" "$work/new" 0.0.3 "$pub"
refuses "the archive's update signature" "$work/new" 0.0.2 "$other"

echo "The end-to-end check's release." >"$work/notes.txt"
python3 "$here/device-manifest.py" build --version 0.0.2 --dir "$work/new" --notes-file "$work/notes.txt" \
  --pub-date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --base-url "http://127.0.0.1:$port" --out "$work/serve/metadata.json"
mkdir "$work/serve/0.0.2"
cp "$work/new/Harness-Device.dmg" "$work/new/Harness-Device.app.tar.gz" "$work/new/Harness-Device.app.tar.gz.sig" \
  "$work/serve/0.0.2/"

# The CLI is the repo's fake, which plays the file named by its arguments from `fake/` beside the launcher. The saved
# state has seen the CLI and registered the login item, so the app installs nothing and asks nothing.
mkdir -p "$HOME/.local/bin/fake" "$state_dir"
ln -s "$app/src-tauri/tests/fake-harness" "$launcher"
printf '%s\n' '{"attached":false}' @stdin >"$HOME/.local/bin/fake/hardware_watch_--json"
printf '%s\n' '{"loggedIn":true}' >"$HOME/.local/bin/fake/auth_status_--json"
printf '%s\n' '{"version":1,"cliSeen":true,"askedSignIn":true,"askedClaude":true,"loginItem":true}' \
  >"$state_dir/state.json"

# A folder it cannot write (PM, 2026-11-16): it finds 0.0.2, downloads nothing, and runs on as 0.0.1.
mkdir "$work/locked"
tar -xzf "$work/old/Harness-Device.app.tar.gz" -C "$work/locked"
chmod -R a-w "$work/locked"
open -n "$work/locked/Harness Device.app"
wait_until 120 logged "update: skipped not-writable" || die "0.0.1 in a folder it cannot write logged no skip"
logged "update: found 0.0.2" || die "0.0.1 in a folder it cannot write did not log finding 0.0.2"
if logged "update: installed"; then
  die "0.0.1 in a folder it cannot write installed an update"
fi
at_version "$work/locked/Harness Device.app" 0.0.1 || die "the bundle in a folder it cannot write changed"
running "$work/locked" || die "0.0.1 in a folder it cannot write stopped"
echo "ok: 0.0.1 in a folder it cannot write skipped 0.0.2, stayed 0.0.1 and runs"
stop "$work/locked"
wait_until 15 gone "$work/locked" || die "0.0.1 in a folder it cannot write did not stop"
chmod -R u+w "$work/locked"

mkdir "$work/run"
tar -xzf "$work/old/Harness-Device.app.tar.gz" -C "$work/run"
open -n "$work/run/Harness Device.app"
wait_until 30 running "$work/run" || die "0.0.1 did not start"
first="$(pids_in "$work/run")"
[[ "$first" =~ ^[0-9]+$ ]] || die "expected one 0.0.1 running, found pids: $first"
relaunched() {
  local pids
  pids="$(pids_in "$work/run")"
  [[ -n "$pids" ]] && grep -qvxF -- "$first" <<<"$pids"
}
wait_until 180 at_version "$work/run/Harness Device.app" 0.0.2 || die "the bundle did not become 0.0.2"
wait_until 60 logged "update: installed 0.0.2" || die "the app did not log installing 0.0.2"
wait_until 60 relaunched || die "the app did not relaunch"
echo "PASS: 0.0.1 updated itself to 0.0.2 and relaunched"
