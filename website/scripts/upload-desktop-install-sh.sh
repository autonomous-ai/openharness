#!/usr/bin/env bash
# Publish the desktop installer script to the public, CDN-fronted bucket everything else in this
# product already publishes to. Same idiom as website/scripts/upload-cli-install-sh.sh and
# autonomous-harness-desktop/scripts/upload-desktop.sh: plain `gsutil cp` with an explicit
# Cache-Control header, no build step, no version to bump — this is one static file.
#
# gs://s3-autonomous-upgrade-3/harness/desktop/install.sh -> https://cdn.autonomous.ai/harness/desktop/install.sh
#
# no-cache/no-store/must-revalidate, deliberately, not a positive max-age: Cloudflare (which fronts
# cdn.autonomous.ai) does NOT honor a positive max-age here — it rewrites it to its own ~31-day edge
# TTL regardless of what's set at the origin, a zone-level Cloudflare setting nothing in this repo can
# override. no-cache/no-store is the one directive it DOES honor (confirmed via `cf-cache-status:
# BYPASS`), so that's what keeps a publish actually reaching people promptly. Same reasoning as
# upload-cli-install-sh.sh — see that script's header for how this was verified live.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # website
SCRIPT="$ROOT/scripts/desktop-install.sh"

GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
GCS_PATH="harness/desktop/install.sh"
CDN_URL="https://cdn.autonomous.ai/${GCS_PATH}"

command -v gsutil >/dev/null 2>&1 || { echo "error: gsutil not found — install/authenticate the gcloud SDK" >&2; exit 1; }
[ -f "$SCRIPT" ] || { echo "error: $SCRIPT not found" >&2; exit 1; }
sh -n "$SCRIPT"   # fail before uploading a script that doesn't even parse

echo ">> uploading $SCRIPT"
echo "   ->  gs://${GCS_BUCKET}/${GCS_PATH}"
gsutil -h "Content-Type:text/x-shellscript; charset=utf-8" \
       -h "Cache-Control:no-cache, no-store, must-revalidate" \
       cp "$SCRIPT" "gs://${GCS_BUCKET}/${GCS_PATH}"

echo ""
echo ">> published: ${CDN_URL}"
echo ">> verify the CDN edge actually serves it:"
echo "     curl -fsSL ${CDN_URL} | head -5"
