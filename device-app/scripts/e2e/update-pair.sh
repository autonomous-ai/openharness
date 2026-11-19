#!/usr/bin/env bash
# Builds two test releases of Harness Device for this machine, 0.0.1 and 0.0.2, the way a release builds them
# (release-build.sh, then release-check.sh), and the manifest that offers 0.0.2 from 127.0.0.1:8765: what each end to
# end driver's update check serves (macos.sh --update, linux.sh --update, windows.ps1 -Update).
#
#   bash device-app/scripts/e2e/update-pair.sh OUT
#
# OUT, new or empty, gets 0.0.1/ and 0.0.2/ (release-build.sh's files) and metadata.json. Both builds trust only a key
# pair made for this run, whose private half goes with it, and ask only 127.0.0.1: never the production key, bucket or
# CDN. On Windows DEVICE_TARGET names the arch, as release-build.sh needs it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(dirname "$here")"
BASE_URL=http://127.0.0.1:8765

die() {
  echo "update-pair: $*" >&2
  exit 1
}

[[ $# -eq 1 ]] || die "usage: update-pair.sh OUT"
mkdir -p "$1"
out="$(cd "$1" && pwd)"
[[ -z "$(ls -A "$out")" ]] || die "OUT is not empty"
command -v minisign >/dev/null || die "release-check.sh verifies the update signatures with minisign, which is not on PATH"

# The update file this OS's updater downloads, and the manifest's keys for it.
case "$(uname -s)" in
  # Universal: both Macs' keys name the one archive, as a release's manifest does.
  Darwin) os=macos file=Harness-Device.app.tar.gz keys=(darwin-aarch64 darwin-x86_64) ;;
  Linux)
    case "$(uname -m)" in
      x86_64) file=Harness-Device-linux-x64.AppImage keys=(linux-x86_64) ;;
      aarch64) file=Harness-Device-linux-arm64.AppImage keys=(linux-aarch64) ;;
      *) die "builds Linux on x86_64 or aarch64 only" ;;
    esac
    os=linux
    ;;
  MINGW* | MSYS* | CYGWIN*)
    case "${DEVICE_TARGET:-}" in
      x86_64-pc-windows-msvc) file=Harness-Device-windows-x64-setup.exe keys=(windows-x86_64) ;;
      aarch64-pc-windows-msvc) file=Harness-Device-windows-arm64-setup.exe keys=(windows-aarch64) ;;
      *) die "DEVICE_TARGET must name x86_64-pc-windows-msvc or aarch64-pc-windows-msvc" ;;
    esac
    os=windows
    ;;
  *) die "builds on macOS, Linux or Windows only" ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# With no password: the key lives as long as this run.
cargo tauri signer generate --ci -w "$work/update.key" >/dev/null
pubkey="$(cat "$work/update.key.pub")"
signing=(env TAURI_SIGNING_PRIVATE_KEY="$(cat "$work/update.key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=)

# The release's own configuration, but for the key and the endpoint, and plain http to reach 127.0.0.1.
updater="{\"pubkey\":\"$pubkey\",\"endpoints\":[\"$BASE_URL/metadata.json\"],\"dangerousInsecureTransportProtocol\":true}"
config="{\"plugins\":{\"updater\":$updater}"
if [[ "$os" == macos ]]; then
  # Signed ad hoc, as no Apple identity is here: the update replaces a signed bundle, as a release's does. Its own
  # bundle id keeps everything macOS files under one (LaunchServices, login items, WebKit's data, saved windows) apart
  # from an installed Harness Device's.
  config+=",\"identifier\":\"ai.autonomous.harness.device.e2e\",\"bundle\":{\"macOS\":{\"signingIdentity\":\"-\"}}"
  # The dmg is made without the AppleScript that lays out its Finder window, which would drive a person's Finder.
  export CI=true
fi
config+="}"

for version in 0.0.1 0.0.2; do
  bash "$scripts/release-build.sh" compile "$version" "$config"
  if [[ "$os" == windows ]]; then
    bash "$scripts/release-build.sh" bundle "$version" "$out/$version" "$config"
    "${signing[@]}" bash "$scripts/release-build.sh" sign-update "$version" "$out/$version"
  else
    "${signing[@]}" bash "$scripts/release-build.sh" bundle "$version" "$out/$version" "$config"
  fi
  bash "$scripts/release-check.sh" "$out/$version" "$version" "$pubkey"
done

# Tauri's static manifest, as a release publishes it, for this machine's platform only.
signature="$(cat "$out/0.0.2/$file.sig")"
entries=()
for key in "${keys[@]}"; do
  entries+=("\"$key\":{\"url\":\"$BASE_URL/0.0.2/$file\",\"signature\":\"$signature\"}")
done
(
  IFS=,
  printf '{"version":"0.0.2","platforms":{%s}}\n' "${entries[*]}"
) >"$out/metadata.json"
echo "update-pair: $out holds 0.0.1, 0.0.2 and metadata.json"
