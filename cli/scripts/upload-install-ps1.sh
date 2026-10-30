#!/usr/bin/env bash
# Publish cli/scripts/install.ps1, the Windows installer (`irm ... | iex`), beside install.sh.
#
# STAGING by default: <prefix>/cli/install.ps1, with its manifest base rewritten to .../<prefix>/. The staging
# copy then installs the staging build:
#   irm https://cdn.autonomous.ai/harness/staging/cli/install.ps1 | iex
# --production publishes harness/cli/install.ps1 exactly as it is. That is the owner's step, once the staging E2E
# (docs/testing/windows-cli-e2e.md) has passed, and it refuses until the production manifests carry Windows.
# --print writes what would be uploaded to stdout and uploads nothing.
# --app publishes the same script with its app-default line on, at <prefix>/desktop/install.ps1 (or
# harness/desktop/install.ps1 with --production): irm https://cdn.autonomous.ai/harness/staging/desktop/install.ps1 | iex
# Cache headers are upload-install-sh.sh's, for its reason: Cloudflare honours only no-cache/no-store here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # cli/
SCRIPT="$ROOT/scripts/install.ps1"
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
STAGING_PREFIX="${STAGING_PREFIX:-harness/staging}"
MODE=staging
PRINT=0
APP=0
for arg in "$@"; do
  case "$arg" in
    --production) MODE=production ;;
    --print)      PRINT=1 ;;
    --app)        APP=1 ;;
    *) echo "error: unknown argument '$arg' (use --production, --app and/or --print)" >&2; exit 2 ;;
  esac
done
[[ "$STAGING_PREFIX" =~ ^harness/[a-z0-9_-]+(/[a-z0-9_-]+)*$ ]] || { echo "error: STAGING_PREFIX '$STAGING_PREFIX' is not a folder under harness/" >&2; exit 2; }
[ -f "$SCRIPT" ] || { echo "error: $SCRIPT not found" >&2; exit 1; }
# Windows PowerShell 5.1 reads a BOM-less script in the ANSI code page: one non-ASCII byte garbles it.
if LC_ALL=C grep -q $'[^\t -~]' "$SCRIPT"; then echo "error: install.ps1 must be pure ASCII" >&2; exit 1; fi
LINE_START="\$HarnessManifestBase = '"
count="$(awk -v start="$LINE_START" 'index($0, start) == 1 { n++ } END { print n + 0 }' "$SCRIPT")"
[ "$count" = 1 ] || { echo "error: install.ps1 must have exactly one line starting with $LINE_START (found $count)" >&2; exit 1; }
APP_LINE="\$HarnessInstallApp = \$false"
app_count="$(awk -v line="$APP_LINE" '$0 == line { n++ } END { print n + 0 }' "$SCRIPT")"
[ "$app_count" = 1 ] || { echo "error: install.ps1 must have exactly one line '$APP_LINE' (found $app_count)" >&2; exit 1; }

OUT="$(mktemp)"
trap 'rm -f "$OUT" "$OUT.app"' EXIT
if [ "$MODE" = staging ]; then
  base="https://storage.googleapis.com/${GCS_BUCKET}/${STAGING_PREFIX}/"
  awk -v start="$LINE_START" -v base="$base" 'index($0, start) == 1 { print start base "'"'"'"; next } { print }' "$SCRIPT" > "$OUT"
  GCS_PATH="${STAGING_PREFIX}/cli/install.ps1"
else
  cp "$SCRIPT" "$OUT"
  GCS_PATH="harness/cli/install.ps1"
fi
if [ "$APP" = 1 ]; then
  awk -v line="$APP_LINE" '$0 == line { print "$HarnessInstallApp = $true"; next } { print }' "$OUT" > "$OUT.app"
  mv "$OUT.app" "$OUT"
  GCS_PATH="${GCS_PATH%/cli/install.ps1}/desktop/install.ps1"
fi
if [ "$PRINT" = 1 ]; then
  echo ">> would upload to gs://${GCS_BUCKET}/${GCS_PATH}" >&2
  cat "$OUT"
  exit 0
fi

command -v gcloud >/dev/null 2>&1 || { echo "error: gcloud not found; install and authenticate the gcloud SDK" >&2; exit 1; }
if [ "$MODE" = production ]; then
  # The production install.ps1 installs whatever the production manifests name. Until they carry this CLI's Windows
  # terminal host and a Windows Node runtime (and, for --app, both Windows zips), it would install a CLI built
  # without Windows support, or fail halfway: so it goes up only after those steps (desktop/RELEASE.md).
  read_manifest() { gcloud storage cat "gs://${GCS_BUCKET}/harness/$1/metadata.json" 2>/dev/null || echo '{}'; }
  CLI_JSON="$(read_manifest cli)" NODE_JSON="$(read_manifest runtime)" PTY_JSON="$(read_manifest pty)" \
  DESKTOP_JSON="$([ "$APP" = 1 ] && read_manifest desktop || echo '{}')" APP="$APP" node -e '
    const read = (name) => { try { return JSON.parse(process.env[name]) } catch { return {} } }
    const cli = read("CLI_JSON").cli?.version, node = read("NODE_JSON").node ?? {}, pty = read("PTY_JSON").pty ?? {}
    const missing = []
    if (!cli) missing.push("cli/metadata.json has no cli version")
    for (const key of ["win32-x64", "win32-arm64"]) {
      if (!node[key]) missing.push(`runtime/metadata.json has no ${key} Node runtime`)
      if (pty[key]?.version !== cli) missing.push(`pty/metadata.json ${key} is ${pty[key]?.version ?? "absent"}, not the CLI ${cli}`)
    }
    if (process.env.APP === "1") {
      const desktop = read("DESKTOP_JSON")
      for (const key of ["desktop-windows-x64", "desktop-windows-arm64"]) if (!desktop[key]) missing.push(`desktop/metadata.json has no ${key}`)
    }
    if (missing.length) {
      console.error(`error: production is not ready for Windows:\n  ${missing.join("\n  ")}`)
      process.exit(1)
    }
  ' || exit 1
fi
echo ">> uploading install.ps1 ($MODE) -> gs://${GCS_BUCKET}/${GCS_PATH}"
gcloud storage cp --cache-control="no-cache, no-store, must-revalidate" --content-type="text/plain; charset=utf-8" "$OUT" "gs://${GCS_BUCKET}/${GCS_PATH}"
echo ">> published: https://cdn.autonomous.ai/${GCS_PATH}"
echo ">> verify the CDN edge serves it:  curl -fsSL https://cdn.autonomous.ai/${GCS_PATH} | grep -E 'HarnessManifestBase|HarnessInstallApp'"
