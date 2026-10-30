#!/usr/bin/env bash
# Publish the Windows pty payload that install.ps1 lays down in %USERPROFILE%\.harness\runtime\pty\<version>\.
# The payload is harness-pty.exe, harness-launch.exe, harness.exe (the `harness` command), the ConPTY pair
# (conpty.dll, OpenConsole.exe) and harness-serial.exe (serial/, the dial's serial port). This script
# publishes:
#   - one zip per architecture, files at its root, under <OBJECT_PREFIX>/pty/<version>/ (OBJECT_PREFIX is harness by
#     default; harness/staging keeps a staging build off the released paths). These are immutable, like every
#     versioned artifact here: the CDN keeps the first bytes it saw.
#   - the `pty` key of a manifest. That is STAGING by default (harness/staging/pty/metadata.json), which the
#     staging install.ps1 reads.
# A prerelease version (0.4.18-dev.win1) is published only with OBJECT_PREFIX and METADATA_PATH both under
# harness/staging/. Its manifest entry names the release core (0.4.18): that is the runtime\pty\<version>\ folder,
# and install.ps1 ($HarnessPtyVersionPattern) and ptyHost/launch.ts (VERSION_DIR) take only dotted numbers there, as
# windows-install-manifest.mjs does for a prerelease CLI.
# release.yml publishes a release here with OBJECT_PREFIX set to its staging prefix (harness/staging, or
# harness/staging-dry-run for a dry run), so a dry run never takes a real version's objects. The production manifest
# (harness/pty/metadata.json) is the owner's step, once the staging E2E passes: promote-pty-payload.sh <version> points
# it at those same objects and uploads nothing (its header gives the owner's whole production order). Running this
# script again for production would build zips of other bytes and be refused, as their names are taken.
# DRY_RUN=1 DRY_RUN_OUT=<dir> builds and checks the zips, writes them and the manifest into <dir>, and touches no bucket.
set -euo pipefail

VERSION="${1:-}"
X64_DIR="${2:-}"
ARM64_DIR="${3:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]] || [ -z "$X64_DIR" ] || [ -z "$ARM64_DIR" ]; then
  echo "usage: $0 <X.Y.Z[-prerelease]> <win32-x64 payload dir> <win32-arm64 payload dir>" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # cli/
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
CDN_ASSET_BASE_URL="${CDN_ASSET_BASE_URL:-https://cdn.autonomous.ai}"
METADATA_PATH="${METADATA_PATH:-harness/staging/pty/metadata.json}"
OBJECT_PREFIX="${OBJECT_PREFIX:-harness}"
DRY_RUN="${DRY_RUN:-0}"
if [ "$DRY_RUN" != 0 ] && [ "$DRY_RUN" != 1 ]; then
  echo "error: DRY_RUN must be 0 or 1, not '$DRY_RUN'; nothing was published." >&2
  exit 2
fi
# Only a pty manifest, production's or a staging prefix's: a typo must never rewrite the cli manifest every daemon polls.
[[ "$METADATA_PATH" =~ ^harness/(staging[a-z0-9-]*/)?pty/metadata\.json$ ]] || { echo "error: METADATA_PATH '$METADATA_PATH' is not a pty manifest (harness/pty/metadata.json, or one under a staging prefix)" >&2; exit 2; }
[[ "$OBJECT_PREFIX" =~ ^harness(/[a-z0-9_-]+)*$ ]] || { echo "error: OBJECT_PREFIX '$OBJECT_PREFIX' is not harness or a folder under it" >&2; exit 2; }
# The version folder install.ps1 lays the payload down in: the release core of a prerelease.
PTY_VERSION="${VERSION%%-*}"
if [ "$PTY_VERSION" != "$VERSION" ]; then
  if [[ ! "$OBJECT_PREFIX/" =~ ^harness/staging/ ]] || [[ ! "$METADATA_PATH" =~ ^harness/staging/ ]]; then
    echo "error: a prerelease ($VERSION) is published only under harness/staging/: set OBJECT_PREFIX and METADATA_PATH there; nothing was published." >&2
    exit 2
  fi
fi
# The payload, as install.ps1 ($HarnessPtyFiles) checks it.
FILES=(harness-pty.exe harness-launch.exe harness.exe conpty.dll OpenConsole.exe harness-serial.exe)

for command in node python3; do
  command -v "$command" >/dev/null 2>&1 || { echo "error: $command is required" >&2; exit 1; }
done
if [ "$DRY_RUN" != 1 ]; then
  command -v gcloud >/dev/null 2>&1 || { echo "error: gcloud not found; install and authenticate the gcloud SDK" >&2; exit 1; }
fi

source "$(dirname "${BASH_SOURCE[0]}")/lib/gcs.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
printf '{}' > "$WORK/entries.json"

PAIRS=("win32-x64=$X64_DIR" "win32-arm64=$ARM64_DIR")
UPLOADS=()
for pair in "${PAIRS[@]}"; do
  key="${pair%%=*}"
  dir="${pair#*=}"
  for file in "${FILES[@]}"; do
    [ -f "$dir/$file" ] || { echo "error: the $key payload in $dir has no $file" >&2; exit 1; }
  done
  zip="harness-pty-${VERSION}-${key}.zip"
  # Python's zipfile: the files at the zip's root, whatever OS this runs on (GNU tar cannot write zip).
  ( cd "$dir" && python3 -m zipfile -c "$WORK/$zip" "${FILES[@]}" )
  object="${OBJECT_PREFIX}/pty/${VERSION}/${zip}"
  url="${CDN_ASSET_BASE_URL%/}/${object}"
  sha="$(sha256_of "$WORK/$zip")"
  size="$(wc -c < "$WORK/$zip" | tr -d ' ')"
  UPLOADS+=("$zip|$object|$size")
  node "$ROOT/scripts/lib/runtimeManifest.mjs" entry "$WORK/entries.json" "$key" "$PTY_VERSION" "$url" "$sha" "$size"
done

if [ "$DRY_RUN" != 1 ]; then
  # Every check before any upload: a failure must not leave one immutable object published without the other.
  for item in "${UPLOADS[@]}"; do
    IFS='|' read -r zip object size <<< "$item"
    if exists "gs://${GCS_BUCKET}/${object}"; then
      echo "error: gs://${GCS_BUCKET}/${object} already exists. Versioned artifacts are immutable (the CDN keeps the first bytes); release a new version." >&2
      exit 1
    fi
  done
  # The existing manifest: start from {} only when it is confirmed absent; any other failure aborts.
  fetch_manifest "gs://${GCS_BUCKET}/${METADATA_PATH}" "$WORK/metadata.json" "$METADATA_PATH"
  for item in "${UPLOADS[@]}"; do
    IFS='|' read -r zip object size <<< "$item"
    echo ">> uploading $zip ($size bytes)"
    gcloud storage cp --cache-control='public, max-age=31536000, immutable' "$WORK/$zip" "gs://${GCS_BUCKET}/${object}"
  done
else
  printf '{}' > "$WORK/metadata.json"
fi
node "$ROOT/scripts/lib/runtimeManifest.mjs" platforms "$WORK/metadata.json" "$WORK/metadata.next.json" pty "$WORK/entries.json"

if [ "$DRY_RUN" = 1 ]; then
  out="${DRY_RUN_OUT:?DRY_RUN=1 needs DRY_RUN_OUT, a folder for the zips and the manifest}"
  mkdir -p "$out"
  cp "$WORK"/harness-pty-*.zip "$out/"
  cp "$WORK/metadata.next.json" "$out/metadata.json"
  echo ">> dry run: zips and manifest in $out"
  exit 0
fi
gcloud storage cp --content-type=application/json --cache-control='no-cache, no-store, must-revalidate' \
  "$WORK/metadata.next.json" "gs://${GCS_BUCKET}/${METADATA_PATH}"
echo ">> published the pty payload $VERSION to https://storage.googleapis.com/${GCS_BUCKET}/${METADATA_PATH}"
