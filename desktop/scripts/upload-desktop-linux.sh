#!/usr/bin/env bash
# Upload one desktop release's Linux AppImages and write their two scratch manifests, which release-desktop.yml's
# publish job merges with the other platforms'. It holds the bucket write and no signing key: package-desktop-linux.sh
# built the files with neither, and sign-desktop-linux.sh signed them with the key and no bucket write.
#
# Usage: bash desktop/scripts/upload-desktop-linux.sh <X.Y.Z> <folder>
#   <folder> holds, for x64 and arm64, Harness-linux-<arch>.AppImage, its .sha256 (sha256sum form) and its .sig.
# Environment, from release-desktop.yml's version job: ARTIFACT_PREFIX (harness/desktop/<version>, a candidate's
# prefix, or the disposable promotion check's), SCRATCH_PREFIX (harness/desktop/.ci/<run>-<attempt>),
# CDN_ASSET_BASE_URL and GCS_BUCKET.
set -euo pipefail
set +x

VERSION="${1:-}"
DIR="${2:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [ -z "$DIR" ] || [ "$#" -ne 2 ]; then
  echo "usage: $0 <X.Y.Z> <folder with Harness-linux-<x64|arm64>.AppImage, .sha256 and .sig>" >&2
  exit 2
fi
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

# gcs_cp <src> <dst> [cache-control] [content-type] [generation-match].
gcs_cp() {
  local src="$1" dst="$2" cc="${3:-}" ct="${4:-}" generation="${5:-}" args=(storage cp)
  if [ -n "$cc" ]; then args+=("--cache-control=$cc"); fi
  if [ -n "$ct" ]; then args+=("--content-type=$ct"); fi
  if [ -n "$generation" ]; then args+=("--if-generation-match=$generation"); fi
  gcloud "${args[@]}" "$src" "$dst"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Every file is checked, and both parts written, before the first upload, so a bad file uploads nothing.
python3 - "$WORK" "$VERSION" "${CDN_ASSET_BASE_URL%/}/${ARTIFACT_PREFIX}" "$DIR" <<'PY'
import base64
import hashlib
import json
import pathlib
import re
import sys

work, version, base, folder = sys.argv[1:5]


def refuse(message):
    sys.exit(f"error: {message}; nothing was uploaded.")


for arch in ("x64", "arm64"):
    name = f"Harness-linux-{arch}.AppImage"
    path = pathlib.Path(folder) / name
    if not path.is_file():
        refuse(f"{path} is missing")
    with path.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    sums = pathlib.Path(folder) / f"{name}.sha256"
    # The whole line, file name included: sums that hold for the other arch's file must not pass for this one.
    if not sums.is_file() or sums.read_bytes() != f"{digest}  {name}\n".encode():
        refuse(f"{name} does not match its sums")
    try:
        text = (pathlib.Path(folder) / f"{name}.sig").read_text()
        if not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}\n?", text):
            raise ValueError
        base64.b64decode(text.strip(), validate=True)
    except (OSError, ValueError):
        refuse(f"{name}.sig is not one line of base64")
    part = {f"desktop-linux-{arch}": dict(version=version, url=f"{base}/{name}", sha256=digest,
                                          size=path.stat().st_size, signature=text.strip())}
    (pathlib.Path(work) / f"linux-{arch}.json").write_text(json.dumps(part, indent=2) + "\n")
PY

for arch in x64 arm64; do
  OUTPUT="$DIR/Harness-linux-$arch.AppImage"
  GCS_PATH="$ARTIFACT_PREFIX/Harness-linux-$arch.AppImage"
  echo ">> uploading Harness-linux-$arch.AppImage ($(wc -c < "$OUTPUT" | tr -d ' ') bytes) to gs://${GCS_BUCKET}/${GCS_PATH}"
  # Create-only: a versioned file is immutable, because the CDN keeps the first bytes it served for a path (measured on
  # 1.1.56, 2026-09-18: one path, two zips, self-update broken). A re-run fails here instead of replacing them.
  gcs_cp "$OUTPUT" "gs://${GCS_BUCKET}/${GCS_PATH}" "public, max-age=31536000, immutable" "" 0
done
for part in linux-x64.json linux-arm64.json; do
  gcs_cp "$WORK/$part" "gs://${GCS_BUCKET}/${SCRATCH_PREFIX}/$part" "no-cache, no-store, must-revalidate" "application/json" 0
done
echo ">> Linux desktop $VERSION uploaded to gs://${GCS_BUCKET}/${ARTIFACT_PREFIX}/ and its parts to ${SCRATCH_PREFIX}/"
