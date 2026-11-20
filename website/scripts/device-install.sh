#!/bin/sh
# Harness Device installer for Linux: `curl -fsSL https://harness.autonomous.ai/device/install.sh | bash`. That URL
# redirects (next.config.js) to https://cdn.autonomous.ai/harness/device/install.sh, which device-manifest.py publish
# uploads from this file with every release that carries Linux, after its version checks and before the manifest names
# a Linux AppImage. It does not ship with a web deploy.
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

# https only, through any redirect too; a transfer under 1 KiB/s for a minute ends instead of hanging the line. Each
# call names its own --max-filesize, so a server that never stops sending cannot fill the disk.
download() {
  curl -fL --retry 3 --connect-timeout 15 --proto '=https' --proto-redir '=https' --speed-limit 1024 --speed-time 60 "$@"
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

# The app goes under HOME: under a relative one, the AppImage and its Exec= line would be paths no launcher can run.
case "${HOME:-}" in
  /*) ;;
  *) fail "HOME must be an absolute path" ;;
esac

OTA_KEY="device-linux-$RELEASE_ARCH-appimage"
APP_DIR="$HOME/.local/opt"
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
STAGING_DIR="$(mktemp -d "$APP_DIR/.harness-device-install.XXXXXX")" || fail "could not create an install staging directory in $APP_DIR"
trap cleanup EXIT
# A trap that does not exit lets the script run on: Ctrl-C, a closed terminal or a kill stops it here.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

METADATA_FILE="$STAGING_DIR/metadata.json"
CANDIDATE="$STAGING_DIR/Harness-Device-linux-$RELEASE_ARCH.AppImage"

printf '%s\n' "Fetching the latest Harness Device release…"
# device-manifest.py's MANIFEST_LIMIT.
download --max-filesize 1048576 "$METADATA_URL" -o "$METADATA_FILE" \
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
download --max-filesize "$EXPECTED_SIZE" "$ASSET_URL" -o "$CANDIDATE" \
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
case "${XDG_DATA_HOME:-}" in
  /*) DATA_HOME="$XDG_DATA_HOME" ;;
  *) DATA_HOME="$HOME/.local/share" ;;
esac

# Desktop's quoteLauncherExec: every % doubled, and the path quoted, with " ` $ \ escaped, when it holds a character a
# launcher would split or expand on.
exec_value() {
  doubled="$(printf '%s\n' "$1" | sed 's/%/%%/g')"
  case "$1" in
    *[[:space:]\"\'\\\$\`\<\>\~\|\&\;\*\?\#\(\)]*)
      printf '"%s"\n' "$(printf '%s\n' "$doubled" | sed 's/["`$\\]/\\&/g')"
      ;;
    *) printf '%s\n' "$doubled" ;;
  esac
}

# A temp file beside it, then a rename, as every writer writes the entry and its icon: nothing reads half of one.
put() {
  if cat > "$1.$$.tmp" && mv -f "$1.$$.tmp" "$1"; then
    return 0
  fi
  rm -f "$1.$$.tmp"
  return 1
}

ENTRY="$DATA_HOME/applications/harness-device.desktop"
ICON="$DATA_HOME/icons/harness-device.png"
ICON_MEMBER="usr/share/icons/hicolor/128x128/apps/harness-device.png"
# The app's own rule writes nothing for a path with a control character, which would break the entry's lines, or one
# that is not UTF-8, which a key file cannot hold.
fits_entry() {
  case "$1" in *[[:cntrl:]]*) return 1 ;; esac
  printf '%s' "$1" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1
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
