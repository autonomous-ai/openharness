#!/usr/bin/env bash
# Promote a released Windows pty payload from staging to production, uploading nothing.
#
# release.yml's windows-staging job publishes the payload's zips under harness/staging/pty/<version>/ and points the
# STAGING manifest's `pty` key at them (publish-pty-payload.sh). Those objects are immutable, and a second
# publish-pty-payload.sh run would build zips of other bytes (zip file times) and be refused. So production names the
# same objects: this script reads the staging `pty` entries, checks that both are <version>, fetches each URL and
# checks its sha256 and size, then merges the two entries into the PRODUCTION manifest (harness/pty/metadata.json),
# keeping every other key and platform there. Production then depends on those staging objects: they must never be
# removed from harness/staging/pty/<version>/ while production names them. A version older than the one production
# holds is refused unless --allow-downgrade is given.
#
# The owner's production order for Windows, once the staging E2E (docs/testing/windows-cli-e2e.md) has passed, and
# after the merge to main. Each step reads what the one before it published:
#   1. the Node runtime: run the "Node runtime for Windows" workflow (release-node-runtime-windows.yml) with
#      metadata_path harness/runtime/metadata.json;
#   2. the pty payload: bash cli/scripts/promote-pty-payload.sh [--allow-downgrade] <version>
#      (DRY_RUN=1 DRY_RUN_OUT=<dir> first: it checks the same things and writes the manifest it would publish into <dir>);
#   3. the installer: bash cli/scripts/upload-install-ps1.sh --production
#
# Environment: GCS_BUCKET; STAGING_METADATA_PATH (harness/staging/pty/metadata.json); METADATA_PATH, the manifest
# promoted into (harness/pty/metadata.json); DRY_RUN=1 with DRY_RUN_OUT=<dir> reads and checks, and writes nothing to
# the bucket. Needs gcloud (authenticated), curl and node.
set -euo pipefail

ALLOW_DOWNGRADE=0
if [ "${1:-}" = --allow-downgrade ]; then ALLOW_DOWNGRADE=1; shift; fi
VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [ "$#" -ne 1 ]; then
  echo "usage: $0 [--allow-downgrade] <X.Y.Z>   (a release version: a prerelease stays on staging)" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # cli/
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
STAGING_METADATA_PATH="${STAGING_METADATA_PATH:-harness/staging/pty/metadata.json}"
METADATA_PATH="${METADATA_PATH:-harness/pty/metadata.json}"
DRY_RUN="${DRY_RUN:-0}"
if [ "$DRY_RUN" != 0 ] && [ "$DRY_RUN" != 1 ]; then
  echo "error: DRY_RUN must be 0 or 1, not '$DRY_RUN'; nothing was promoted." >&2
  exit 2
fi
# Only a pty manifest, production's or a staging prefix's: never the fleet's cli manifest or the Node one.
PTY_MANIFEST='^harness/(staging[a-z0-9-]*/)?pty/metadata\.json$'
[[ "$STAGING_METADATA_PATH" =~ $PTY_MANIFEST ]] || { echo "error: STAGING_METADATA_PATH '$STAGING_METADATA_PATH' is not a pty manifest" >&2; exit 2; }
[[ "$METADATA_PATH" =~ $PTY_MANIFEST ]] || { echo "error: METADATA_PATH '$METADATA_PATH' is not a pty manifest" >&2; exit 2; }
[ "$STAGING_METADATA_PATH" != "$METADATA_PATH" ] || { echo "error: the staging and the target manifest are the same ($METADATA_PATH)" >&2; exit 2; }

for command in node curl gcloud; do
  command -v "$command" >/dev/null 2>&1 || { echo "error: $command is required" >&2; exit 1; }
done
source "$(dirname "${BASH_SOURCE[0]}")/lib/gcs.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The staging manifest must be there: a promotion of nothing is a mistake, not a first publish.
if ! exists "gs://${GCS_BUCKET}/${STAGING_METADATA_PATH}"; then
  echo "error: there is no staging manifest at gs://${GCS_BUCKET}/${STAGING_METADATA_PATH}; nothing was promoted." >&2
  exit 1
fi
gcloud storage cp "gs://${GCS_BUCKET}/${STAGING_METADATA_PATH}" "$WORK/staging.json" >/dev/null
# The existing target manifest: {} only when it is confirmed absent; any other failure aborts.
fetch_manifest "gs://${GCS_BUCKET}/${METADATA_PATH}" "$WORK/metadata.json" "$METADATA_PATH"
# Never back to an older payload by mistake: a production entry newer than <version> needs --allow-downgrade.
if [ "$ALLOW_DOWNGRADE" != 1 ]; then
  if ! node - "$WORK/metadata.json" "$VERSION" <<'JS'
const [file, version] = process.argv.slice(2)
const parts = (v) => String(v).split('-')[0].split('.').map(Number)
const newer = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] || 0) > (y[i] || 0); return false }
const pty = JSON.parse(require('node:fs').readFileSync(file, 'utf8')).pty || {}
for (const key of ['win32-x64', 'win32-arm64']) {
  const held = pty[key] && pty[key].version
  if (held && newer(held, version)) {
    console.error(`error: production has the ${key} pty payload ${held}, newer than ${version}; to go back to ${version}, run again with --allow-downgrade. Nothing was promoted.`)
    process.exit(1)
  }
}
JS
  then exit 1; fi
fi

printf '{}' > "$WORK/entries.json"
for key in win32-x64 win32-arm64; do
  # version, url, sha256 and size of the staging entry, one per line, or an error saying what is wrong with it.
  if ! fields="$(node - "$WORK/staging.json" "$key" "$VERSION" <<'JS'
const [file, key, version] = process.argv.slice(2)
const entry = (JSON.parse(require('node:fs').readFileSync(file, 'utf8')).pty || {})[key]
if (!entry) { console.error(`the staging manifest has no pty entry for ${key}`); process.exit(1) }
if (entry.version !== version) { console.error(`the staging ${key} pty entry is ${entry.version}, not ${version}`); process.exit(1) }
// The zip release.yml published for this version and architecture, over https.
const zip = `/pty/${version}/harness-pty-${version}-${key}.zip`
if (typeof entry.url !== 'string' || !entry.url.startsWith('https://') || !entry.url.endsWith(zip)) {
  console.error(`the staging ${key} pty entry's url is not this version's zip over https: ${entry.url}`); process.exit(1)
}
console.log([entry.version, entry.url, entry.sha256, entry.size].join('\n'))
JS
)"; then
    echo "error: nothing was promoted." >&2
    exit 1
  fi
  { read -r version; read -r url; read -r sha; read -r size; } <<< "$fields"
  echo ">> checking $key: $url"
  curl -fsSL --retry 3 --retry-all-errors --max-time 300 -H 'Cache-Control: no-cache' "$url" -o "$WORK/$key.zip" \
    || { echo "error: could not fetch $url; nothing was promoted." >&2; exit 1; }
  got_sha="$(sha256_of "$WORK/$key.zip")"
  got_size="$(wc -c < "$WORK/$key.zip" | tr -d ' ')"
  if [ "$got_sha" != "$sha" ] || [ "$got_size" != "$size" ]; then
    echo "error: $url serves $got_size bytes with sha256 $got_sha, where the staging manifest says $size bytes, $sha; nothing was promoted." >&2
    exit 1
  fi
  # The same checks every publish makes on an entry (https, a hex sha256, a real size).
  node "$ROOT/scripts/lib/runtimeManifest.mjs" entry "$WORK/entries.json" "$key" "$version" "$url" "$sha" "$size"
done
node "$ROOT/scripts/lib/runtimeManifest.mjs" platforms "$WORK/metadata.json" "$WORK/metadata.next.json" pty "$WORK/entries.json"
[ -s "$WORK/metadata.next.json" ] || { echo "error: the merged manifest was not written; nothing was promoted." >&2; exit 1; }

if [ "$DRY_RUN" = 1 ]; then
  out="${DRY_RUN_OUT:?DRY_RUN=1 needs DRY_RUN_OUT, a folder for the manifest}"
  mkdir -p "$out"
  cp "$WORK/metadata.next.json" "$out/metadata.json"
  echo ">> dry run: the manifest for gs://${GCS_BUCKET}/${METADATA_PATH} is in $out/metadata.json; nothing was promoted"
  exit 0
fi
gcloud storage cp --content-type=application/json --cache-control='no-cache, no-store, must-revalidate' \
  "$WORK/metadata.next.json" "gs://${GCS_BUCKET}/${METADATA_PATH}"
echo ">> promoted the pty payload $VERSION to https://storage.googleapis.com/${GCS_BUCKET}/${METADATA_PATH}"
