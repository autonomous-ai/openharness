#!/usr/bin/env bash
# Checks a Harness Device release in DIR (what release-build.sh wrote on this OS) before anything leaves the build job.
# PUBKEY is the updater's public key as tauri.conf.json holds it (base64). --notarized adds Apple's checks on macOS and
# --signed Authenticode's on Windows, which a local or test build cannot pass.
# Prints "ok: <check>" for each check, or "FAILED: <check>" and exits 1 at the first that fails.
set -euo pipefail

case "$(uname -s)" in
  Darwin) os=macos flag=--notarized ;;
  Linux) os=linux flag="" ;;
  # Git Bash, which runs a Windows job's bash steps.
  MINGW* | MSYS* | CYGWIN*) os=windows flag=--signed ;;
  *)
    echo "release-check: checks on macOS, Linux or Windows only" >&2
    exit 2
    ;;
esac
if ! [[ $# -eq 3 || ($# -eq 4 && -n "$flag" && "$4" == "$flag") ]]; then
  echo "usage: release-check.sh DIR VERSION PUBKEY [--notarized on macOS | --signed on Windows]" >&2
  exit 2
fi
dir="$1" version="$2" pubkey="$3" vendor_checks="${4:-}"
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

# The update signature of the file $1, in $1.sig. Tauri writes both the key and the signature base64-wrapped around
# minisign's own format.
update_signed() {
  local minisig
  minisig="$work/$(basename "$1").minisig" &&
    printf '%s' "$pubkey" | base64 --decode >"$work/key.pub" &&
    base64 --decode <"$1.sig" >"$minisig" &&
    minisign -V -q -p "$work/key.pub" -x "$minisig" -m "$1"
}

# The app requires the manifest's version in the trusted comment (requireSignedVersion): tab-separated key:value
# fields, which minisign's global signature covers, so this runs after update_signed, on the file it decoded.
signed_version() {
  local trusted
  trusted="$(sed -n 's/^trusted comment: //p' "$work/$(basename "$1").minisig")" &&
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

with_signature() { [[ -f "$1" && -f "$1.sig" ]]; }

# An ELF file's magic, then its e_machine: two bytes, little-endian, at offset 18.
elf_machine() {
  [[ "$(od -An -tx1 -N4 "$1" | tr -d ' \n')" == 7f454c46 &&
    "$(od -An -tx1 -j18 -N2 "$1" | tr -d ' \n')" == "$2" ]]
}

# Get-AuthenticodeSignature only reads the file. Its path reaches PowerShell through the environment, not the
# command's text: the $env in single quotes is PowerShell's.
# shellcheck disable=SC2016
authenticode_valid() {
  local file
  file="$(cygpath -w "$1")" &&
    SIGNED_FILE="$file" pwsh -NoProfile -NonInteractive -Command \
      'if ((Get-AuthenticodeSignature -LiteralPath $env:SIGNED_FILE).Status -ne "Valid") { exit 1 }'
}

case "$os" in
  macos)
    check "the three files" three_files
    check "the archive holds a universal Harness Device.app" archive_app
    check "the app is $version" at_version "$work/archive/Harness Device.app"
    check "the app's code signature" codesign --verify --deep --strict "$work/archive/Harness Device.app"
    check "the archive's update signature" update_signed "$archive"
    check "the update signature is for $version" signed_version "$archive"
    check "the dmg holds the app at $version, universal, and Applications" dmg_app
    if [[ -n "$vendor_checks" ]]; then
      check "the archive's app is notarized" notarized_app "$work/archive/Harness Device.app"
      check "the dmg's app is notarized" notarized_app "$work/dmg/Harness Device.app"
      check "the dmg is notarized" notarized_dmg
    fi
    ;;
  linux)
    # This host's AppImage: 62 is EM_X86_64, 183 EM_AARCH64.
    case "$(uname -m)" in
      x86_64) arch=x64 machine=3e00 ;;
      aarch64) arch=arm64 machine=b700 ;;
      *)
        echo "release-check: checks Linux on x86_64 or aarch64 only" >&2
        exit 2
        ;;
    esac
    appimage="$dir/Harness-Device-linux-$arch.AppImage"
    check "the AppImage and its update signature" with_signature "$appimage"
    check "the AppImage is $(uname -m)" elf_machine "$appimage" "$machine"
    check "the AppImage's update signature" update_signed "$appimage"
    check "the update signature is for $version" signed_version "$appimage"
    ;;
  windows)
    shopt -s nullglob
    installers=("$dir"/Harness-Device-windows-*-setup.exe)
    check "an installer" test ${#installers[@]} -gt 0
    for installer in "${installers[@]}"; do
      name="$(basename "$installer")"
      check "$name's update signature" update_signed "$installer"
      check "$name's update signature is for $version" signed_version "$installer"
      if [[ -n "$vendor_checks" ]]; then
        check "$name's Authenticode signature" authenticode_valid "$installer"
      fi
    done
    ;;
esac
