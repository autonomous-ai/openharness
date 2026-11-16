#!/usr/bin/env bash
# Checks a Harness Device release in DIR (release-build.sh's three files) before anything leaves the build job.
# PUBKEY is the updater's public key as tauri.conf.json holds it (base64). --notarized adds Apple's checks, which a
# local or test build signed ad hoc cannot pass.
# Prints "ok: <check>" for each check, or "FAILED: <check>" and exits 1 at the first that fails.
set -euo pipefail

if ! [[ $# -eq 3 || ($# -eq 4 && "$4" == --notarized) ]]; then
  echo "usage: release-check.sh DIR VERSION PUBKEY [--notarized]" >&2
  exit 2
fi
dir="$1" version="$2" pubkey="$3" notarized="${4:-}"
dmg="$dir/Harness-Device.dmg"
archive="$dir/Harness-Device.app.tar.gz"

work="$(mktemp -d)"
mounted=""
cleanup() {
  # Never delete through a mount: a dmg that will not detach fails the run instead.
  if [[ -n "$mounted" ]]; then
    hdiutil detach -quiet "$work/dmg" || hdiutil detach -quiet -force "$work/dmg"
  fi
  rm -rf "$work"
}
trap cleanup EXIT

check() {
  local name="$1"
  shift
  if "$@"; then
    echo "ok: $name"
  else
    echo "FAILED: $name"
    exit 1
  fi
}

# Each check is one && chain: errexit is off inside a function called from `if`.
three_files() { [[ -f "$dmg" && -f "$archive" && -f "$archive.sig" ]]; }

universal() {
  local archs
  archs="$(lipo -archs "$1/Contents/MacOS/harness-device")" &&
    [[ "$archs" == "arm64 x86_64" || "$archs" == "x86_64 arm64" ]]
}

at_version() {
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist")" == "$version" ]]
}

archive_app() {
  mkdir "$work/archive" &&
    tar -xzf "$archive" -C "$work/archive" &&
    [[ "$(ls -A "$work/archive")" == "Harness Device.app" ]] &&
    universal "$work/archive/Harness Device.app"
}

# Tauri writes both the key and the signature base64-wrapped around minisign's own format.
update_signed() {
  printf '%s' "$pubkey" | base64 --decode >"$work/key.pub" &&
    base64 --decode <"$archive.sig" >"$work/archive.minisig" &&
    minisign -V -q -p "$work/key.pub" -x "$work/archive.minisig" -m "$archive"
}

# The app requires the manifest's version in the trusted comment (requireSignedVersion): tab-separated key:value
# fields, which minisign's global signature covers, so this runs after update_signed, on the file it decoded.
signed_version() {
  local trusted
  trusted="$(sed -n 's/^trusted comment: //p' "$work/archive.minisig")" &&
    [[ $'\t'"$trusted"$'\t' == *$'\t'"version:$version"$'\t'* ]]
}

dmg_app() {
  mkdir "$work/dmg" &&
    hdiutil attach -readonly -nobrowse -noautoopen -quiet -mountpoint "$work/dmg" "$dmg" &&
    mounted=1 &&
    at_version "$work/dmg/Harness Device.app" &&
    universal "$work/dmg/Harness Device.app" &&
    [[ -L "$work/dmg/Applications" && "$(readlink "$work/dmg/Applications")" == /Applications ]]
}

notarized_app() { spctl -a -t exec -vv "$1" && xcrun stapler validate "$1"; }

notarized_dmg() { xcrun stapler validate "$dmg" && spctl -a -t open --context context:primary-signature -vv "$dmg"; }

check "the three files" three_files
check "the archive holds a universal Harness Device.app" archive_app
check "the app is $version" at_version "$work/archive/Harness Device.app"
check "the app's code signature" codesign --verify --deep --strict "$work/archive/Harness Device.app"
check "the archive's update signature" update_signed
check "the update signature is for $version" signed_version
check "the dmg holds the app at $version, universal, and Applications" dmg_app
if [[ -n "$notarized" ]]; then
  check "the archive's app is notarized" notarized_app "$work/archive/Harness Device.app"
  check "the dmg's app is notarized" notarized_app "$work/dmg/Harness Device.app"
  check "the dmg is notarized" notarized_dmg
fi
