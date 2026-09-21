#!/usr/bin/env bash
# Publish the macOS tmux archives that `cli/scripts/build-managed-tmux.sh` produced, the same way
# publish-managed-node-runtime.sh publishes Node: immutable archives under harness/runtime/tmux/,
# and a manifest whose sha256 is what the installer trusts — never a checksum file fetched at
# install time. Its own manifest, harness/runtime/tmux/metadata.json, rather than an entry in Node's:
# install.sh slices a manifest by the FIRST "<platform>" key it finds, and Node's already has one.
#
# Usage: bash scripts/publish-managed-tmux-runtime.sh 3.5a <dir holding tmux-3.5a-darwin-{arm64,x64}.tar.gz>
#
# Nothing consumes this manifest yet; install.sh learns to download it in the next step.
set -euo pipefail
set +x

VERSION="${1:-}"
ARCHIVES_DIR="${2:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+[a-z]?$ ]] || [[ -z "$ARCHIVES_DIR" ]]; then
  echo "usage: $0 <tmux version, e.g. 3.5a> <archives dir>" >&2
  exit 2
fi
[[ -d "$ARCHIVES_DIR" ]] || { echo "error: $ARCHIVES_DIR is not a directory" >&2; exit 2; }

for command in shasum python3; do
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
# performed the token exchange. Every release path here runs on WIF now. Do not reintroduce it.
command -v gcloud >/dev/null 2>&1 || {
  echo "error: gcloud not found — install/authenticate the gcloud SDK" >&2
  exit 1
}
gcloud storage --help >/dev/null 2>&1 || {
  echo "error: this gcloud is too old for 'gcloud storage' — update the gcloud SDK" >&2
  exit 1
}

# gcs_cp <src> <dst> [cache-control] [content-type] — either side may be gs:// or a local path or `-`.
gcs_cp() {
  local src="$1" dst="$2" cc="${3:-}" ct="${4:-}" args=(storage cp)
  if [ -n "$cc" ]; then args+=("--cache-control=$cc"); fi
  if [ -n "$ct" ]; then args+=("--content-type=$ct"); fi
  gcloud "${args[@]}" "$src" "$dst"
}

GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
PUBLIC_BASE="${GCS_PUBLIC_BASE_URL:-https://storage.googleapis.com/${GCS_BUCKET}}"
METADATA_PATH="${METADATA_PATH:-harness/runtime/tmux/metadata.json}"
WORK_DIR="$(mktemp -d)"
SRC="$WORK_DIR/metadata.json"
DST="$WORK_DIR/metadata.next.json"
trap 'rm -rf "$WORK_DIR"' EXIT

# Both platforms or nothing: a manifest naming one Mac and not the other would make the installer's
# behaviour depend on which laptop it runs on.
declare -a ENTRIES=()
for platform in darwin-arm64 darwin-x64; do
  archive="tmux-${VERSION}-${platform}.tar.gz"
  archive_path="$ARCHIVES_DIR/$archive"
  [[ -f "$archive_path" ]] || { echo "error: missing $archive_path" >&2; exit 1; }
  root="tmux-${VERSION}-${platform}"
  # Captured, not piped into `grep -q`: under `pipefail` grep closing the pipe early fails the whole
  # pipeline on a fine archive — seen on the grid publisher's larger archives, latent here.
  listing="$(tar -tzf "$archive_path")"
  grep -qx "${root}/bin/tmux" <<< "$listing" || {
    echo "error: $archive has no ${root}/bin/tmux" >&2
    exit 1
  }
  sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
  size="$(wc -c < "$archive_path" | tr -d ' ')"
  ENTRIES+=("$platform|$VERSION|$archive|$sha256|$size|$root")
done

for entry in "${ENTRIES[@]}"; do
  IFS='|' read -r platform version archive sha256 size root <<< "$entry"
  object_path="harness/runtime/tmux/v${version}/${archive}"
  echo ">> uploading $archive ($size bytes, sha256 $sha256)"
  gcs_cp "$ARCHIVES_DIR/$archive" "gs://${GCS_BUCKET}/${object_path}" \
    'public, max-age=31536000, immutable'
done

if ! gcs_cp "gs://${GCS_BUCKET}/${METADATA_PATH}" "$SRC" 2>/dev/null; then
  printf '{}' > "$SRC"
fi

python3 - "$SRC" "$DST" "${PUBLIC_BASE%/}" "${ENTRIES[@]}" <<'PY'
import json, sys
src, dst, public_base, *entries = sys.argv[1:]
try:
    with open(src) as f:
        document = json.load(f)
except (OSError, json.JSONDecodeError):
    document = {}
if not isinstance(document, dict):
    document = {}
tmux = document.get("tmux")
if not isinstance(tmux, dict):
    tmux = {}
document["tmux"] = tmux
for entry in entries:
    platform, version, archive, sha256, size, root = entry.split("|", 5)
    tmux[platform] = {
        "version": version,
        "url": f"{public_base}/harness/runtime/tmux/v{version}/{archive}",
        "sha256": sha256,
        "size": int(size),
        "archiveRoot": root,
    }
with open(dst, "w") as f:
    json.dump(document, f, indent=2)
    f.write("\n")
PY

gcs_cp "$DST" "gs://${GCS_BUCKET}/${METADATA_PATH}" \
       'no-cache, no-store, must-revalidate' 'application/json'

echo ">> published managed tmux ${VERSION}"
echo ">> manifest: ${PUBLIC_BASE%/}/${METADATA_PATH}"
