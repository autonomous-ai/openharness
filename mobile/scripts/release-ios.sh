#!/usr/bin/env bash
# Build the iOS app and hand it to App Store Connect. `bash mobile/scripts/release-ios.sh`
#
# This replaces the Xcode Organizer round trip — there is no CI path, and nothing in this repo uploads
# on a tag. Run it from a Mac that can sign for the team in `ios/Runner.xcodeproj` (DEVELOPMENT_TEAM
# 54DJVWMJCC, Autonomous Inc.).
#
# ⚠️ THE BUILD NUMBER IS THE WHOLE GAME. App Store Connect keys a build on
# (CFBundleShortVersionString, CFBundleVersion) — `1.0.0` and the number after the `+` in
# pubspec.yaml — and REFUSES a pair it has seen before. The refusal arrives by email, not in the ASC
# UI, which is why an upload can look like it simply never happened. Bump the `+N` in
# `mobile/pubspec.yaml` before every upload; this script prints the pair it is about to send and
# stops if the short version does not look like one ASC would accept.
#
# ⚠️ And the short version must MATCH the version record you are filling in on ASC. A build uploaded
# as `1.0.0` does not appear under a version called `1.0` — the Build section stays empty and the
# submission cannot be completed. Make the two strings identical.
#
# Auth, first one found:
#   ASC_KEY_ID + ASC_ISSUER_ID   an App Store Connect API key, with the .p8 in one of the private_keys
#                                directories altool searches (~/.appstoreconnect/private_keys or
#                                ~/.private_keys), named AuthKey_<ASC_KEY_ID>.p8. Preferred: it does
#                                not expire on a password change, and it SIGNS too — the export is
#                                handed the same key, so a Mac with no certificate and no Xcode account
#                                signs with the team's cloud-managed distribution certificate. That
#                                needs a key with the Admin role; App Manager can upload but not sign.
#   ASC_USERNAME + ASC_APP_PASSWORD
#                                an Apple ID and an APP-SPECIFIC password (appleid.apple.com ▸ Sign-In
#                                and Security ▸ App-Specific Passwords). Not the account password.
#                                Uploads only: signing still needs the account in Xcode (below).
#   neither                      the Apple account signed into Xcode ▸ Settings ▸ Accounts signs AND
#                                uploads (`xcodebuild -exportArchive`, destination upload). Nothing is
#                                validated first, so --validate-only needs one of the two above.
#
# Usage:
#   bash mobile/scripts/release-ios.sh                 build, validate, upload
#   bash mobile/scripts/release-ios.sh --validate-only build and validate, upload nothing
#   bash mobile/scripts/release-ios.sh --skip-build    upload what the last build left in build/ios
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # mobile/
cd "$ROOT"
# shellcheck source=ios-entitlements.sh
source "$ROOT/scripts/ios-entitlements.sh"

VALIDATE_ONLY=0
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --validate-only) VALIDATE_ONLY=1 ;;
    --skip-build)    SKIP_BUILD=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# -- what is about to be uploaded ----------------------------------------------------------------
VERSION="$(sed -n 's/^version: *//p' pubspec.yaml | head -1)"
SHORT="${VERSION%%+*}"
BUILD="${VERSION##*+}"
if [[ -z "$SHORT" || -z "$BUILD" || "$SHORT" == "$VERSION" ]]; then
  echo "pubspec.yaml needs a version of the form 1.0.0+3 (got '${VERSION:-<none>}')" >&2
  exit 1
fi
echo "==> version $SHORT, build $BUILD"
echo "    ASC must have a version record called exactly '$SHORT', and must not already hold build $BUILD."

# The export options name the team, so read it from the project rather than repeat it here.
TEAM_ID="$(sed -n 's/.*DEVELOPMENT_TEAM = \([A-Z0-9]*\);.*/\1/p' ios/Runner.xcodeproj/project.pbxproj | head -1)"
if [[ -z "$TEAM_ID" ]]; then
  echo "no DEVELOPMENT_TEAM in ios/Runner.xcodeproj/project.pbxproj" >&2
  exit 1
fi

# What the app asks for (push, the setup hotspot), read from the project too. Empty: none.
ENTITLEMENTS="$(sed -n 's/.*CODE_SIGN_ENTITLEMENTS = \(.*\);.*/\1/p' ios/Runner.xcodeproj/project.pbxproj | head -1)"
ENTITLEMENTS="${ENTITLEMENTS:+ios/$ENTITLEMENTS}"

# -- credentials, before spending five minutes on a build ----------------------------------------
# They live OUTSIDE this repo, which is PUBLIC. A Key ID and an Issuer ID are not secrets on their
# own, but they are exactly the two halves a stray .p8 would need, and the repo's own .gitignore
# already refuses `*.p8` and `.env*` — committing the other halves into a Markdown file would walk
# around that. Sourced only when the environment does not already carry them, so CI can still pass
# them in.
ASC_CONFIG="${ASC_CONFIG:-$HOME/.appstoreconnect/harness-release.env}"
if [[ -z "${ASC_KEY_ID:-}" && -z "${ASC_USERNAME:-}" && -f "$ASC_CONFIG" ]]; then
  # shellcheck source=/dev/null
  source "$ASC_CONFIG"
fi

AUTH=()            # altool
XCODE_AUTH=()      # xcodebuild; empty means Xcode's own signed-in account
UPLOAD_WITH_XCODE=0
if [[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" ]]; then
  AUTH=(--apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID")
  # altool finds the .p8 by itself; xcodebuild has to be given its path.
  KEY_FILE=""
  for dir in "$HOME/.appstoreconnect/private_keys" "$HOME/.private_keys"; do
    if [[ -f "$dir/AuthKey_$ASC_KEY_ID.p8" ]]; then
      KEY_FILE="$dir/AuthKey_$ASC_KEY_ID.p8"
      break
    fi
  done
  if [[ -z "$KEY_FILE" ]]; then
    echo "API key $ASC_KEY_ID: no AuthKey_$ASC_KEY_ID.p8 in ~/.appstoreconnect/private_keys or ~/.private_keys" >&2
    exit 1
  fi
  XCODE_AUTH=(-authenticationKeyPath "$KEY_FILE" -authenticationKeyID "$ASC_KEY_ID"
              -authenticationKeyIssuerID "$ASC_ISSUER_ID")
  echo "==> signing and uploading with API key $ASC_KEY_ID"
elif [[ -n "${ASC_USERNAME:-}" && -n "${ASC_APP_PASSWORD:-}" ]]; then
  AUTH=(--username "$ASC_USERNAME" --password "@env:ASC_APP_PASSWORD")
  echo "==> uploading as $ASC_USERNAME; signing with the account in Xcode ▸ Settings ▸ Accounts"
elif [[ "$VALIDATE_ONLY" == 1 ]]; then
  echo "--validate-only needs ASC_KEY_ID + ASC_ISSUER_ID or ASC_USERNAME + ASC_APP_PASSWORD," >&2
  echo "or put them in $ASC_CONFIG — Xcode's account can upload but not validate on its own." >&2
  exit 1
else
  UPLOAD_WITH_XCODE=1
  echo "==> no API key or app-specific password: signing AND uploading with the Apple account in"
  echo "    Xcode ▸ Settings ▸ Accounts (a member of team $TEAM_ID). Nothing is validated first."
fi

ARCHIVE="$ROOT/build/ios/archive/Runner.xcarchive"
IPA_DIR="$ROOT/build/ios/ipa"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# `${XCODE_AUTH[@]+...}`, not `"${XCODE_AUTH[@]}"`: macOS's bash 3.2 calls an empty array unbound
# under `set -u`.
#
# One export for both ways out of the archive: `export` writes the ipa altool validates and uploads,
# `upload` hands the build to ASC from xcodebuild itself, on whatever account signed it.
export_archive() {
  cat > "$WORK/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$1</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF
  xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$IPA_DIR" \
    -exportOptionsPlist "$WORK/ExportOptions.plist" \
    -allowProvisioningUpdates ${XCODE_AUTH[@]+"${XCODE_AUTH[@]}"}
}

# The entitlements onto the archived app, for the export to carry (ios-entitlements.sh says why).
sign_archive_entitlements() {
  [[ -n "$ENTITLEMENTS" ]] || return 0
  echo "==> entitlements onto the archived app (ad-hoc signature)"
  carry_entitlements "$ARCHIVE/Products/Applications/Runner.app" "$ENTITLEMENTS"
  check_entitlements "$ARCHIVE/Products/Applications/Runner.app" "the archived app" any "$ENTITLEMENTS"
}

# The app inside the exported ipa, unpacked so its signature can be read, before anything goes up.
check_ipa_entitlements() {   # $1 = .ipa
  [[ -n "$ENTITLEMENTS" ]] || return 0
  rm -rf "$WORK/ipa" && mkdir -p "$WORK/ipa" && unzip -q "$1" -d "$WORK/ipa"
  check_entitlements "$(ls -d "$WORK"/ipa/Payload/*.app | head -1)" "the exported app" production \
    "$ENTITLEMENTS"
}

# The pair printed above came from pubspec.yaml, which is what the NEXT build would carry — with
# --skip-build the artifact on disk can predate a bump, and then the number announced is not the
# number sent. Ask the artifact itself and say so.
warn_if_stale() {   # $1 = short version, $2 = build number, both as read from the artifact
  if [[ -n "$2" && ( "$2" != "$BUILD" || "$1" != "$SHORT" ) ]]; then
    echo "!!  this build is $1 ($2), NOT the $SHORT ($BUILD) in pubspec.yaml."
    echo "    It was built before the last bump — drop --skip-build to rebuild, or App Store Connect"
    echo "    will refuse it as a duplicate."
  fi
}

uploaded() {
  cat <<EOF

Uploaded $SHORT ($BUILD).

It is NOT submitted, and it is not visible yet. App Store Connect processes the build first (5–30
minutes, occasionally hours), then it becomes selectable:

  1. appstoreconnect.apple.com -> Autonomous Harness -> Distribution -> iOS App $SHORT
  2. Build section -> + -> pick $SHORT ($BUILD)
  3. Add for Review -> Submit for Review

See mobile/RELEASE.md for what the rest of that page needs before Apple will take it.
EOF
}

# -- build ----------------------------------------------------------------------------------------
# Not `flutter build ipa`: it cannot pass xcodebuild an API key, so on a Mac with no certificate and
# no Xcode account it fails at signing whatever key is configured. `--config-only` does Flutter's
# part (Generated.xcconfig from pubspec.yaml, pods) and xcodebuild does the rest, as on Xcode Cloud.
#
# The archive is left UNSIGNED and the export signs it, app and frameworks alike, with the team's
# Apple Distribution certificate. A signed archive would need an Apple Development certificate on
# this Mac first, and the shared release account has used up its quota of those ("Choose a
# certificate to revoke") — revoking one breaks whichever Mac holds it. An unsigned app carries no
# entitlements, though, so Runner.entitlements goes onto it with an ad-hoc signature first, and the
# exported app is checked for them before it is uploaded (ios-entitlements.sh).
if [[ "$SKIP_BUILD" == 0 ]]; then
  echo "==> flutter build ios --config-only"
  flutter build ios --release --config-only

  echo "==> xcodebuild archive (unsigned)"
  xcodebuild -workspace ios/Runner.xcworkspace -scheme Runner -configuration Release \
    -sdk iphoneos -destination generic/platform=iOS -archivePath "$ARCHIVE" \
    -quiet archive COMPILER_INDEX_STORE_ENABLE=NO \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""
  sign_archive_entitlements

  if [[ "$UPLOAD_WITH_XCODE" == 0 ]]; then
    echo "==> xcodebuild -exportArchive"
    export_archive export
  fi
fi

# -- Xcode's account: upload straight from the archive --------------------------------------------
if [[ "$UPLOAD_WITH_XCODE" == 1 ]]; then
  if [[ ! -f "$ARCHIVE/Info.plist" ]]; then
    echo "no archive at $ARCHIVE — run without --skip-build" >&2
    exit 1
  fi
  echo "==> $ARCHIVE"
  warn_if_stale \
    "$(plutil -extract ApplicationProperties.CFBundleShortVersionString raw -o - "$ARCHIVE/Info.plist" 2>/dev/null || true)" \
    "$(plutil -extract ApplicationProperties.CFBundleVersion raw -o - "$ARCHIVE/Info.plist" 2>/dev/null || true)"
  # An archive left by a run from before the ad-hoc step has none on it yet.
  if [[ "$SKIP_BUILD" == 1 ]]; then
    sign_archive_entitlements
  fi

  # The upload signs the archive the way this export does, and leaves nothing on disk to look at:
  # export it here first, so the app that goes up has been checked.
  echo "==> xcodebuild -exportArchive, to check what the upload will sign"
  export_archive export
  check_ipa_entitlements "$(ls -t "$IPA_DIR"/*.ipa | head -1)"

  echo "==> uploading with Xcode's account"
  export_archive upload
  uploaded
  exit 0
fi

# -- API key or app-specific password: validate, then upload the ipa ------------------------------
IPA="$(ls -t "$IPA_DIR"/*.ipa 2>/dev/null | head -1 || true)"
if [[ -z "$IPA" ]]; then
  echo "no .ipa in build/ios/ipa — run without --skip-build" >&2
  exit 1
fi
echo "==> $IPA"

ipa_key() {
  unzip -p "$IPA" 'Payload/*.app/Info.plist' 2>/dev/null \
    | plutil -extract "$1" raw -o - - 2>/dev/null || true
}
warn_if_stale "$(ipa_key CFBundleShortVersionString)" "$(ipa_key CFBundleVersion)"
check_ipa_entitlements "$IPA"

# Validation catches the whole class of rejections that otherwise arrive by email 20 minutes later:
# a duplicate build number, a missing icon size, an entitlement the profile does not grant.
echo "==> validating"
xcrun altool --validate-app -f "$IPA" -t ios "${AUTH[@]}"

if [[ "$VALIDATE_ONLY" == 1 ]]; then
  echo "==> validate-only: nothing uploaded"
  exit 0
fi

echo "==> uploading"
xcrun altool --upload-app -f "$IPA" -t ios "${AUTH[@]}"
uploaded
