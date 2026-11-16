#!/usr/bin/env bash
# Builds one universal Harness Device release in two steps, so the build's third-party code (crates' build scripts,
# npm packages) runs before any signing secret is in the environment:
#
# - `release-build.sh compile VERSION [CONFIG_JSON]` compiles the app, and refuses a signing secret in its environment.
# - `release-build.sh bundle VERSION OUT_DIR [CONFIG_JSON]` bundles, signs and notarizes what compile built into an
#   empty OUT_DIR, under the fixed names the manifest and the website use.
#
# Both steps take the same VERSION and CONFIG_JSON: the binary embeds the configuration the bundle describes.
# CONFIG_JSON, when given, is merged last (a test build's updater keys and endpoint).
#
# The bundle's signing and notarization come from the environment, as Tauri reads it: the `secrets` below. This script
# names none of their values.
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
  compile:2 | compile:3 | bundle:3 | bundle:4) ;;
  *) die "usage: release-build.sh compile VERSION [CONFIG_JSON], then release-build.sh bundle VERSION OUT_DIR [CONFIG_JSON]" ;;
esac
version="$2"
shift 2
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "the version is not X.Y.Z"
[[ "$(uname -s)" == Darwin ]] || die "builds on a Mac only"

if [[ "$step" == bundle ]]; then
  mkdir -p "$1"
  out="$(cd "$1" && pwd)"
  shift
  # An earlier build's files must never be taken for this one's.
  [[ -z "$(ls -A "$out")" ]] || die "OUT_DIR is not empty"
fi

# Later --config values win, so the caller's CONFIG_JSON overrides the release's own.
configs=(--config "{\"version\":\"$version\",\"bundle\":{\"createUpdaterArtifacts\":true}}")
if [[ $# -eq 1 ]]; then
  configs+=(--config "$1")
fi

cd "$app/src-tauri"

if [[ "$step" == compile ]]; then
  for name in "${secrets[@]}"; do
    [[ -z "${!name+set}" ]] || die "compile runs with no $name in its environment"
  done
  # --locked reaches cargo build: a Cargo.lock that does not match Cargo.toml is refused, never rewritten.
  exec cargo tauri build --ci --no-bundle --target universal-apple-darwin "${configs[@]}" -- --locked
fi

cargo tauri bundle --ci --target universal-apple-darwin --bundles app,dmg "${configs[@]}"

# CARGO_TARGET_DIR may put the target folder anywhere; cargo names it.
target="$(cargo metadata --format-version 1 --no-deps | python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')"
bundle="$target/universal-apple-darwin/release/bundle"
dmg="$bundle/dmg/Harness Device_${version}_universal.dmg"
archive="$bundle/macos/Harness Device.app.tar.gz"
for file in "$dmg" "$archive" "$archive.sig"; do
  [[ -f "$file" ]] || die "the build wrote no $(basename "$file")"
done
# Moved, not copied: the archive's name has no version, so a later build in the same target folder starts clean.
mv "$dmg" "$out/Harness-Device.dmg"
mv "$archive" "$out/Harness-Device.app.tar.gz"
mv "$archive.sig" "$out/Harness-Device.app.tar.gz.sig"
