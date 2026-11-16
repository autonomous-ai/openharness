#!/usr/bin/env bash
# Builds one universal Harness Device release into an empty OUT_DIR under the fixed names the manifest and the website
# use. CONFIG_JSON, when given, is merged last (a test build's updater keys and endpoint).
#
# Signing and notarization come from the environment, as Tauri reads it: APPLE_SIGNING_IDENTITY, APPLE_ID,
# APPLE_PASSWORD, APPLE_TEAM_ID, TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD. This script names none
# of their values.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="$(dirname "$here")"

die() {
  echo "release-build: $*" >&2
  exit 1
}

[[ $# -eq 2 || $# -eq 3 ]] || die "usage: release-build.sh VERSION OUT_DIR [CONFIG_JSON]"
version="$1"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die "the version is not X.Y.Z"
[[ "$(uname -s)" == Darwin ]] || die "builds on a Mac only"

mkdir -p "$2"
out="$(cd "$2" && pwd)"
# An earlier build's files must never be taken for this one's.
[[ -z "$(ls -A "$out")" ]] || die "OUT_DIR is not empty"

# Later --config values win, so the caller's CONFIG_JSON overrides the release's own.
configs=(--config "{\"version\":\"$version\",\"bundle\":{\"createUpdaterArtifacts\":true}}")
if [[ $# -eq 3 ]]; then
  configs+=(--config "$3")
fi

cd "$app/src-tauri"
# --locked reaches cargo build: a Cargo.lock that does not match Cargo.toml is refused, never rewritten.
cargo tauri build --ci --target universal-apple-darwin --bundles app,dmg "${configs[@]}" -- --locked

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
