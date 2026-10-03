#!/usr/bin/env bash
# Separate, disposable review app. The regular build keeps its default-off gate.
set -euo pipefail
DEVICES_DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVICES_REVIEW="$DEVICES_DESKTOP_DIR/build/devices-review/Devices Review.app"

cd "$DEVICES_DESKTOP_DIR"
bash scripts/build-macos-debug.sh --no-pub --target tool/devices_preview.dart \
  --dart-define=HARNESS_TEST=true --dart-define=DEVICES_REVIEW=true
mkdir -p "$(dirname "$DEVICES_REVIEW")"
ditto build/macos/Build/Products/Debug/Harness.app "$DEVICES_REVIEW"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier ai.autonomous.harness.devices-review.combined' "$DEVICES_REVIEW/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName Devices Review' "$DEVICES_REVIEW/Contents/Info.plist"
codesign --force --sign - \
  --preserve-metadata=entitlements,requirements,flags,runtime "$DEVICES_REVIEW"
codesign --verify --deep --strict "$DEVICES_REVIEW"
# Fixture builds replace Harness.app; always leave the normal entrypoint built.
bash scripts/build-macos-debug.sh --no-pub --target lib/main.dart
echo "Devices review ready: $DEVICES_REVIEW"
