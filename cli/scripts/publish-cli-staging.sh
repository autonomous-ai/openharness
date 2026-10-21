#!/usr/bin/env bash
# Publish a CLI build to STAGING only: <prefix>/cli/<version>/{cli.js,notify.mjs} and the `cli` key of
# <prefix>/cli/metadata.json, in the shape upload-cli.sh gives harness/cli/metadata.json. The staging install.ps1
# (upload-install-ps1.sh) reads that manifest. It is for a build that must not reach a released path, such as a
# branch build stamped 0.4.18-dev.win1: a -dev version never updates itself (selfUpdate.ts isLocalDevBuild).
#
#   bash cli/scripts/publish-cli-staging.sh 0.4.18-dev.win1               # bundle with ADAPTER_VERSION, then publish
#   CLI_DIST_DIR=<dir> bash cli/scripts/publish-cli-staging.sh <version> --no-build   # publish <dir>/cli.js as it is
#
# STAGING_PREFIX (default harness/staging) must be harness/staging or a folder under it; anything else is refused.
# A version that is already there is refused before any upload: versioned objects are immutable (the CDN keeps the
# first bytes). The manifest starts from {} only when it is confirmed absent (lib/gcs.sh).
# DRY_RUN=1 DRY_RUN_OUT=<dir> checks the bundle, writes it and the manifest into <dir>, and touches no bucket.
set -euo pipefail

VERSION="${1:-}"
shift || true
DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    *) echo "error: unknown argument '$arg' (use --no-build)" >&2; exit 2 ;;
  esac
done
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$ ]]; then
  echo "usage: $0 <X.Y.Z[-prerelease]> [--no-build]" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # cli/
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
CDN_ASSET_BASE_URL="${CDN_ASSET_BASE_URL:-https://cdn.autonomous.ai}"
STAGING_PREFIX="${STAGING_PREFIX:-harness/staging}"
CLI_DIST_DIR="${CLI_DIST_DIR:-$ROOT/dist}"
OTA_KEY=cli
DRY_RUN="${DRY_RUN:-0}"
if [ "$DRY_RUN" != 0 ] && [ "$DRY_RUN" != 1 ]; then
  echo "error: DRY_RUN must be 0 or 1, not '$DRY_RUN'; nothing was published." >&2
  exit 2
fi
[[ "$STAGING_PREFIX" =~ ^harness/staging(/[a-z0-9_-]+)*$ ]] || {
  echo "error: STAGING_PREFIX '$STAGING_PREFIX' is not harness/staging or a folder under it; nothing was published." >&2
  exit 2
}
command -v node >/dev/null 2>&1 || { echo "error: node is required" >&2; exit 1; }
if [ "$DRY_RUN" != 1 ]; then
  command -v gcloud >/dev/null 2>&1 || { echo "error: gcloud not found; install and authenticate the gcloud SDK" >&2; exit 1; }
fi

source "$(dirname "${BASH_SOURCE[0]}")/lib/gcs.sh"

CLI_OBJECT="${STAGING_PREFIX}/cli/${VERSION}/cli.js"
NOTIFY_OBJECT="${STAGING_PREFIX}/cli/${VERSION}/notify.mjs"
METADATA_PATH="${STAGING_PREFIX}/cli/metadata.json"
# Before the bundle, so a version that is already there fails in seconds; and every check before any upload, so a
# failure never leaves one immutable object published without the other.
if [ "$DRY_RUN" != 1 ]; then
  for object in "$CLI_OBJECT" "$NOTIFY_OBJECT"; do
    if exists "gs://${GCS_BUCKET}/${object}"; then
      echo "error: gs://${GCS_BUCKET}/${object} already exists. Versioned artifacts are immutable (the CDN keeps the first bytes); publish a new version." >&2
      exit 1
    fi
  done
fi

if [ "$DO_BUILD" = 1 ]; then
  echo ">> bundling $VERSION into $CLI_DIST_DIR"
  ( cd "$ROOT" && ADAPTER_VERSION="$VERSION" BUNDLE_OUT_DIR="$CLI_DIST_DIR" npm run bundle )
fi
CLI="$CLI_DIST_DIR/cli.js"
NOTIFY="$CLI_DIST_DIR/notify.mjs"
[ -f "$CLI" ] && [ -f "$NOTIFY" ] || { echo "error: $CLI or $NOTIFY is missing; bundle first (drop --no-build)" >&2; exit 1; }
# upload-cli.sh's checks on the bundle.
head -1 "$CLI" | grep -q '^#!' || { echo "error: $CLI lost its shebang on line 1" >&2; exit 1; }
said="$(node "$CLI" version)"
[ "$said" = "$VERSION" ] || { echo "error: $CLI reports '$said', not $VERSION (ADAPTER_VERSION not injected)" >&2; exit 1; }
node "$ROOT/scripts/test-core-harness-upgrade.mjs" "$CLI"
node "$ROOT/scripts/check-lean-bundle.mjs" "$CLI"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# The `cli` entry upload-cli.sh (merge-manifest.mjs) writes: version, then url, sha256 and size per file.
node -e '
  const [version, cliUrl, cliSha, cliSize, notifyUrl, notifySha, notifySize, out] = process.argv.slice(1)
  const entry = { version, cli: { url: cliUrl, sha256: cliSha, size: Number(cliSize) }, notify: { url: notifyUrl, sha256: notifySha, size: Number(notifySize) } }
  require("node:fs").writeFileSync(out, JSON.stringify(entry))
' "$VERSION" \
  "${CDN_ASSET_BASE_URL%/}/${CLI_OBJECT}" "$(sha256_of "$CLI")" "$(wc -c < "$CLI" | tr -d ' ')" \
  "${CDN_ASSET_BASE_URL%/}/${NOTIFY_OBJECT}" "$(sha256_of "$NOTIFY")" "$(wc -c < "$NOTIFY" | tr -d ' ')" \
  "$WORK/cli-entry.json"

if [ "$DRY_RUN" = 1 ]; then
  printf '{}' > "$WORK/metadata.json"
else
  fetch_manifest "gs://${GCS_BUCKET}/${METADATA_PATH}" "$WORK/metadata.json" "$METADATA_PATH"
fi
node "$ROOT/scripts/lib/runtimeManifest.mjs" key "$WORK/metadata.json" "$WORK/metadata.next.json" "$OTA_KEY" "$WORK/cli-entry.json"

if [ "$DRY_RUN" = 1 ]; then
  out="${DRY_RUN_OUT:?DRY_RUN=1 needs DRY_RUN_OUT, a folder for the bundle and the manifest}"
  mkdir -p "$out"
  cp "$CLI" "$NOTIFY" "$out/"
  cp "$WORK/metadata.next.json" "$out/metadata.json"
  echo ">> dry run: cli.js, notify.mjs and the manifest in $out"
  exit 0
fi
echo ">> uploading cli.js + notify.mjs ($VERSION) to gs://${GCS_BUCKET}/${STAGING_PREFIX}/cli/${VERSION}/"
gcloud storage cp --cache-control='public, max-age=31536000, immutable' "$CLI" "gs://${GCS_BUCKET}/${CLI_OBJECT}"
gcloud storage cp --cache-control='public, max-age=31536000, immutable' "$NOTIFY" "gs://${GCS_BUCKET}/${NOTIFY_OBJECT}"
gcloud storage cp --content-type=application/json --cache-control='no-cache, no-store, must-revalidate' \
  "$WORK/metadata.next.json" "gs://${GCS_BUCKET}/${METADATA_PATH}"
echo ">> published the CLI $VERSION to https://storage.googleapis.com/${GCS_BUCKET}/${METADATA_PATH}"
