#!/usr/bin/env bash
# Build the iOS app and hand it to App Store Connect. `bash mobile/scripts/release-ios.sh`
#
# This replaces the Xcode Organizer round trip, which is the only way builds have reached ASC so far
# — there is no CI path, and nothing in this repo uploads on a tag. Run it from a Mac that can sign
# for the team in `ios/Runner.xcodeproj` (DEVELOPMENT_TEAM 54DJVWMJCC, Autonomous Inc.).
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
# Auth, either one:
#   ASC_KEY_ID + ASC_ISSUER_ID   an App Store Connect API key, with the .p8 in one of the private_keys
#                                directories altool searches (~/.appstoreconnect/private_keys or
#                                ~/.private_keys), named AuthKey_<ASC_KEY_ID>.p8. Preferred: it does
#                                not expire on a password change and is what CI would use later.
#   ASC_USERNAME + ASC_APP_PASSWORD
#                                an Apple ID and an APP-SPECIFIC password (appleid.apple.com ▸ Sign-In
#                                and Security ▸ App-Specific Passwords). Not the account password.
#
# Usage:
#   bash mobile/scripts/release-ios.sh                 build, validate, upload
#   bash mobile/scripts/release-ios.sh --validate-only build and validate, upload nothing
#   bash mobile/scripts/release-ios.sh --skip-build    upload the ipa already in build/ios/ipa
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # mobile/
cd "$ROOT"

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

AUTH=()
if [[ -n "${ASC_KEY_ID:-}" && -n "${ASC_ISSUER_ID:-}" ]]; then
  AUTH=(--apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID")
  echo "==> authenticating with API key $ASC_KEY_ID"
elif [[ -n "${ASC_USERNAME:-}" && -n "${ASC_APP_PASSWORD:-}" ]]; then
  AUTH=(--username "$ASC_USERNAME" --password "@env:ASC_APP_PASSWORD")
  echo "==> authenticating as $ASC_USERNAME"
else
  echo "no credentials: set ASC_KEY_ID + ASC_ISSUER_ID, or ASC_USERNAME + ASC_APP_PASSWORD," >&2
  echo "or put them in $ASC_CONFIG (which this script sources when they are unset)." >&2
  echo "see the header of this script for where each value comes from." >&2
  exit 1
fi

# -- build ----------------------------------------------------------------------------------------
if [[ "$SKIP_BUILD" == 0 ]]; then
  echo "==> flutter build ipa"
  flutter build ipa --release --export-method app-store
fi

IPA="$(ls -t build/ios/ipa/*.ipa 2>/dev/null | head -1 || true)"
if [[ -z "$IPA" ]]; then
  echo "no .ipa in build/ios/ipa — run without --skip-build" >&2
  exit 1
fi
echo "==> $IPA"

# The pair printed above came from pubspec.yaml, which is what the NEXT build would carry — with
# --skip-build the artifact on disk can predate a bump, and then the number announced is not the
# number sent. Ask the archive itself and say so.
ipa_key() {
  unzip -p "$IPA" 'Payload/*.app/Info.plist' 2>/dev/null \
    | plutil -extract "$1" raw -o - - 2>/dev/null || true
}
IPA_SHORT="$(ipa_key CFBundleShortVersionString)"
IPA_BUILD="$(ipa_key CFBundleVersion)"
if [[ -n "$IPA_BUILD" && ( "$IPA_BUILD" != "$BUILD" || "$IPA_SHORT" != "$SHORT" ) ]]; then
  echo "!!  this ipa is $IPA_SHORT ($IPA_BUILD), NOT the $SHORT ($BUILD) in pubspec.yaml."
  echo "    It was built before the last bump — drop --skip-build to rebuild, or App Store Connect"
  echo "    will refuse it as a duplicate."
fi

# -- validate, then upload -------------------------------------------------------------------------
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

cat <<EOF

Uploaded $SHORT ($BUILD).

It is NOT submitted, and it is not visible yet. App Store Connect processes the build first (5–30
minutes, occasionally hours), then it becomes selectable:

  1. appstoreconnect.apple.com -> Autonomous Harness -> Distribution -> iOS App $SHORT
  2. Build section -> + -> pick $SHORT ($BUILD)
  3. Add for Review -> Submit for Review

See mobile/RELEASE.md for what the rest of that page needs before Apple will take it.
EOF
