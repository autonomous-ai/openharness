#!/bin/sh
# Harness Device installer for Linux: `curl -fsSL https://harness.autonomous.ai/device/install.sh | bash`. That URL
# serves (a next.config.js rewrite) https://cdn.autonomous.ai/harness/device/install.sh, which device-manifest.py
# publish uploads from this file with every release that carries Linux, after its version checks and before the
# manifest names a Linux AppImage. It does not ship with a web deploy.
#
# Installs the AppImage the device manifest names for this computer's arch, checked by size and sha256, at Desktop's
# place for it, lists it in the app list when nothing is listed there yet, and starts it. No sudo and no libfuse2: the
# AppImage runs on a static runtime, which needs FUSE (fusermount3 and /dev/fuse) but no libfuse2, and its icon comes
# out with --appimage-extract, which needs no FUSE at all.
set -eu

# Fixed, with no environment override, as website/src/lib/deviceRelease.ts: only the bucket decides which release a
# person gets, never a pasted line.
METADATA_URL="https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json"

fail() {
  printf '%s\n' "Harness Device installer: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

# download <bytes> <url> <file>: https only, through any redirect too; a transfer under 1 KiB/s for a minute ends
# instead of hanging the line. At most <bytes>, so a server that never stops sending cannot fill the disk: curl's
# --max-filesize stops a transfer whose size the server names, and before curl 8.4 (Ubuntu 22.04's 7.81) no other; head
# stops the rest, one byte past <bytes> to show the body was larger. head writes the file, so the cap binds that write
# alone, where a file size limit on curl binds all it writes and counts blocks of a size each shell picks. A transport
# failure starts again from an empty file, 3 tries in all, as curl's --retry cannot rewind a pipe; a body past its size
# is no such failure. curl's status comes out past the pipe on fd 3.
download() {
  DOWNLOAD_TRY=1
  while :; do
    DOWNLOAD_STATUS="$({ if curl -fL --connect-timeout 15 --proto '=https' --proto-redir '=https' --speed-limit 1024 \
      --speed-time 60 --max-filesize "$1" "$2" 3>&-; then echo 0 >&3; else echo "$?" >&3; fi \
      | head -c "$(($1 + 1))" > "$3" 3>&-; } 3>&1)"
    case "$DOWNLOAD_STATUS" in
      0)
        [ "$(wc -c < "$3" | tr -d '[:space:]')" -le "$1" ]
        return
        ;;
      # No host, no connection, a cut or stalled transfer, an HTTP error (curl -f names a 5xx or 429 so, and a 404
      # alike, which costs a few seconds retried), a failed TLS handshake, an empty reply, a failed send or receive.
      6 | 7 | 18 | 22 | 28 | 35 | 52 | 55 | 56) [ "$DOWNLOAD_TRY" -lt 3 ] || return 1 ;;
      *) return 1 ;;
    esac
    DOWNLOAD_TRY=$((DOWNLOAD_TRY + 1))
    sleep 2
  done
}

PLATFORM="$(uname -s)"
[ "$PLATFORM" = Linux ] || fail "this installer is for Linux (found: $PLATFORM)."

MACHINE_ARCH="$(uname -m)"
case "$MACHINE_ARCH" in
  aarch64 | arm64)
    RELEASE_ARCH="arm64"
    ;;
  x86_64 | amd64)
    RELEASE_ARCH="x64"
    ;;
  *)
    fail "Harness Device does not support this Linux architecture ($MACHINE_ARCH)."
    ;;
esac

# FOLDER: $1 without the `/`s that end it, as every writer reads HOME and XDG_DATA_HOME, so a name goes after one `/`
# and `/` alone is no folder.
folder() {
  FOLDER="$1"
  while [ "${FOLDER%/}" != "$FOLDER" ]; do FOLDER="${FOLDER%/}"; done
}

# The app goes under HOME: under a relative one, the AppImage and its Exec= line would be paths no launcher can run.
folder "${HOME:-}"
case "$FOLDER" in
  /*) HOME_DIR="$FOLDER" ;;
  *) fail "HOME must be an absolute path" ;;
esac

OTA_KEY="device-linux-$RELEASE_ARCH-appimage"
APP_DIR="$HOME_DIR/.local/opt"
# Desktop's place for the app: one name with no version or arch, so the app's updater replaces it in place.
DESTINATION="$APP_DIR/Harness-Device.AppImage"

cleanup() {
  if [ -n "${STAGING_DIR:-}" ] && [ -d "$STAGING_DIR" ]; then
    rm -rf "$STAGING_DIR"
  fi
}

for command_name in curl sha256sum mktemp pgrep grep sed setsid; do
  require_command "$command_name"
done

mkdir -p "$APP_DIR"
# A name made inside APP_DIR, not a path: a Linux HOME is any bytes, and Ubuntu 26.04's mktemp (uutils) refuses a
# template that is not UTF-8.
STAGING_NAME="$(cd "$APP_DIR" >/dev/null && mktemp -d .harness-device-install.XXXXXX)" \
  || fail "could not create an install staging directory in $APP_DIR"
STAGING_DIR="$APP_DIR/$STAGING_NAME"
trap cleanup EXIT
# A trap that does not exit lets the script run on: Ctrl-C, a closed terminal or a kill stops it here.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

METADATA_FILE="$STAGING_DIR/metadata.json"
CANDIDATE="$STAGING_DIR/Harness-Device-linux-$RELEASE_ARCH.AppImage"

printf '%s\n' "Fetching the latest Harness Device release…"
# device-manifest.py's MANIFEST_LIMIT.
download 1048576 "$METADATA_URL" "$METADATA_FILE" \
  || fail "could not download device metadata"

# No jq or python3, which a stock Ubuntu may lack: the manifest is device-manifest.py's json.dump with indent=2, one
# "key": value per line, so sed and grep, which every Debian and Ubuntu has, take this arch's entry out of it.
METADATA_BLOCK="$(sed -n "/\"${OTA_KEY}\": {/,/^  }/p" "$METADATA_FILE")"
[ -n "$METADATA_BLOCK" ] || fail "device metadata is missing the $OTA_KEY entry"

metadata_value() {
  printf '%s\n' "$METADATA_BLOCK" | grep "\"$1\":" | head -n1 \
    | sed -E 's/.*"'"$1"'": *"?([^",]*)"?,?$/\1/' \
    | tr -d '[:space:]'
}

VERSION="$(metadata_value version)"
ASSET_URL="$(metadata_value url)"
EXPECTED_SHA256="$(metadata_value sha256 | tr '[:upper:]' '[:lower:]')"
EXPECTED_SIZE="$(metadata_value size)"

[ -n "$VERSION" ] && [ -n "$ASSET_URL" ] && [ -n "$EXPECTED_SHA256" ] && [ -n "$EXPECTED_SIZE" ] \
  || fail "device metadata is missing $OTA_KEY.version/url/sha256/size"
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "device metadata has an invalid version"
# The whole URL is fixed, its folder the X.Y.Z checked above: a glob would let `../..` through, and curl collapses dot
# segments. The CDN and the bucket behind it are both accepted, as website/src/lib/deviceRelease.ts accepts them.
case "$ASSET_URL" in
  "https://cdn.autonomous.ai/harness/device/$VERSION/Harness-Device-linux-$RELEASE_ARCH.AppImage") ;;
  "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/$VERSION/Harness-Device-linux-$RELEASE_ARCH.AppImage") ;;
  *) fail "device metadata points outside the Harness Device release bucket" ;;
esac
printf '%s' "$EXPECTED_SHA256" | grep -Eq '^[0-9a-f]{64}$' \
  || fail "device metadata has an invalid SHA-256"
case "$EXPECTED_SIZE" in
  *[!0-9]* | '') fail "device metadata has an invalid AppImage size" ;;
esac

# pgrep -f reads an extended regex over each command line: the path's own characters escaped, and the path the command
# itself, not a word an editor or a tail names. Only this user's processes: the place is under this HOME.
running() {
  pgrep -u "$(id -u)" -f "^$(printf '%s\n' "$DESTINATION" | sed 's/[][\\.*^$+?(){}|]/\\&/g')( |\$)" >/dev/null 2>&1
}

if running; then
  fail "Harness Device is running from $DESTINATION. Quit it, then run this installer again."
fi
# One move puts the file over a file; over a folder it would put it inside.
[ ! -d "$DESTINATION" ] || fail "$DESTINATION is a folder. Move it away, then run this installer again."

printf '%s\n' "Downloading Harness Device ${VERSION}…"
download "$EXPECTED_SIZE" "$ASSET_URL" "$CANDIDATE" \
  || fail "could not download Harness Device $VERSION"

ACTUAL_SIZE="$(wc -c < "$CANDIDATE" | tr -d '[:space:]')"
[ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ] \
  || fail "downloaded AppImage size does not match the release metadata"

# From stdin: sha256sum escapes a file name that holds a backslash, and its line then starts with one.
ACTUAL_SHA256="$(sha256sum < "$CANDIDATE")"
[ "${ACTUAL_SHA256%% *}" = "$EXPECTED_SHA256" ] \
  || fail "downloaded AppImage checksum does not match the release metadata"

chmod 755 "$CANDIDATE"

# The staging directory lives in APP_DIR, on the same filesystem: one rename replaces the previous install, so the
# place always holds one AppImage, the old or the new, whenever the script stops.
mv -f "$CANDIDATE" "$DESTINATION" || fail "could not install Harness Device $VERSION"

# The app-list entry and its icon, by the rule every writer follows (tests/fixtures/app-list-entry-vectors.json), and
# only when there is no entry: the app started below applies the whole rule on its first run, so this script reads no
# Exec= line. None of this fails the install.
folder "${XDG_DATA_HOME:-}"
case "$FOLDER" in
  /*) DATA_HOME="$FOLDER" ;;
  *) DATA_HOME="$HOME_DIR/.local/share" ;;
esac

# The lists below are UTF-8 bytes read in the C locale, not the locale's classes: dash reads a byte at a time, and a
# UTF-8 locale's [[:space:]] and [[:cntrl:]] are not the app's lists (macOS's hold U+200B, which the app leaves bare).
# What Exec= quotes, as the app's exec_value and Desktop's quoteLauncherExec: Unicode's White_Space (U+0009-000D,
# space, U+0085, U+00A0, U+1680, U+2000-200A, U+2028, U+2029, U+202F, U+205F, U+3000), which a launcher may split an
# argument on, and what the Desktop Entry spec reserves.
# shellcheck disable=SC2016 # the $ and ` are characters of the list, not expansions
QUOTED="$(printf '[\t-\r "'\''\\$`<>~|&;*?#()]|\302[\205\240]|\341\232\200|\342\200[\200-\212\250\251\257]|\342\201\237|\343\200\200')"
# C1, U+0080-009F: the control characters past C0 and DEL.
C1="$(printf '\302[\200-\237]')"

# Every % doubled; then, when the path holds a character of QUOTED, the path quoted with " ` $ \ escaped, and the
# string escape laid over that, every \ doubled again: the spec reads a value's escapes before its quotes.
exec_value() {
  doubled="$(printf '%s\n' "$1" | sed 's/%/%%/g')"
  if printf '%s\n' "$1" | LC_ALL=C grep -Eq -- "$QUOTED"; then
    printf '"%s"\n' "$(printf '%s\n' "$doubled" | LC_ALL=C sed 's/["`$\\]/\\&/g; s/\\/\\\\/g')"
  else
    printf '%s\n' "$doubled"
  fi
}

# <file>.tmp beside it, flushed, then a rename, as the app and Desktop write the entry and its icon: nothing reads half
# of one, a crash after the rename leaves no empty one, and a run stopped mid-write leaves a file the next replaces.
put() {
  if cat > "$1.tmp" && sync "$1.tmp" && mv -f "$1.tmp" "$1"; then
    return 0
  fi
  rm -f "$1.tmp"
  return 1
}

ENTRY="$DATA_HOME/applications/harness-device.desktop"
ICON="$DATA_HOME/icons/harness-device.png"
ICON_MEMBER="usr/share/icons/hicolor/128x128/apps/harness-device.png"
# The app's own rule writes nothing for a path with a control character (C0, DEL or C1), which would break the entry's
# lines, or one that is not UTF-8, which a key file cannot hold.
fits_entry() {
  [ "$(printf '%s' "$1" | LC_ALL=C tr -d '\001-\037\177')" = "$1" ] \
    && ! printf '%s\n' "$1" | LC_ALL=C grep -q -- "$C1" \
    && printf '%s' "$1" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1
}

if [ ! -e "$ENTRY" ] && fits_entry "$DESTINATION$DATA_HOME"; then
  (
    # Set here, never taken from the environment: it lands in the entry verbatim.
    ICON_LINE=
    # The image's own icon, the file the app reads under its APPDIR; stdin is the script itself under `| bash`.
    if (cd "$STAGING_DIR" && "$DESTINATION" --appimage-extract "$ICON_MEMBER" >/dev/null 2>&1 </dev/null) \
      && mkdir -p "$DATA_HOME/icons" && put "$ICON" < "$STAGING_DIR/squashfs-root/$ICON_MEMBER"; then
      ICON_LINE="Icon=$ICON"
    fi
    mkdir -p "$DATA_HOME/applications" && {
      printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=Harness Device' \
        'Comment=The app for your Harness device.' "Exec=$(exec_value "$DESTINATION")"
      if [ -n "$ICON_LINE" ]; then printf '%s\n' "$ICON_LINE"; fi
      printf '%s\n' 'Terminal=false' 'Categories=Utility;' 'StartupWMClass=harness-device'
    } | put "$ENTRY"
  ) || true
fi

printf '%s\n' "Harness Device $VERSION installed at $DESTINATION"
# A session of its own: piped from curl, the script has no job control, so a plain & would leave the app in the
# terminal's process group, and closing the terminal would end it.
setsid -f "$DESTINATION" >/dev/null 2>&1 </dev/null
# A start that fails ends at once: no FUSE, a home mounted noexec, another arch's userland, missing libraries. The app,
# once up, runs until it is quit, its runtime as the place itself. So it has started if that still runs a moment later.
sleep 3
running || fail "Harness Device did not start: run \"$DESTINATION\" in a terminal to see why."
