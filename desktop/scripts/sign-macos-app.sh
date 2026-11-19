#!/usr/bin/env bash
# Sign a built Harness.app: each framework, then the app with the hardened runtime and the Release
# entitlements. This is the one place a release's app is signed. Builds carry only an ad-hoc signature
# (scripts/publish-macos-variant.sh), so the job that builds a branch never needs the certificate, and
# the release's sign-macos job, which builds nothing, signs here (see .github/workflows/release-desktop.yml).
#
# Usage:
#   SIGN_IDENTITY="Developer ID Application" bash scripts/sign-macos-app.sh path/to/Harness.app
#   SIGN_IDENTITY=- bash scripts/sign-macos-app.sh path/to/Harness.app    # ad hoc (internal builds)
#
# Nothing but the main executable and the frameworks may carry code: a helper, dylib, plug-in or login
# item added later would ship with a signature this script never wrote, so it is refused until it is
# signed here.
set -euo pipefail
set +x

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # desktop/
ENTITLEMENTS="$APP_DIR/macos/Runner/Release.entitlements"
SIGN_IDENTITY="${SIGN_IDENTITY:-Developer ID Application}"

die() { echo "error: $*" >&2; exit 1; }

[ $# -eq 1 ] || die "usage: bash scripts/sign-macos-app.sh <Harness.app>"
APP_BUNDLE="$1"
[ -d "$APP_BUNDLE/Contents" ] || die "not an app bundle: $APP_BUNDLE"
[ -f "$ENTITLEMENTS" ] || die "entitlements missing: $ENTITLEMENTS"

unexpected="$(cd "$APP_BUNDLE" && find Contents \
  \( -path 'Contents/Frameworks/*.framework' -prune \) -o \
  \( -path Contents/MacOS/Harness \) -o \
  \( \( -type f -perm -0100 -o -name '*.app' -o -name '*.appex' -o -name '*.xpc' -o -name '*.framework' \
        -o -name '*.dylib' -o -name '*.so' \) -print \))"
[ -z "$unexpected" ] || die "unexpected code in $APP_BUNDLE, sign it in scripts/sign-macos-app.sh first:
$unexpected"

for framework in "$APP_BUNDLE"/Contents/Frameworks/*.framework; do
  [ -e "$framework" ] || continue
  codesign --force --sign "$SIGN_IDENTITY" --timestamp "$framework"
done
codesign --force --sign "$SIGN_IDENTITY" --timestamp --options runtime --entitlements "$ENTITLEMENTS" "$APP_BUNDLE"
codesign --verify --deep --strict "$APP_BUNDLE" || die "the signature does not verify: $APP_BUNDLE"
