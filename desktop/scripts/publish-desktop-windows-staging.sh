#!/usr/bin/env bash
# Publish the two install-shaped Windows desktop zips and harness-install.exe under a staging prefix only.
# DRY_RUN=1 writes proposed Windows entries and local copies without contacting GCS.
# Live publication reads one observed manifest generation and conditionally replaces it;
# a failed or partial publish burns this version and must be followed by a new one.
set -euo pipefail

VERSION="${1:-}"
X64_ZIP="${2:-}"
ARM64_ZIP="${3:-}"
INSTALLER="${4:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]] ||
  [ -z "$X64_ZIP" ] || [ -z "$ARM64_ZIP" ] || [ -z "$INSTALLER" ] || [ "$#" -ne 4 ]; then
  echo "usage: $0 <X.Y.Z[-prerelease]> <x64 zip> <arm64 zip> <harness-install.exe>" >&2
  exit 2
fi
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
CDN_ASSET_BASE_URL="${CDN_ASSET_BASE_URL:-https://cdn.autonomous.ai}"
STAGING_PREFIX="${STAGING_PREFIX:-harness/staging}"
DRY_RUN="${DRY_RUN:-0}"
if [ "$DRY_RUN" != 0 ] && [ "$DRY_RUN" != 1 ]; then
  echo "error: DRY_RUN must be 0 or 1, not '$DRY_RUN'; nothing was published." >&2
  exit 2
fi
if [[ ! "$STAGING_PREFIX" =~ ^harness/staging(/[a-z0-9_-]+)*$ ]]; then
  echo "error: STAGING_PREFIX '$STAGING_PREFIX' is not harness/staging or a folder under it; nothing was published." >&2
  exit 2
fi
if [[ ! "$GCS_BUCKET" =~ ^[a-z0-9][a-z0-9._-]*[a-z0-9]$ ]]; then
  echo "error: GCS_BUCKET must be a bucket name without a path; nothing was published." >&2
  exit 2
fi
if [ "$DRY_RUN" = 1 ] && [ -z "${DRY_RUN_OUT:-}" ]; then
  echo 'error: DRY_RUN=1 needs DRY_RUN_OUT, a local folder for proposed entries and files' >&2
  exit 2
fi
for tool in node python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is required" >&2; exit 1; }
done
if [ "$DRY_RUN" != 1 ]; then
  command -v gcloud >/dev/null 2>&1 || { echo 'error: gcloud is required for live staging publication' >&2; exit 1; }
fi
source "$REPO/cli/scripts/lib/gcs.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
printf '{}' > "$WORK/entries.json"
ARCHES=(x64 arm64)
ZIPS=("$X64_ZIP" "$ARM64_ZIP")
OBJECTS=()
SIZES=()
HASHES=()
UPLOADED=()
for i in 0 1; do
  arch="${ARCHES[$i]}"
  zip="${ZIPS[$i]}"
  name="harness-desktop-${VERSION}-windows-${arch}.zip"
  [ -f "$zip" ] || { echo "error: $zip is missing" >&2; exit 1; }
  [ "$(basename "$zip")" = "$name" ] || {
    echo "error: the $arch zip must be named $name, not $(basename "$zip")" >&2
    exit 1
  }
  python3 "$REPO/desktop/scripts/check-windows-zip.py" "$zip" "$VERSION"
  object="${STAGING_PREFIX}/desktop/${VERSION}/${name}"
  url="${CDN_ASSET_BASE_URL%/}/${object}"
  size="$(wc -c < "$zip" | tr -d ' ')"
  hash="$(sha256_of "$zip")"
  OBJECTS+=("$object")
  SIZES+=("$size")
  HASHES+=("$hash")
  node "$REPO/cli/scripts/lib/runtimeManifest.mjs" entry "$WORK/entries.json" "desktop-windows-${arch}" "$VERSION" "$url" "$hash" "$size"
done

# harness-install.exe: one x64 program for every PC, built for the staging manifest (installer spec §2.4).
[ -f "$INSTALLER" ] || { echo "error: $INSTALLER is missing" >&2; exit 1; }
[ "$(basename "$INSTALLER")" = harness-install.exe ] || {
  echo "error: the installer must be named harness-install.exe, not $(basename "$INSTALLER")" >&2
  exit 1
}
[ "$(head -c 2 "$INSTALLER")" = MZ ] || { echo "error: $INSTALLER is not a Windows program" >&2; exit 1; }
ARCHES+=(installer)
ZIPS+=("$INSTALLER")
OBJECTS+=("${STAGING_PREFIX}/desktop/${VERSION}/harness-install.exe")
SIZES+=("$(wc -c < "$INSTALLER" | tr -d ' ')")
HASHES+=("$(sha256_of "$INSTALLER")")
node "$REPO/cli/scripts/lib/runtimeManifest.mjs" entry "$WORK/entries.json" desktop-windows-installer "$VERSION" \
  "${CDN_ASSET_BASE_URL%/}/${OBJECTS[2]}" "${HASHES[2]}" "${SIZES[2]}"

if [ "$DRY_RUN" = 1 ]; then
  mkdir -p "$DRY_RUN_OUT"
  for zip in "${ZIPS[@]}"; do cp "$zip" "$DRY_RUN_OUT/"; done
  cp "$WORK/entries.json" "$DRY_RUN_OUT/metadata.json"
  echo ">> dry run: proposed Windows entries and the three files in $DRY_RUN_OUT; no bucket was read or written"
  exit 0
fi

for object in "${OBJECTS[@]}"; do
  uri="gs://${GCS_BUCKET}/${object}"
  if exists "$uri"; then
    echo "error: $uri already exists. Versioned artifacts are immutable; publish a new version." >&2
    exit 1
  fi
done

METADATA_PATH="${STAGING_PREFIX}/desktop/metadata.json"
METADATA_URI="gs://${GCS_BUCKET}/${METADATA_PATH}"
if exists "$METADATA_URI"; then
  generation="$(gcloud storage objects describe "$METADATA_URI" --format='value(generation)')" || {
    echo "error: could not observe the generation of $METADATA_URI; nothing was uploaded" >&2
    exit 1
  }
  [[ "$generation" =~ ^[1-9][0-9]*$ ]] || {
    echo "error: invalid generation for $METADATA_URI; nothing was uploaded" >&2
    exit 1
  }
  gcloud storage cp "${METADATA_URI}#${generation}" "$WORK/metadata.json" >/dev/null || {
    echo "error: could not fetch observed metadata generation $generation; nothing was uploaded" >&2
    exit 1
  }
else
  generation=0
  printf '{}' > "$WORK/metadata.json"
fi

node --input-type=module - "$REPO/cli/scripts/lib/runtimeManifest.mjs" "$WORK/metadata.json" "$WORK/entries.json" "$WORK/metadata.next.json" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const [lib, src, entries, dst] = process.argv.slice(2)
const { readDocument, mergeKey } = await import(pathToFileURL(lib).href)
let document = readDocument(src)
for (const [key, value] of Object.entries(JSON.parse(readFileSync(entries, 'utf8')))) {
  document = mergeKey(document, key, value)
}
writeFileSync(dst, JSON.stringify(document, null, 2) + '\n')
JS

for i in 0 1 2; do
  arch="${ARCHES[$i]}"
  uri="gs://${GCS_BUCKET}/${OBJECTS[$i]}"
  echo ">> uploading $arch (${SIZES[$i]} bytes) to $uri"
  if ! gcloud storage cp --if-generation-match=0 --cache-control='public, max-age=31536000, immutable' "${ZIPS[$i]}" "$uri"; then
    echo "error: $arch upload failed; attempted $arch object outcome is unknown. Confirmed prior uploads: ${UPLOADED[*]:-none}. Inspect staging and publish a new version; no metadata was written." >&2
    exit 1
  fi
  UPLOADED+=("$arch")
  if ! gcloud storage cp "$uri" "$WORK/verify-$arch" >/dev/null; then
    echo "error: cannot read back $arch; ${UPLOADED[*]} uploaded. Inspect staging and publish a new version; no metadata was written." >&2
    exit 1
  fi
  served_size="$(wc -c < "$WORK/verify-$arch" | tr -d ' ')"
  served_hash="$(sha256_of "$WORK/verify-$arch")"
  if [ "$served_size" != "${SIZES[$i]}" ] || [ "$served_hash" != "${HASHES[$i]}" ]; then
    echo "error: $arch served bytes differ; ${UPLOADED[*]} uploaded. Inspect staging and publish a new version; no metadata was written." >&2
    exit 1
  fi
done

if ! gcloud storage cp --if-generation-match="$generation" --content-type=application/json \
    --cache-control='no-cache, no-store, must-revalidate' "$WORK/metadata.next.json" "$METADATA_URI"; then
  echo "error: metadata changed or write result is unknown; all three files uploaded. Inspect staging and publish a new version." >&2
  exit 1
fi
echo ">> published Windows desktop $VERSION to https://storage.googleapis.com/${GCS_BUCKET}/${METADATA_PATH}"
