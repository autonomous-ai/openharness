#!/usr/bin/env bash
# Publish the macOS and Linux Node archives consumed by Harness Desktop's
# first-run provisioner. The desktop app trusts the sha256 in this manifest,
# never a downloaded checksum file at install time.
#
# Publishes to the STAGING manifest (harness/staging/runtime/metadata.json) unless METADATA_PATH says otherwise;
# production is an explicit METADATA_PATH=harness/runtime/metadata.json, after the staging E2E passes.
# DRY_RUN=1 downloads and verifies, prints the object paths and touches no bucket.
#
# Usage: bash scripts/publish-managed-node-runtime.sh 24.22.2
set -euo pipefail
set +x

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <Node version, e.g. 24.22.2>" >&2
  exit 2
fi

DRY_RUN="${DRY_RUN:-0}"
if [ "$DRY_RUN" != 0 ] && [ "$DRY_RUN" != 1 ]; then
  echo "error: DRY_RUN must be 0 or 1, not '$DRY_RUN'; nothing was published." >&2
  exit 2
fi

for command in curl shasum python3; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "error: $command is required" >&2
    exit 1
  }
done

# --- GCS client: `gcloud storage`, and only `gcloud storage` ---
# gsutil was retired from this repo on 2026-09-17. It is a standalone Python tool that only
# understands gcloud's *user* and *service-account-key* credentials: it cannot use the
# external-account (federated) credential Workload Identity Federation issues, so every call fails
# under WIF while the identical `gcloud storage` call works — it is the same gcloud binary that
# performed the token exchange. Do not reintroduce it.
if [ "$DRY_RUN" != 1 ]; then
  command -v gcloud >/dev/null 2>&1 || { echo "error: gcloud not found — install/authenticate the gcloud SDK" >&2; exit 1; }
  gcloud storage --help >/dev/null 2>&1 || { echo "error: this gcloud is too old for 'gcloud storage' — update the gcloud SDK" >&2; exit 1; }
fi

GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
PUBLIC_BASE="${GCS_PUBLIC_BASE_URL:-https://storage.googleapis.com/${GCS_BUCKET}}"
METADATA_PATH="${METADATA_PATH:-harness/staging/runtime/metadata.json}"
NODE_BASE="${NODE_DIST_BASE:-https://nodejs.org/dist}/v${VERSION}"
WORK_DIR="$(mktemp -d)"
SRC="$WORK_DIR/metadata.json"
DST="$WORK_DIR/metadata.next.json"
trap 'rm -rf "$WORK_DIR"' EXIT

curl -fsSL "$NODE_BASE/SHASUMS256.txt" -o "$WORK_DIR/SHASUMS256.txt"

declare -a ENTRIES=()
for pair in \
  "darwin:arm64:darwin-arm64" \
  "darwin:x64:darwin-x64" \
  "linux:arm64:linux-arm64" \
  "linux:x64:linux-x64"; do
  IFS=: read -r platform upstream_arch manifest_arch <<< "$pair"
  archive="node-v${VERSION}-${platform}-${upstream_arch}.tar.gz"
  archive_path="$WORK_DIR/$archive"
  curl -fsSL "$NODE_BASE/$archive" -o "$archive_path"
  expected="$(awk -v name="$archive" '$2 == name { print $1 }' "$WORK_DIR/SHASUMS256.txt")"
  actual="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || {
    echo "error: official SHASUMS256.txt has no checksum for $archive" >&2
    exit 1
  }
  [[ "$actual" == "$expected" ]] || {
    echo "error: checksum mismatch for $archive" >&2
    exit 1
  }

  object_path="harness/runtime/node/v${VERSION}/$archive"
  url="${PUBLIC_BASE%/}/${object_path}"
  size="$(wc -c < "$archive_path" | tr -d ' ')"
  if [ "$DRY_RUN" = 1 ]; then
    echo ">> would upload $archive ($size bytes) to ${object_path}"
  else
    echo ">> uploading $archive ($size bytes)"
    gcloud storage cp --cache-control='public, max-age=31536000, immutable' \
      "$archive_path" "gs://${GCS_BUCKET}/${object_path}"
  fi
  ENTRIES+=("$manifest_arch|v$VERSION|$url|$actual|$size|node-v${VERSION}-${platform}-${upstream_arch}")
done

if [ "$DRY_RUN" = 1 ]; then
  echo ">> dry run: would merge the four entries into ${METADATA_PATH}; nothing uploaded"
  exit 0
fi

if ! gcloud storage cp "gs://${GCS_BUCKET}/${METADATA_PATH}" "$SRC" 2>/dev/null; then
  printf '{}' > "$SRC"
fi

python3 - "$SRC" "$DST" "${ENTRIES[@]}" <<'PY'
import json, sys
src, dst, *entries = sys.argv[1:]
try:
    with open(src) as f:
        document = json.load(f)
except (OSError, json.JSONDecodeError):
    document = {}
if not isinstance(document, dict):
    document = {}
node = document.get("node")
if not isinstance(node, dict):
    node = {}
document["node"] = node
for entry in entries:
    key, version, url, sha256, size, archive_root = entry.split("|", 5)
    node[key] = {
        "version": version,
        "url": url,
        "sha256": sha256,
        "size": int(size),
        "archiveRoot": archive_root,
    }
with open(dst, "w") as f:
    json.dump(document, f, indent=2)
    f.write("\n")
PY

gcloud storage cp --content-type=application/json \
       --cache-control='no-cache, no-store, must-revalidate' \
       "$DST" "gs://${GCS_BUCKET}/${METADATA_PATH}"

echo ">> published managed Node v${VERSION}"
echo ">> manifest: ${PUBLIC_BASE%/}/${METADATA_PATH}"
