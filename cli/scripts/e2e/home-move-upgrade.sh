#!/usr/bin/env bash
# The move of ~/.harness on a real install, end to end (docs/plans/2026-11-18-linux-xdg-paths-design.md, Verification):
# the published release, installed with its own install.sh into a throwaway home and started; then this checkout's build
# installed over it and started, which moves ~/.harness to the XDG folders and leaves the bridge; the next start removes
# the bridge. Then a fresh install of this build, in a second empty home, writes nothing to ~/.harness.
#
#   bash cli/scripts/e2e/home-move-upgrade.sh "$RUNNER_TEMP/home"
#
# Linux only, on a throwaway home that is empty or not there yet (the fresh install goes in "<home>-fresh"). Every
# command runs with an environment of its own: that home, a tmux server and a port of its own (never 18473, a person's
# daemon's), updates off, and a backend that is nowhere, so it never signs in and names no account.
set -euo pipefail

[ "$(uname -s)" = Linux ] || { echo "error: the move runs on Linux only" >&2; exit 2; }
[ "$#" -eq 1 ] || { echo "usage: $0 <throwaway home>" >&2; exit 2; }

CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_URL=https://cdn.autonomous.ai/harness/cli/install.sh
PORT_NUMBER=28473
FIRST="${1%/}"
FRESH="$FIRST-fresh"
WORK="$FIRST-work"
# The runner's own tools (tmux, curl, git, and the Node and npm install-cli.sh builds with), and nothing of a person's.
TOOLS_PATH="$(dirname "$(command -v node)"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# The entries of the state root (cli/src/config/harnessHome.ts HARNESS_ENTRIES); every other entry goes to the data root.
STATE_ENTRIES=" logs runtime hook-routes s run shell-requests pty uninstalling flasher monitor "

say() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# [home]'s commands, with nothing of this shell's environment but what they need.
in_home() {
  local home=$1
  shift
  env -i HOME="$home" PATH="$home/.local/bin:$TOOLS_PATH" LANG=C.UTF-8 USER="${USER:-runner}" LOGNAME="${USER:-runner}" \
    SHELL=/bin/sh TMUX_TMPDIR="$home/.tmux" PORT="$PORT_NUMBER" ADAPTER_UPDATE_DISABLE=true BACKEND_WS_URL=ws://127.0.0.1:9 "$@"
}

prepare() {
  if [ -e "$1" ] && [ -n "$(ls -A "$1")" ]; then fail "$1 is not empty: give a throwaway home"; fi
  [ "$(cd ~ && pwd -P)" != "$(mkdir -p "$1" && cd "$1" && pwd -P)" ] || fail "$1 is this account's own home"
  mkdir -p "$1/.tmux"
}

# Whatever this run started goes with it, however it ends.
cleanup() {
  for home in "$FIRST" "$FRESH"; do
    [ -x "$home/.local/bin/harness" ] && in_home "$home" harness stop >/dev/null 2>&1 || true
    in_home "$home" tmux kill-server >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

prepare "$FIRST"
mkdir -p "$WORK"
OLD="$FIRST/.harness"
DATA="$FIRST/.local/share/harness"
STATE="$FIRST/.local/state/harness"

say "the published release, installed with its own install.sh, and started"
curl -fsSL --retry 3 "$INSTALL_URL" -o "$WORK/install.sh"
in_home "$FIRST" sh "$WORK/install.sh"
[ -d "$OLD/cli" ] || fail "the release did not install into ~/.harness"
in_home "$FIRST" harness version
in_home "$FIRST" harness start
in_home "$FIRST" harness stop

say "this build installed over it"
in_home "$FIRST" bash "$CLI/scripts/install-cli.sh" --no-updates
[ ! -e "$DATA" ] || fail "the install moved ~/.harness itself: only a start moves it"

# Every file of the old tree, with its mode and sha256. What the daemon writes as it runs (its data folder, logs, runs,
# routes, sockets, the Store's packages, the connections bridge) is its own to change; a file that names the old tree is
# the move's to rewrite. Everything else must arrive byte for byte.
ID="$(cat "$OLD/computer-id")"
SIZE_KIB="$(du -sk "$OLD" | cut -f1)"
(
  cd "$OLD"
  find . -type f -print0 | sort -z | while IFS= read -r -d '' file; do
    file=${file#./}
    case "$file" in
      cli/data/*|logs/*|run/*|hook-routes/*|s/*|dsh/*|connections/*) kind=live ;;
      *) if grep -qF "$OLD" "$file"; then kind=named; else kind=same; fi ;;
    esac
    printf '%s\t%s\t%s\t%s\n' "$file" "$(stat -c %a "$file")" "$(sha256sum "$file" | cut -d' ' -f1)" "$kind"
  done
) > "$WORK/before"

say "this build started: it moves ~/.harness"
started=$(date +%s%N)
in_home "$FIRST" harness start
took_ms=$(( ($(date +%s%N) - started) / 1000000 ))
[ -d "$DATA" ] && [ -d "$STATE" ] || fail "no XDG roots after the start"
grep -F "home move: moved · data $DATA · state $STATE" "$DATA/cli/data/harness.log" || fail "harness.log says no move"

checked=0
same=0
while IFS=$'\t' read -r file mode sum kind; do
  [ "$kind" != live ] || continue
  case "$STATE_ENTRIES" in *" ${file%%/*} "*) root=$STATE ;; *) root=$DATA ;; esac
  [ -f "$root/$file" ] || fail "$file is not in $root"
  [ "$(stat -c %a "$root/$file")" = "$mode" ] || fail "$file lost its mode $mode"
  checked=$((checked + 1))
  [ "$kind" = named ] && continue
  [ "$(sha256sum "$root/$file" | cut -d' ' -f1)" = "$sum" ] || fail "$file changed in the move"
  same=$((same + 1))
done < "$WORK/before"
echo "the file list matches: $checked files in their roots with their modes, $same of them byte for byte"
[ "$(cat "$DATA/computer-id")" = "$ID" ] || fail "the computer's id changed"
echo "computer-id: the same"

echo "harness: $(in_home "$FIRST" sh -c 'command -v harness') · $(in_home "$FIRST" harness --version)"
grep -qF "$DATA/cli/cli.js" "$FIRST/.local/bin/harness" || fail "the harness launcher still names the old tree"
where="$(in_home "$FIRST" hn --where)"
echo "hn: $(in_home "$FIRST" sh -c 'command -v hn') · $where"
case "$where" in "$DATA"/*) ;; *) fail "hn runs from $where, not the data root" ;; esac

echo "the old tree, now the bridge ($OLD):"
ls -la "$OLD"
for entry in "$OLD"/* "$OLD"/.[!.]*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  [ -L "$entry" ] && continue
  case "${entry##*/}" in
    hook-routes|connections) [ -d "$entry" ] || fail "${entry##*/} in the bridge is not a folder" ;;
    *) fail "${entry##*/} in the bridge is not a link" ;;
  esac
done

say "the next start: no old process is left, so the bridge goes"
in_home "$FIRST" harness stop
in_home "$FIRST" harness start
# The bridge service checks as it starts, in a process of its own: bounded, 30 s.
for _ in $(seq 150); do [ -e "$OLD" ] || break; sleep 0.2; done
[ ! -e "$OLD" ] || fail "the old tree is still there: $(find "$OLD" -mindepth 1 -maxdepth 1 -printf '%f ')"
echo "the old tree is gone ($OLD)"
in_home "$FIRST" harness stop

say "the move's numbers"
echo "the tree: ${SIZE_KIB} KiB"
echo "the start that moved it: ${took_ms} ms"
node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
console.log("the record: " + r.state + " · " + r.entries + " entries · " + r.bytesCopied + " bytes copied · " + new Date(r.at).toISOString())' \
  "$STATE/home-move.json"

say "a fresh install of this build, in a second empty home"
prepare "$FRESH"
in_home "$FRESH" bash "$CLI/scripts/install-cli.sh" --no-build --no-updates
in_home "$FRESH" harness start
[ ! -e "$FRESH/.harness" ] || fail "a fresh install wrote $FRESH/.harness: $(find "$FRESH/.harness" -mindepth 1 -maxdepth 1 -printf '%f ')"
[ -d "$FRESH/.local/share/harness/cli" ] || fail "a fresh install is not in the data root"
echo "a fresh home has no .harness ($FRESH)"
in_home "$FRESH" harness stop
