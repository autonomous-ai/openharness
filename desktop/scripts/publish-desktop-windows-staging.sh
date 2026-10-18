#!/usr/bin/env bash
# Publish the two install-shaped Windows desktop zips under a staging prefix only.
# DRY_RUN=1 writes proposed Windows entries and local zip copies without contacting GCS.
# Live publication reads one observed manifest generation and conditionally replaces it;
# a failed or partial publish burns this version and must be followed by a new one.
set -euo pipefail

VERSION="${1:-}"
X64_ZIP="${2:-}"
ARM64_ZIP="${3:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]] ||
  [ -z "$X64_ZIP" ] || [ -z "$ARM64_ZIP" ] || [ "$#" -ne 3 ]; then
  echo "usage: $0 <X.Y.Z[-prerelease]> <x64 zip> <arm64 zip>" >&2
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
  echo 'error: DRY_RUN=1 needs DRY_RUN_OUT, a local folder for proposed entries and zips' >&2
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
  python3 - "$zip" "$VERSION" <<'PY'
import stat
import sys
import zipfile

path, version = sys.argv[1:3]
try:
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len({name.casefold() for name in names}):
            sys.exit(f"error: {path} has duplicate entries")
        for info in infos:
            name = info.filename
            parts = name.rstrip("/").split("/")
            if (not name or name.startswith("/") or "\\" in name or
                    any(part in ("", ".", "..") or any(c in part for c in '<>:"|?*') for part in parts)):
                sys.exit(f"error: {path} has an unsafe entry {name!r}")
            if parts[0] not in ("Harness.exe", "Harness.ico", "current", "app") or (
                    parts[0] != "app" and (len(parts) != 1 or info.is_dir())) or (
                    parts[0] == "app" and len(parts) == 1 and not info.is_dir()) or (
                    parts[0] == "app" and len(parts) > 1 and parts[1] != version) or (
                    parts[:2] == ["app", version] and len(parts) == 2 and not info.is_dir()):
                sys.exit(f"error: {path} has an unexpected entry {name!r}")
            if any(part.lower() == ".started" for part in parts):
                sys.exit(f"error: {path} contains an inherited .started marker")
            kind = stat.S_IFMT(info.external_attr >> 16)
            if kind not in ((0, stat.S_IFDIR) if info.is_dir() else (0, stat.S_IFREG)):
                sys.exit(f"error: {path} contains a non-file entry {name!r}")
        required = ("Harness.exe", "Harness.ico", "current",
                    f"app/{version}/harness-desktop.exe", f"app/{version}/harness_pipe_io.dll")
        for name in required:
            if name not in names or archive.getinfo(name).is_dir() or archive.getinfo(name).file_size == 0:
                sys.exit(f"error: {path} has no {name}")
        current = archive.read("current").decode("utf-8-sig")
        if current not in (version, version + "\n", version + "\r\n"):
            sys.exit(f"error: {path} says current is '{current.strip()}', not {version}")
        bad = archive.testzip()
        if bad is not None:
            sys.exit(f"error: {path} has a corrupt entry {bad}")
except (OSError, ValueError, UnicodeError, RuntimeError, zipfile.BadZipFile) as error:
    sys.exit(f"error: {path} is not a valid install zip: {error}")
PY
  object="${STAGING_PREFIX}/desktop/${VERSION}/${name}"
  url="${CDN_ASSET_BASE_URL%/}/${object}"
  size="$(wc -c < "$zip" | tr -d ' ')"
  hash="$(sha256_of "$zip")"
  OBJECTS+=("$object")
  SIZES+=("$size")
  HASHES+=("$hash")
  node "$REPO/cli/scripts/lib/runtimeManifest.mjs" entry "$WORK/entries.json" "desktop-windows-${arch}" "$VERSION" "$url" "$hash" "$size"
done

if [ "$DRY_RUN" = 1 ]; then
  mkdir -p "$DRY_RUN_OUT"
  for zip in "${ZIPS[@]}"; do cp "$zip" "$DRY_RUN_OUT/"; done
  cp "$WORK/entries.json" "$DRY_RUN_OUT/metadata.json"
  echo ">> dry run: proposed Windows entries and both zips in $DRY_RUN_OUT; no bucket was read or written"
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

for i in 0 1; do
  arch="${ARCHES[$i]}"
  uri="gs://${GCS_BUCKET}/${OBJECTS[$i]}"
  echo ">> uploading $arch zip (${SIZES[$i]} bytes) to $uri"
  if ! gcloud storage cp --if-generation-match=0 --cache-control='public, max-age=31536000, immutable' "${ZIPS[$i]}" "$uri"; then
    echo "error: $arch upload failed; ${UPLOADED[*]:-no zip} uploaded by this attempt. Inspect staging and publish a new version; no metadata was written." >&2
    exit 1
  fi
  UPLOADED+=("$arch")
  if ! gcloud storage cp "$uri" "$WORK/verify-$arch.zip" >/dev/null; then
    echo "error: cannot read back $arch; ${UPLOADED[*]} uploaded. Inspect staging and publish a new version; no metadata was written." >&2
    exit 1
  fi
  served_size="$(wc -c < "$WORK/verify-$arch.zip" | tr -d ' ')"
  served_hash="$(sha256_of "$WORK/verify-$arch.zip")"
  if [ "$served_size" != "${SIZES[$i]}" ] || [ "$served_hash" != "${HASHES[$i]}" ]; then
    echo "error: $arch served bytes differ; ${UPLOADED[*]} uploaded. Inspect staging and publish a new version; no metadata was written." >&2
    exit 1
  fi
done

if ! gcloud storage cp --if-generation-match="$generation" --content-type=application/json \
    --cache-control='no-cache, no-store, must-revalidate' "$WORK/metadata.next.json" "$METADATA_URI"; then
  echo "error: metadata changed or write result is unknown; both zips uploaded. Inspect staging and publish a new version." >&2
  exit 1
fi
echo ">> published Windows desktop $VERSION to https://storage.googleapis.com/${GCS_BUCKET}/${METADATA_PATH}"
