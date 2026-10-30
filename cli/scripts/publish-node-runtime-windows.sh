#!/usr/bin/env bash
# Republish nodejs.org's Windows Node (node-v<version>-win-<arch>.zip) under the managed-runtime manifest's
# win32-x64 and win32-arm64 keys. install.ps1 and the CLI's ensureManagedRuntime read those keys. The macOS and
# Linux half is desktop/scripts/publish-managed-node-runtime.sh.
#
# This script also checks the signature on SHASUMS256.txt, using the Node release keyring pinned below by commit
# and digest. A tampered checksum list therefore cannot vouch for a tampered zip.
#
# It publishes to STAGING by default (harness/staging/runtime/metadata.json). Production is
# harness/runtime/metadata.json, which every installer and daemon reads, and publishing there is the owner's step:
#   METADATA_PATH=harness/runtime/metadata.json bash cli/scripts/publish-node-runtime-windows.sh 22.23.2
# The merge keeps every other key, the Mac's included.
# DRY_RUN=1 DRY_RUN_OUT=<dir> downloads and verifies, writes the manifest into <dir>, and touches no bucket.
set -euo pipefail
set +x

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <Node version, e.g. 22.23.2>" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # cli/
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
PUBLIC_BASE="${GCS_PUBLIC_BASE_URL:-https://storage.googleapis.com/${GCS_BUCKET}}"
METADATA_PATH="${METADATA_PATH:-harness/staging/runtime/metadata.json}"
NODE_DIST_BASE="${NODE_DIST_BASE:-https://nodejs.org/dist}"
# The pinned keyring is nodejs/release-keys at 481637f8 (2026-09-01): the active release keys as a gpg keyring.
# Moving the pin is a reviewed change, and both lines move together.
KEYRING_URL="${NODE_RELEASE_KEYRING_URL:-https://raw.githubusercontent.com/nodejs/release-keys/481637f813e912c4aa3622d7964ab426c97b8e8d/gpg-only-active-keys/pubring.kbx}"
KEYRING_SHA256="${NODE_RELEASE_KEYRING_SHA256:-140f2ad5260fd62773b6243ce8e1d3009645d558f121b8262c55e383dc285932}"
DRY_RUN="${DRY_RUN:-0}"
if [ "$DRY_RUN" != 0 ] && [ "$DRY_RUN" != 1 ]; then
  echo "error: DRY_RUN must be 0 or 1, not '$DRY_RUN'; nothing was published." >&2
  exit 2
fi
# Only a runtime manifest, production's or a staging prefix's: a typo must never rewrite the cli manifest every daemon polls.
[[ "$METADATA_PATH" =~ ^harness/(staging[a-z0-9-]*/)?runtime/metadata\.json$ ]] || { echo "error: METADATA_PATH '$METADATA_PATH' is not a runtime manifest (harness/runtime/metadata.json, or one under a staging prefix)" >&2; exit 2; }

for command in curl gpgv node; do
  command -v "$command" >/dev/null 2>&1 || { echo "error: $command is required" >&2; exit 1; }
done
if [ "$DRY_RUN" != 1 ]; then
  command -v gcloud >/dev/null 2>&1 || { echo "error: gcloud not found; install and authenticate the gcloud SDK" >&2; exit 1; }
fi

source "$(dirname "${BASH_SOURCE[0]}")/lib/gcs.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fsSL "$KEYRING_URL" -o "$WORK/pubring.kbx"
[ "$(sha256_of "$WORK/pubring.kbx")" = "$KEYRING_SHA256" ] || {
  echo "error: the Node release keyring at $KEYRING_URL does not match its pinned sha256" >&2
  exit 1
}
base="${NODE_DIST_BASE%/}/v${VERSION}"
curl -fsSL "$base/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
curl -fsSL "$base/SHASUMS256.txt.sig" -o "$WORK/SHASUMS256.txt.sig"
if ! gpgv --keyring "$WORK/pubring.kbx" "$WORK/SHASUMS256.txt.sig" "$WORK/SHASUMS256.txt" 2>"$WORK/gpgv.log"; then
  cat "$WORK/gpgv.log" >&2
  echo "error: SHASUMS256.txt for Node v$VERSION does not carry a valid signature from a Node release key" >&2
  exit 1
fi

printf '{}' > "$WORK/entries.json"
UPLOADS=()
for arch in x64 arm64; do
  archive="node-v${VERSION}-win-${arch}.zip"
  curl -fsSL "$base/$archive" -o "$WORK/$archive"
  expected="$(awk -v name="$archive" '$2 == name { print $1 }' "$WORK/SHASUMS256.txt")"
  actual="$(sha256_of "$WORK/$archive")"
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { echo "error: the signed SHASUMS256.txt has no checksum for $archive" >&2; exit 1; }
  [ "$actual" = "$expected" ] || { echo "error: $archive does not match the signed SHASUMS256.txt" >&2; exit 1; }
  object="harness/runtime/node/v${VERSION}/${archive}"
  url="${PUBLIC_BASE%/}/${object}"
  size="$(wc -c < "$WORK/$archive" | tr -d ' ')"
  UPLOADS+=("$archive|$object|$actual|$size")
  node "$ROOT/scripts/lib/runtimeManifest.mjs" entry "$WORK/entries.json" "win32-$arch" "v$VERSION" "$url" "$actual" "$size" "node-v${VERSION}-win-${arch}"
done

if [ "$DRY_RUN" = 1 ]; then
  printf '{}' > "$WORK/metadata.json"
else
  # Every check before any upload, so a failed lookup never leaves one zip published without the other.
  # An object that is already there is fine only with these same bytes; different bytes never replace it.
  TO_UPLOAD=()
  for item in "${UPLOADS[@]}"; do
    IFS='|' read -r archive object actual size <<< "$item"
    if exists "gs://${GCS_BUCKET}/${object}"; then
      gcloud storage cp "gs://${GCS_BUCKET}/${object}" "$WORK/published.zip" >/dev/null
      [ "$(sha256_of "$WORK/published.zip")" = "$actual" ] || {
        echo "error: gs://${GCS_BUCKET}/${object} exists with other bytes; versioned objects are immutable" >&2
        exit 1
      }
      echo ">> $archive is already published with these bytes"
    else
      TO_UPLOAD+=("$item")
    fi
  done
  # The existing manifest: start from {} only when it is confirmed absent; any other failure aborts.
  fetch_manifest "gs://${GCS_BUCKET}/${METADATA_PATH}" "$WORK/metadata.json" "$METADATA_PATH"
  for item in ${TO_UPLOAD[@]+"${TO_UPLOAD[@]}"}; do
    IFS='|' read -r archive object actual size <<< "$item"
    echo ">> uploading $archive ($size bytes)"
    gcloud storage cp --cache-control='public, max-age=31536000, immutable' "$WORK/$archive" "gs://${GCS_BUCKET}/${object}"
  done
fi
node "$ROOT/scripts/lib/runtimeManifest.mjs" platforms "$WORK/metadata.json" "$WORK/metadata.next.json" node "$WORK/entries.json"

if [ "$DRY_RUN" = 1 ]; then
  out="${DRY_RUN_OUT:?DRY_RUN=1 needs DRY_RUN_OUT, a folder for the manifest}"
  mkdir -p "$out"
  cp "$WORK/metadata.next.json" "$out/metadata.json"
  echo ">> dry run: manifest in $out/metadata.json"
  exit 0
fi
gcloud storage cp --content-type=application/json --cache-control='no-cache, no-store, must-revalidate' \
  "$WORK/metadata.next.json" "gs://${GCS_BUCKET}/${METADATA_PATH}"
echo ">> published Node v${VERSION} for Windows to ${PUBLIC_BASE%/}/${METADATA_PATH}"
