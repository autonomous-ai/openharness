#!/usr/bin/env bash
# Publish cli/scripts/install.sh — the one-line CLI installer — to the public, CDN-fronted bucket
# everything else here publishes to. Same idiom as upload-cli.sh: one `cp` with explicit headers, no
# build step, no version to bump — this is one static file. `make upload-cli-install-sh` from the
# repo root.
#
#   gs://s3-autonomous-upgrade-3/harness/cli/install.sh -> https://cdn.autonomous.ai/harness/cli/install.sh
#
# Cache-Control is no-cache/no-store/must-revalidate at the GCS origin. A positive max-age does not
# survive Cloudflare (which fronts cdn.autonomous.ai): it rewrites it to its own ~31-day edge TTL
# (`cache-control: public, max-age=2678400` observed for an origin max-age=300), a zone-level setting
# nothing in this repo can override. no-cache/no-store is the one directive it DOES honor (confirmed
# via `cf-cache-status: BYPASS`), so that is what keeps a publish reaching people promptly. After
# running this, verify the CDN itself serves the new bytes — the command this script prints at the end.
#
# Prereqs: `gcloud storage` authenticated with WRITE access on the bucket.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # cli/
SCRIPT="$ROOT/scripts/install.sh"

GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
GCS_PATH="harness/cli/install.sh"
CDN_URL="https://cdn.autonomous.ai/${GCS_PATH}"

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

[ -f "$SCRIPT" ] || { echo "error: $SCRIPT not found" >&2; exit 1; }
sh -n "$SCRIPT"   # fail before uploading a script that doesn't even parse

CC="no-cache, no-store, must-revalidate"
CT="text/x-shellscript; charset=utf-8"
echo ">> uploading $SCRIPT"
echo "   ->  gs://${GCS_BUCKET}/${GCS_PATH}"
gcloud storage cp --cache-control="$CC" --content-type="$CT" "$SCRIPT" "gs://${GCS_BUCKET}/${GCS_PATH}"

echo ""
echo ">> published: ${CDN_URL}"
echo ">> verify the CDN edge actually serves it (may lag the origin — see this script's header):"
echo "     curl -fsSL ${CDN_URL} | head -5"
