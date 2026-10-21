#!/usr/bin/env bash
# Upload one desktop release's Windows files and write their two scratch manifests, which release-desktop.yml's
# publish job merges with the other platforms' (docs/superpowers/specs/2026-10-19-windows-installer-design.md §2.2).
# It runs on ubuntu, so the Windows build runners never need gcloud.
#
# Usage: bash desktop/scripts/upload-desktop-windows.sh <X.Y.Z> <folder>
#   <folder> holds Harness-windows-x64.zip, Harness-windows-arm64.zip and harness-install.exe.
# Environment, from release-desktop.yml's version job: ARTIFACT_PREFIX (harness/desktop/<version>, a candidate's
# prefix, or the disposable promotion check's), SCRATCH_PREFIX (harness/desktop/.ci/<run>-<attempt>),
# CDN_ASSET_BASE_URL and GCS_BUCKET.
set -euo pipefail
set +x

VERSION="${1:-}"
DIR="${2:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [ -z "$DIR" ] || [ "$#" -ne 2 ]; then
  echo "usage: $0 <X.Y.Z> <folder with Harness-windows-x64.zip, Harness-windows-arm64.zip and harness-install.exe>" >&2
  exit 2
fi
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
CDN_ASSET_BASE_URL="${CDN_ASSET_BASE_URL:-https://cdn.autonomous.ai}"
ARTIFACT_PREFIX="${ARTIFACT_PREFIX:-harness/desktop/$VERSION}"
SCRATCH_PREFIX="${SCRATCH_PREFIX:-}"
if [[ ! "$GCS_BUCKET" =~ ^[a-z0-9][a-z0-9._-]*[a-z0-9]$ ]]; then
  echo "error: GCS_BUCKET must be a bucket name without a path; nothing was uploaded." >&2
  exit 2
fi
# The three destinations the version job makes, and nothing else: a release, a candidate, a promotion check.
if [[ ! "$ARTIFACT_PREFIX" =~ ^(harness/desktop/${VERSION//./\\.}|harness/desktop-candidates/[1-9][0-9]*-[1-9][0-9]*-[0-9a-f]{32}|harness/desktop/\.candidate-check/[1-9][0-9]*-[1-9][0-9]*/artifacts)$ ]]; then
  echo "error: ARTIFACT_PREFIX '$ARTIFACT_PREFIX' is not this release's, a candidate's or a promotion check's; nothing was uploaded." >&2
  exit 2
fi
if [[ ! "$SCRATCH_PREFIX" =~ ^harness/desktop/\.ci/[1-9][0-9]*-[1-9][0-9]*$ ]]; then
  echo "error: SCRATCH_PREFIX '$SCRATCH_PREFIX' is not harness/desktop/.ci/<run>-<attempt>; nothing was uploaded." >&2
  exit 2
fi
for tool in gcloud python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is required" >&2; exit 1; }
done

NAMES=(Harness-windows-x64.zip Harness-windows-arm64.zip harness-install.exe)
for name in "${NAMES[@]}"; do
  [ -f "$DIR/$name" ] || { echo "error: $DIR/$name is missing; nothing was uploaded." >&2; exit 1; }
done
python3 "$REPO/desktop/scripts/check-windows-zip.py" "$DIR/Harness-windows-x64.zip" "$VERSION"
python3 "$REPO/desktop/scripts/check-windows-zip.py" "$DIR/Harness-windows-arm64.zip" "$VERSION"
[ "$(head -c 2 "$DIR/harness-install.exe")" = MZ ] || {
  echo "error: $DIR/harness-install.exe is not a Windows program; nothing was uploaded." >&2
  exit 1
}

# gcs_cp <src> <dst> [cache-control] [content-type] [generation-match], as upload-desktop-linux.sh has it.
gcs_cp() {
  local src="$1" dst="$2" cc="${3:-}" ct="${4:-}" generation="${5:-}" args=(storage cp)
  if [ -n "$cc" ]; then args+=("--cache-control=$cc"); fi
  if [ -n "$ct" ]; then args+=("--content-type=$ct"); fi
  if [ -n "$generation" ]; then args+=("--if-generation-match=$generation"); fi
  gcloud "${args[@]}" "$src" "$dst"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
python3 - "$WORK" "$VERSION" "${CDN_ASSET_BASE_URL%/}/${ARTIFACT_PREFIX}" "$DIR" <<'PY'
import hashlib
import json
import pathlib
import sys

work, version, base, folder = sys.argv[1:5]


def entry(name):
    data = (pathlib.Path(folder) / name).read_bytes()
    return dict(version=version, url=f"{base}/{name}", sha256=hashlib.sha256(data).hexdigest(), size=len(data))


# publish-desktop-manifest.py's PARTS: the installer comes from the x64 job, one x64 program for every PC.
parts = {
    "windows-x64.json": {"desktop-windows-x64": entry("Harness-windows-x64.zip"),
                         "desktop-windows-installer": entry("harness-install.exe")},
    "windows-arm64.json": {"desktop-windows-arm64": entry("Harness-windows-arm64.zip")},
}
for name, part in parts.items():
    (pathlib.Path(work) / name).write_text(json.dumps(part, indent=2) + "\n")
PY

for name in "${NAMES[@]}"; do
  FILE="$DIR/$name"
  GCS_PATH="$ARTIFACT_PREFIX/$name"
  echo ">> uploading $name ($(wc -c < "$FILE" | tr -d ' ') bytes) to gs://${GCS_BUCKET}/${GCS_PATH}"
  # Create-only: a versioned file is immutable, because the CDN keeps the first bytes it served for a path
  # (upload-desktop-linux.sh, gcs_refuse_republish). A re-run fails here instead of replacing them.
  gcs_cp "$FILE" "gs://${GCS_BUCKET}/${GCS_PATH}" "public, max-age=31536000, immutable" "" 0
done
for part in windows-x64.json windows-arm64.json; do
  gcs_cp "$WORK/$part" "gs://${GCS_BUCKET}/${SCRATCH_PREFIX}/$part" "no-cache, no-store, must-revalidate" "application/json" 0
done
echo ">> Windows desktop $VERSION uploaded to gs://${GCS_BUCKET}/${ARTIFACT_PREFIX}/ and its parts to ${SCRATCH_PREFIX}/"
