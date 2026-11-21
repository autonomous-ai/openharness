#!/usr/bin/env bash
# Build and package one Linux Desktop release for this host's architecture, holding no credential: this is the only
# step that runs build code (pub packages, CMake, appimagetool), so release-desktop.yml's build-linux gives it nothing
# to write to the bucket and no signing key. sign-desktop-linux.sh signs what it writes; upload-desktop-linux.sh
# publishes it.
#
# Usage: bash desktop/scripts/package-desktop-linux.sh <X.Y.Z>
# Writes desktop/build/linux-release/Harness-linux-<x64|arm64>.AppImage and its .sha256 (sha256sum form), nothing else.
# Prereqs: a Linux host (flutter build linux cannot cross-compile), flutter on PATH, and APPIMAGETOOL pointing at an
# executable appimagetool-<x86_64|aarch64>.AppImage (release-desktop.yml fetches a pinned one).
set -euo pipefail
set +x

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [ "$#" -ne 1 ]; then
  echo "usage: $0 <X.Y.Z>" >&2
  exit 2
fi
[ "$(uname -s)" = "Linux" ] || { echo "error: this must run on Linux: flutter build linux cannot cross-compile" >&2; exit 1; }
case "$(uname -m)" in
  aarch64|arm64) RELEASE_ARCH=arm64; APPIMAGE_ARCH=aarch64 ;;
  x86_64|amd64) RELEASE_ARCH=x64; APPIMAGE_ARCH=x86_64 ;;
  *) echo "error: unsupported Linux architecture '$(uname -m)'" >&2; exit 1 ;;
esac
for tool in flutter sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is required" >&2; exit 1; }
done
: "${APPIMAGETOOL:?set APPIMAGETOOL to a path to an appimagetool-<x86_64|aarch64>.AppImage binary}"
[ -x "$APPIMAGETOOL" ] || { echo "error: APPIMAGETOOL ($APPIMAGETOOL) is not executable" >&2; exit 1; }

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="$APP_DIR/build/linux/$RELEASE_ARCH/release/bundle"
OUT_DIR="$APP_DIR/build/linux-release"
NAME="Harness-linux-$RELEASE_ARCH.AppImage"
STAGE_ROOT="$(mktemp -d)"
trap 'rm -rf "$STAGE_ROOT"' EXIT

echo ">> building linux-$RELEASE_ARCH $VERSION"
rm -rf "$BUNDLE_DIR"
( cd "$APP_DIR" && flutter build linux --release )
[ -x "$BUNDLE_DIR/harness" ] || { echo "error: no harness executable in $BUNDLE_DIR" >&2; exit 1; }
[ -f "$BUNDLE_DIR/harness.png" ] || { echo "error: no harness.png in $BUNDLE_DIR (expected via the CMake install rule)" >&2; exit 1; }

# flutter build linux stamps no version, so version.txt carries it: lib/core/app_version.dart reads it at run time and
# DesktopUpdater checks it in a downloaded update. Asserted so the manifest's version is the one inside the AppImage.
echo "$VERSION" > "$BUNDLE_DIR/version.txt"
[ "$(cat "$BUNDLE_DIR/version.txt")" = "$VERSION" ] || { echo "error: version.txt does not read $VERSION" >&2; exit 1; }

# AppDir: usr/bin/ holds the Flutter bundle verbatim (harness, version.txt, lib/, data/, harness.png). AppRun is a
# symlink rather than a wrapper script: the Flutter runner finds its lib/ and data/ next to /proc/self/exe, which is the
# real binary after exec whatever link launched it.
APPDIR="$STAGE_ROOT/AppDir"
mkdir -p "$APPDIR/usr/bin"
cp -a "$BUNDLE_DIR/." "$APPDIR/usr/bin/"
ln -s usr/bin/harness "$APPDIR/AppRun"
cp "$BUNDLE_DIR/harness.png" "$APPDIR/harness.png"
# StartupWMClass is the window's app id (APPLICATION_ID, linux/CMakeLists.txt): how a dock matches the running window
# to this entry instead of drawing it with a generic icon.
cat > "$APPDIR/harness.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Harness
Comment=Attach terminals to the agents running on your Harness machines
Exec=harness %u
MimeType=x-scheme-handler/harness;
Icon=harness
Categories=Development;
Terminal=false
StartupWMClass=com.autonomous.harness
EOF

# The folder holds what this run made and nothing older.
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
echo ">> packaging $OUT_DIR/$NAME"
# --appimage-extract-and-run: the runner needs no FUSE.
ARCH="$APPIMAGE_ARCH" "$APPIMAGETOOL" --appimage-extract-and-run "$APPDIR" "$OUT_DIR/$NAME" \
  || { echo "error: appimagetool failed" >&2; exit 1; }
chmod +x "$OUT_DIR/$NAME"
( cd "$OUT_DIR" && sha256sum "$NAME" > "$NAME.sha256" )
echo ">> linux-$RELEASE_ARCH $VERSION packaged: $(cat "$OUT_DIR/$NAME.sha256")"
