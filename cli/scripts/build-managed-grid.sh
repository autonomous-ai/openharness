#!/usr/bin/env bash
# Build the managed grid — the grid CLI as a runtime under ~/.harness/runtime, in the shape Node and
# tmux already take: one archive per platform, grid-<ver>-<platform>/bin/grid inside, its sha256 in
# our own manifest (desktop/scripts/publish-managed-grid-runtime.sh). install.sh lays it down once;
# the daemon keeps it at the pin (ensureManagedGrid, cli/src/lib/runtimeInstall.ts).
#
#   bash cli/scripts/build-managed-grid.sh linux-x64    0.3.47 [out-dir]   # wraps grid's own release binary
#   bash cli/scripts/build-managed-grid.sh linux-arm64  0.3.47 [out-dir]
#   bash cli/scripts/build-managed-grid.sh darwin-arm64 0.3.47 [out-dir]   # builds it — grid ships no macOS binary
#   bash cli/scripts/build-managed-grid.sh darwin-x64   0.3.47 [out-dir]   # on an Intel Mac; Nuitka cannot cross-compile
#
# Linux is a DOWNLOAD. autonomous-grid's release already ships a self-contained Nuitka onefile per
# arch with a SHA256SUMS beside it; that checksum is verified HERE, once, and the archive is re-hosted
# under our manifest with our own sha256 — so the installer never fetches a checksum file at install
# time (the rule publish-managed-tmux-runtime.sh states).
#
# macOS is a BUILD. grid publishes no macOS binary: its packaging/README.md blames ad-hoc signing,
# but the review in docs/plans/2026-09-14-004-harness-grid-plan.md found the SIGKILL is Gatekeeper on
# a QUARANTINED download — which a curl-fetched runtime never is, and why the ad-hoc managed tmux
# runs on every Mac today. So the source is checked out at the release tag and packaging/build_binary.sh
# runs exactly as grid runs it, Nuitka's own ad-hoc signature and all. Nothing is notarized.
set -euo pipefail

usage() {
  echo "usage: $0 linux-x64|linux-arm64|darwin-arm64|darwin-x64 <grid version, e.g. 0.3.47> [out-dir]" >&2
  exit 2
}

PLATFORM="${1:-}"
VERSION="${2:-}"
OUT_DIR="${3:-$PWD/dist/grid}"
ASSET=""
BUILD_ARCH=""
case "$PLATFORM" in
  linux-x64)    ASSET=grid-linux-x86_64 ;;
  linux-arm64)  ASSET=grid-linux-arm64 ;;
  darwin-arm64) BUILD_ARCH=arm64 ;;
  darwin-x64)   BUILD_ARCH=x86_64 ;;
  *) usage ;;
esac
# A release tag without its `v`: what the manifest's `version` carries, and what `grid --version` prints.
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage

GRID_REPO="${GRID_REPO:-https://github.com/autonomous-ai/autonomous-grid}"
GRID_RELEASE_BASE="${GRID_RELEASE_BASE:-$GRID_REPO/releases/download/v$VERSION}"
GRID_RAW_BASE="${GRID_RAW_BASE:-https://raw.githubusercontent.com/autonomous-ai/autonomous-grid/v$VERSION}"

for command in curl tar; do
  command -v "$command" >/dev/null 2>&1 || { echo "error: $command is required" >&2; exit 1; }
done

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else echo "error: need shasum or sha256sum" >&2; exit 1
  fi
}

host_platform() {
  local os arch
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) os=other ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) arch=other ;; esac
  printf '%s-%s\n' "$os" "$arch"
}

ROOT="grid-$VERSION-$PLATFORM"
WORK="$(mktemp -d)"
# KEEP_WORK=1 leaves the work tree behind for a post-mortem.
[ "${KEEP_WORK:-0}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/stage/$ROOT"
mkdir -p "$STAGE/bin"

fetch() { # <url> <file>
  curl -fsSL --proto '=https' "$1" -o "$2" || { echo "error: could not download $1" >&2; exit 1; }
}

case "$PLATFORM" in
  linux-*)
    echo ">> fetching $ASSET from $GRID_RELEASE_BASE"
    fetch "$GRID_RELEASE_BASE/$ASSET" "$WORK/$ASSET"
    fetch "$GRID_RELEASE_BASE/SHA256SUMS" "$WORK/SHA256SUMS"
    # One process, no pipe: under `pipefail` a `head -1` closing the pipe early would fail the line.
    want="$(awk -v asset="$ASSET" '$2 == asset { print $1; exit }' "$WORK/SHA256SUMS")"
    [ -n "$want" ] || { echo "error: the release's SHA256SUMS names no $ASSET" >&2; exit 1; }
    got="$(sha256_of "$WORK/$ASSET")"
    [ "$got" = "$want" ] || {
      echo "error: $ASSET failed checksum verification against SHA256SUMS (expected $want, got $got)" >&2
      exit 1
    }
    install -m 0755 "$WORK/$ASSET" "$STAGE/bin/grid"
    ;;
  darwin-*)
    [ "$(uname -s)" = Darwin ] || { echo "error: the macOS grid is built on macOS" >&2; exit 1; }
    [ "$(uname -m)" = "$BUILD_ARCH" ] || {
      echo "error: Nuitka cannot cross-compile — build $PLATFORM on a $BUILD_ARCH Mac (this one is $(uname -m))" >&2
      exit 1
    }
    command -v git >/dev/null 2>&1 || { echo "error: git is required" >&2; exit 1; }
    echo ">> checking out $GRID_REPO at v$VERSION"
    git clone --quiet --depth 1 --branch "v$VERSION" "$GRID_REPO" "$WORK/src"
    # grid's own build, unchanged: --standalone --onefile, its ad-hoc signature, its tempdir spec.
    (cd "$WORK/src" && bash packaging/build_binary.sh)
    install -m 0755 "$WORK/src/dist/grid" "$STAGE/bin/grid"
    # Explicit and identical to the tmux runtime's: nothing here is notarized, and nothing needs to be.
    codesign -s - --force "$STAGE/bin/grid" 2>/dev/null || true
    ;;
esac

fetch "$GRID_RAW_BASE/LICENSE" "$STAGE/LICENSE.grid"

# Smoke: the binary answers with the version asked for — on a host that can run it. Each CI runner
# builds its own platform, so this is skipped only by hand, cross-platform.
if [ "$(host_platform)" = "$PLATFORM" ]; then
  answered="$(GRID_NO_UPDATE_CHECK=1 "$STAGE/bin/grid" --version 2>&1 || true)"
  # The whole line, not a substring: `0.3.4` is inside `0.3.47`.
  if grep -qxE "grid ${VERSION//./\\.}" <<< "$answered"; then
    echo ">> smoke: $answered"
  else
    echo "error: $STAGE/bin/grid --version answered '$answered', not 'grid $VERSION'" >&2
    exit 1
  fi
else
  echo ">> smoke skipped: this host is $(host_platform), the archive is for $PLATFORM"
fi

mkdir -p "$OUT_DIR"
ARCHIVE="$OUT_DIR/$ROOT.tar.gz"
tar -czf "$ARCHIVE" -C "$WORK/stage" "$ROOT"
echo ">> built $ARCHIVE ($(wc -c < "$ARCHIVE" | tr -d ' ') bytes, sha256 $(sha256_of "$ARCHIVE"))"
