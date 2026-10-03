#!/usr/bin/env bash
# Build the local review app with the renderer used by the matching release.
# Flutter's macOS default is Impeller, including on Intel where bitmap artwork
# can disappear. A Finder launch cannot inherit `flutter run --no-enable-impeller`.
set -euo pipefail

DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$DESKTOP_DIR/build/macos/Build/Products/Debug/Harness.app"
PLIST="$APP_BUNDLE/Contents/Info.plist"

[[ "$(uname -s)" == Darwin ]] || { echo 'This build requires macOS.' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) IMPELLER=false; RENDERER=Skia ;;
  arm64) IMPELLER=true; RENDERER=Impeller ;;
  *) echo 'A local macOS build requires an Intel or Apple Silicon Mac.' >&2; exit 1 ;;
esac

(cd "$DESKTOP_DIR" && flutter build macos --debug "$@")

# Only the built debug bundle changes; release renderer selection still belongs
# to publish-macos-variant.sh. Re-sign the bundle after changing its Info.plist.
if /usr/libexec/PlistBuddy -c 'Print :FLTEnableImpeller' "$PLIST" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Set :FLTEnableImpeller $IMPELLER" "$PLIST"
else
  /usr/libexec/PlistBuddy -c "Add :FLTEnableImpeller bool $IMPELLER" "$PLIST"
fi
[[ "$(/usr/libexec/PlistBuddy -c 'Print :FLTEnableImpeller' "$PLIST")" == "$IMPELLER" ]]
codesign --force --sign - \
  --preserve-metadata=identifier,entitlements,requirements,flags,runtime "$APP_BUNDLE"
codesign --verify --deep --strict "$APP_BUNDLE"
echo "Local review build ready ($RENDERER): $APP_BUNDLE"
