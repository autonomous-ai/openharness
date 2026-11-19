#!/usr/bin/env bash
# Builds one Harness Device release for this machine's OS in steps, so the build's third-party code (crates' build
# scripts, npm packages) runs before any signing secret is in the environment:
#
# - `release-build.sh compile VERSION [CONFIG_JSON]` compiles the app, and refuses a signing secret in its environment.
# - `release-build.sh bundle VERSION OUT_DIR [CONFIG_JSON]` bundles what compile built into an empty OUT_DIR, under the
#   fixed names the manifest and the website use: on macOS the dmg and the update archive, signed and notarized; on
#   Linux the AppImage; each with its update signature. On Windows the installer alone: Authenticode signs it next.
# - `release-build.sh sign-update VERSION OUT_DIR`, on Windows, writes the update signature of each installer in
#   OUT_DIR once Authenticode signed it, so the signature covers the bytes that ship.
#
# The target is universal-apple-darwin on macOS and the host's on Linux. On Windows DEVICE_TARGET names it,
# x86_64-pc-windows-msvc or aarch64-pc-windows-msvc: both are built on one x64 runner.
#
# compile and bundle take the same VERSION and CONFIG_JSON: the binary embeds the configuration the bundle describes.
# CONFIG_JSON, when given, is merged last (a test build's updater keys and endpoint).
#
# The signing and notarization come from the environment, as Tauri reads it: the `secrets` below. This script names
# none of their values.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(dirname "$here")"

die() {
  echo "release-build: $*" >&2
  exit 1
}

secrets=(APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID TAURI_SIGNING_PRIVATE_KEY
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD)

step="${1:-}"
case "$step:$#" in
  compile:2 | compile:3 | bundle:3 | bundle:4 | sign-update:3) ;;
  *) die "usage: release-build.sh compile VERSION [CONFIG_JSON] | bundle VERSION OUT_DIR [CONFIG_JSON] | sign-update VERSION OUT_DIR" ;;
esac
version="$2"
shift 2
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "the version is not X.Y.Z"

case "$(uname -s)" in
  Darwin) os=macos host=universal-apple-darwin ;;
  Linux) os=linux host="$(uname -m)-unknown-linux-gnu" ;;
  # Git Bash, which runs a Windows job's bash steps.
  MINGW* | MSYS* | CYGWIN*) os=windows host="" ;;
  *) die "builds on macOS, Linux or Windows only" ;;
esac

if [[ "$step" == sign-update ]]; then
  [[ "$os" == windows ]] || die "sign-update is for Windows: elsewhere bundle writes the update signature"
  shopt -s nullglob
  installers=("$1"/*-setup.exe)
  [[ ${#installers[@]} -gt 0 ]] || die "OUT_DIR holds no installer"
  for installer in "${installers[@]}"; do
    # The version goes in the signature's trusted comment, which the app requires (requireSignedVersion).
    cargo tauri signer sign --app-version "$version" "$installer"
  done
  exit 0
fi

# arch names the release's files; bundle_arch is the word Tauri puts in its bundle's name.
target="${DEVICE_TARGET:-$host}"
case "$os:$target" in
  macos:universal-apple-darwin) ;;
  linux:x86_64-unknown-linux-gnu) arch=x64 bundle_arch=amd64 ;;
  linux:aarch64-unknown-linux-gnu) arch=arm64 bundle_arch=aarch64 ;;
  windows:x86_64-pc-windows-msvc) arch=x64 bundle_arch=x64 ;;
  windows:aarch64-pc-windows-msvc) arch=arm64 bundle_arch=arm64 ;;
  windows:) die "DEVICE_TARGET must name x86_64-pc-windows-msvc or aarch64-pc-windows-msvc" ;;
  *) die "does not build $target on $os" ;;
esac
# An AppImage carries the libraries of the machine that bundled it.
[[ "$os" != linux || "$target" == "$host" ]] || die "Linux builds for its own host, $host"

if [[ "$step" == bundle ]]; then
  mkdir -p "$1"
  out="$(cd "$1" && pwd)"
  shift
  # An earlier build's files must never be taken for this one's.
  [[ -z "$(ls -A "$out")" ]] || die "OUT_DIR is not empty"
fi

# Windows' update signature comes from sign-update, after Authenticode changed the installer's bytes.
updater=true
[[ "$os" != windows ]] || updater=false
# Later --config values win, so the caller's CONFIG_JSON overrides the release's own.
configs=(--config "{\"version\":\"$version\",\"bundle\":{\"createUpdaterArtifacts\":$updater}}")
if [[ $# -eq 1 ]]; then
  configs+=(--config "$1")
fi

cd "$app/src-tauri"

if [[ "$step" == compile ]]; then
  for name in "${secrets[@]}"; do
    [[ -z "${!name+set}" ]] || die "compile runs with no $name in its environment"
  done
  # --locked reaches cargo build: a Cargo.lock that does not match Cargo.toml is refused, never rewritten.
  exec cargo tauri build --ci --no-bundle --target "$target" "${configs[@]}" -- --locked
fi

case "$os" in
  macos) bundles=app,dmg ;;
  linux) bundles=appimage ;;
  windows) bundles=nsis ;;
esac
cargo tauri bundle --ci --target "$target" --bundles "$bundles" "${configs[@]}"

# CARGO_TARGET_DIR may put the target folder anywhere; cargo names it. sed, not Python, reads its one-line JSON: Windows
# runners have no python3. A Windows path's escaped backslashes become slashes, which Git Bash reads as well.
target_dir="$(cargo metadata --format-version 1 --no-deps | sed -n 's/.*"target_directory": *"\([^"]*\)".*/\1/p')"
target_dir="${target_dir//\\\\//}"
[[ -n "$target_dir" ]] || die "cargo named no target folder"
bundle="$target_dir/$target/release/bundle"
# Pairs: what the build wrote, then the name it is released under.
case "$os" in
  macos)
    archive="$bundle/macos/Harness Device.app.tar.gz"
    files=("$bundle/dmg/Harness Device_${version}_universal.dmg" Harness-Device.dmg
      "$archive" Harness-Device.app.tar.gz
      "$archive.sig" Harness-Device.app.tar.gz.sig)
    ;;
  linux)
    appimage="$bundle/appimage/Harness Device_${version}_$bundle_arch.AppImage"
    files=("$appimage" "Harness-Device-linux-$arch.AppImage" "$appimage.sig" "Harness-Device-linux-$arch.AppImage.sig")
    ;;
  windows)
    files=("$bundle/nsis/Harness Device_${version}_$bundle_arch-setup.exe" "Harness-Device-windows-$arch-setup.exe")
    ;;
esac
for ((i = 0; i < ${#files[@]}; i += 2)); do
  [[ -f "${files[i]}" ]] || die "the build wrote no $(basename "${files[i]}")"
done
# Moved, not copied: the macOS archive's name has no version, so a later build in the same target folder starts clean.
for ((i = 0; i < ${#files[@]}; i += 2)); do
  mv "${files[i]}" "$out/${files[i + 1]}"
done
