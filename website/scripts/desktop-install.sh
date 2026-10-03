#!/bin/sh
# Harness desktop installer, served from the CDN at
# https://cdn.autonomous.ai/harness/desktop/install.sh (source of truth:
# website/scripts/desktop-install.sh — published with `make upload-desktop-install-sh` from the repo
# root; it does NOT ship with a web deploy). The web app still answers the OLD URL,
# https://harness.autonomous.ai/desktop/install.sh, but only as a redirect to the CDN one (see
# next.config.js) — kept for anyone with the old link already saved.
#
# Installs the signed-by-checksum Harness desktop release published in the desktop metadata manifest.
# Supports macOS and Linux (Ubuntu) — the manifest carries one entry per platform and Linux
# architecture; this script selects it from `uname -s` and `uname -m`.
set -eu

METADATA_URL="${HARNESS_DESKTOP_METADATA_URL:-https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/metadata.json}"

fail() {
  printf '%s\n' "Harness desktop installer: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

PLATFORM="$(uname -s)"
case "$PLATFORM" in
  Darwin) ;;
  Linux)  ;;
  *) fail "Harness desktop is currently available for macOS and Linux only (found: $PLATFORM)." ;;
esac

# ============================================================================
# macOS
# ============================================================================
if [ "$PLATFORM" = "Darwin" ]; then
  # Keep one canonical macOS installation, matching the destination shown in the DMG. A caller on a
  # managed Mac can still opt into a user-local installation with HARNESS_DESKTOP_APP_DIR.
  APP_DIR="${HARNESS_DESKTOP_APP_DIR:-/Applications}"
  APP_NAME="Harness.app"
  DESTINATION="$APP_DIR/$APP_NAME"

  cleanup() {
    if [ -n "${STAGING_DIR:-}" ] && [ -d "$STAGING_DIR" ]; then
      rm -rf "$STAGING_DIR"
    fi
  }

  for command_name in curl plutil shasum ditto lipo mktemp pgrep open grep; do
    require_command "$command_name"
  done

  mkdir -p "$APP_DIR"
  STAGING_DIR="$(mktemp -d "$APP_DIR/.harness-install.XXXXXX")" || fail "could not create an install staging directory in $APP_DIR"
  trap cleanup EXIT HUP INT TERM

  METADATA_FILE="$STAGING_DIR/metadata.json"
  ARCHIVE_FILE="$STAGING_DIR/Harness-macos.zip"
  UNPACKED_DIR="$STAGING_DIR/unpacked"

  printf '%s\n' "Fetching the latest Harness desktop release…"
  curl -fL --retry 3 --connect-timeout 15 "$METADATA_URL" -o "$METADATA_FILE" \
    || fail "could not download desktop metadata"

  metadata_value() {
    plutil -extract "desktop-macos.$1" raw "$METADATA_FILE" 2>/dev/null \
      || fail "desktop metadata is missing desktop-macos.$1"
  }

  VERSION="$(metadata_value version)"
  ASSET_URL="$(metadata_value url)"
  EXPECTED_SHA256="$(metadata_value sha256 | tr '[:upper:]' '[:lower:]')"
  EXPECTED_SIZE="$(metadata_value size)"

  printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || fail "desktop metadata has an invalid version"
  # Both the GCS origin and its CDN (cdn.autonomous.ai, fronting the same bucket 1:1) are accepted,
  # not swapped: a manifest cut before the CDN migration can still carry the GCS-origin URL, and this
  # must accept both rather than pick a moment to flip. Keep in sync with website/src/lib/desktopManifest.ts.
  case "$ASSET_URL" in
    https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/*/Harness-macos.zip) ;;
    https://cdn.autonomous.ai/harness/desktop/*/Harness-macos.zip) ;;
    *) fail "desktop metadata points outside the Harness desktop release bucket" ;;
  esac
  printf '%s' "$EXPECTED_SHA256" | grep -Eq '^[0-9a-f]{64}$' \
    || fail "desktop metadata has an invalid SHA-256"
  case "$EXPECTED_SIZE" in
    *[!0-9]* | '') fail "desktop metadata has an invalid archive size" ;;
  esac

  if pgrep -f "$DESTINATION/Contents/MacOS/Harness" >/dev/null 2>&1; then
    fail "Harness is running from $DESTINATION. Quit it, then run this installer again."
  fi

  printf '%s\n' "Downloading Harness ${VERSION}…"
  curl -fL --retry 3 --connect-timeout 15 "$ASSET_URL" -o "$ARCHIVE_FILE" \
    || fail "could not download Harness $VERSION"

  ACTUAL_SIZE="$(wc -c < "$ARCHIVE_FILE" | tr -d '[:space:]')"
  [ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ] \
    || fail "downloaded archive size does not match the release metadata"

  ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE_FILE" | awk '{print $1}')"
  [ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] \
    || fail "downloaded archive checksum does not match the release metadata"

  mkdir "$UNPACKED_DIR"
  ditto -x -k "$ARCHIVE_FILE" "$UNPACKED_DIR" \
    || fail "could not unpack the Harness archive"

  CANDIDATE="$UNPACKED_DIR/$APP_NAME"
  [ -d "$CANDIDATE" ] || fail "the release archive does not contain $APP_NAME"
  CANDIDATE_VERSION="$(plutil -extract CFBundleShortVersionString raw "$CANDIDATE/Contents/Info.plist" 2>/dev/null)" \
    || fail "the downloaded app has no readable version"
  [ "$CANDIDATE_VERSION" = "$VERSION" ] \
    || fail "the downloaded app version does not match the release metadata"

  EXECUTABLE="$CANDIDATE/Contents/MacOS/Harness"
  [ -x "$EXECUTABLE" ] || fail "the downloaded app has no executable"
  MACHINE_ARCH="$(uname -m)"
  lipo -archs "$EXECUTABLE" | tr ' ' '\n' | grep -Fx "$MACHINE_ARCH" >/dev/null \
    || fail "Harness $VERSION does not support this Mac architecture ($MACHINE_ARCH)"

  # The staging directory lives in APP_DIR, so both moves remain on the same filesystem. If the
  # second move fails, restore the previous app before reporting the failure.
  BACKUP="$STAGING_DIR/previous-$APP_NAME"
  if [ -e "$DESTINATION" ]; then
    mv "$DESTINATION" "$BACKUP" || fail "could not prepare the existing Harness app for replacement"
  fi
  if ! mv "$CANDIDATE" "$DESTINATION"; then
    if [ -e "$BACKUP" ]; then
      mv "$BACKUP" "$DESTINATION" || true
    fi
    fail "could not install Harness $VERSION"
  fi

  printf '%s\n' "Harness $VERSION installed at $DESTINATION"
  open "$DESTINATION"
  exit 0
fi

# ============================================================================
# Linux (Ubuntu)
# ============================================================================
MACHINE_ARCH="$(uname -m)"
case "$MACHINE_ARCH" in
  aarch64 | arm64)
    RELEASE_ARCH="arm64"
    ;;
  x86_64 | amd64)
    RELEASE_ARCH="x64"
    ;;
  *)
    fail "Harness desktop does not support this Linux architecture ($MACHINE_ARCH)."
    ;;
esac

OTA_KEY="desktop-linux-$RELEASE_ARCH"
APP_DIR="${HARNESS_DESKTOP_APP_DIR:-$HOME/.local/opt}"
DESTINATION="$APP_DIR/Harness.AppImage"

cleanup() {
  if [ -n "${STAGING_DIR:-}" ] && [ -d "$STAGING_DIR" ]; then
    rm -rf "$STAGING_DIR"
  fi
}

for command_name in curl sha256sum mktemp pgrep grep sed; do
  require_command "$command_name"
done

mkdir -p "$APP_DIR"
STAGING_DIR="$(mktemp -d "$APP_DIR/.harness-install.XXXXXX")" || fail "could not create an install staging directory in $APP_DIR"
trap cleanup EXIT HUP INT TERM

METADATA_FILE="$STAGING_DIR/metadata.json"
CANDIDATE="$STAGING_DIR/Harness-linux-$RELEASE_ARCH.AppImage"

printf '%s\n' "Fetching the latest Harness desktop release…"
curl -fL --retry 3 --connect-timeout 15 "$METADATA_URL" -o "$METADATA_FILE" \
  || fail "could not download desktop metadata"

# No `jq`/`plutil` dependency: the manifest is written by our own release script
# (scripts/upload-desktop-linux.sh, python's json.dump with indent=2), one "key": value per line, so a
# plain sed/grep extraction of the architecture-specific object is reliable without extra tooling —
# Ubuntu containers aren't guaranteed to have python3 or jq preinstalled, but grep/sed are Debian
# "Essential" packages present on every install.
METADATA_BLOCK="$(sed -n "/\"${OTA_KEY}\": {/,/^  }/p" "$METADATA_FILE")"
[ -n "$METADATA_BLOCK" ] || fail "desktop metadata is missing the $OTA_KEY entry"

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
  || fail "desktop metadata is missing $OTA_KEY.version/url/sha256/size"
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "desktop metadata has an invalid version"
# Both the GCS origin and its CDN (cdn.autonomous.ai, fronting the same bucket 1:1) are accepted,
# not swapped — same reasoning as the macOS case above; keep both in sync.
case "$ASSET_URL" in
  https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/*/Harness-linux-${RELEASE_ARCH}.AppImage) ;;
  https://cdn.autonomous.ai/harness/desktop/*/Harness-linux-${RELEASE_ARCH}.AppImage) ;;
  *) fail "desktop metadata points outside the Harness desktop release bucket" ;;
esac
printf '%s' "$EXPECTED_SHA256" | grep -Eq '^[0-9a-f]{64}$' \
  || fail "desktop metadata has an invalid SHA-256"
case "$EXPECTED_SIZE" in
  *[!0-9]* | '') fail "desktop metadata has an invalid archive size" ;;
esac

if pgrep -f "$DESTINATION" >/dev/null 2>&1; then
  fail "Harness is running from $DESTINATION. Quit it, then run this installer again."
fi

printf '%s\n' "Downloading Harness ${VERSION}…"
curl -fL --retry 3 --connect-timeout 15 "$ASSET_URL" -o "$CANDIDATE" \
  || fail "could not download Harness $VERSION"

ACTUAL_SIZE="$(wc -c < "$CANDIDATE" | tr -d '[:space:]')"
[ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ] \
  || fail "downloaded archive size does not match the release metadata"

# sha256 authenticates the whole single-file download — unlike the old tarball there is nothing else
# inside to unpack or recheck a version against.
ACTUAL_SHA256="$(sha256sum "$CANDIDATE" | awk '{print $1}')"
[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] \
  || fail "downloaded archive checksum does not match the release metadata"

chmod +x "$CANDIDATE"

# The staging directory lives in APP_DIR, so both moves remain on the same filesystem. If the
# second move fails, restore the previous install before reporting the failure.
BACKUP="$STAGING_DIR/previous-Harness.AppImage"
if [ -e "$DESTINATION" ]; then
  mv "$DESTINATION" "$BACKUP" || fail "could not prepare the existing Harness install for replacement"
fi
if ! mv "$CANDIDATE" "$DESTINATION"; then
  if [ -e "$BACKUP" ]; then
    mv "$BACKUP" "$DESTINATION" || true
  fi
  fail "could not install Harness $VERSION"
fi

# Best-effort desktop integration — a missing icon/launcher entry is not worth failing the install
# over, so none of this calls fail(). The AppImage carries its own icon and .desktop entry inside it,
# which an `appimaged`/AppImageLauncher daemon (if present) picks up on its own; this is the fallback
# for machines with neither. `--appimage-extract` pulls just the icon out of the image (no FUSE, and
# it never runs the app itself) so the menu entry isn't stuck with a generic icon.
ICON_DIR="$HOME/.local/share/icons"
mkdir -p "$ICON_DIR" 2>/dev/null || true
(
  cd "$STAGING_DIR" 2>/dev/null \
    && "$DESTINATION" --appimage-extract harness.png >/dev/null 2>&1 \
    && cp "$STAGING_DIR/squashfs-root/harness.png" "$ICON_DIR/harness.png" 2>/dev/null
) || true
DESKTOP_ENTRY_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_ENTRY_DIR" 2>/dev/null || true
if [ -d "$DESKTOP_ENTRY_DIR" ]; then
  # StartupWMClass ties the running window — app id com.autonomous.harness, set in the desktop
  # repo's linux/CMakeLists.txt — to this entry. Without it GNOME's dock cannot match the two and
  # shows the running app with a generic gear.
  cat > "$DESKTOP_ENTRY_DIR/harness.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Harness
Comment=Attach terminals to the agents running on your Harness machines
Exec=$DESTINATION
Icon=$ICON_DIR/harness.png
Terminal=false
Categories=Development;
StartupWMClass=com.autonomous.harness
EOF
fi

printf '%s\n' "Harness $VERSION installed at $DESTINATION"
"$DESTINATION" >/dev/null 2>&1 &
