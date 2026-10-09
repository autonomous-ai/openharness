#!/usr/bin/env bash
# Build the Orange Pi 4 Pro image in an arm64 Debian 12 container instead of on the board.
# Two phases, as on the board:
#   1. build-compositor.sh + build-base.sh: Debian packages and labwc. Kept in a volume under
#      the key from base-key.sh and rebuilt only when that key changes.
#   2. build-runtime.sh + build-image.sh: Harness from the committed HEAD, on a copy of the base.
#      Cargo's target directory and npm's cache persist, so a code change compiles incrementally.
# An x86-64 host emulates arm64 through Docker's QEMU (slow: a first build takes hours);
# an arm64 host (Apple Silicon, an arm64 Linux runner) builds natively.
# Usage: build-docker.sh [--base | --harness] BASE.img OUTPUT_DIR
#   (no flag)   phase 1 when its key is new, then phase 2
#   --base      phase 1 only (rebuilt even when its key exists); OUTPUT_DIR is unused
#   --harness   phase 2 only; the base for the current key must already exist
#   BASE.img    Orange Pi's official Orangepi4pro_*_debian_bookworm_server_*.img; its .sha
#               beside it is checked and used for the key
#   OUTPUT_DIR  receives harness-orangepi4pro-debian12-<commit>.img.xz and its .sha256
# Uncommitted changes are not built. Remove the cache: docker volume rm $(docker volume ls -q
# --filter name=harness-orangepi4pro-)
set -euo pipefail
PHASES=all
case ${1:-} in
    --base) PHASES=base; shift ;;
    --harness) PHASES=harness; shift ;;
esac
BASE=$(cd -- "$(dirname -- "${1:?base image}")" && pwd)/$(basename -- "$1")
OUT=$(mkdir -p -- "${2:?output directory}" && cd -- "$2" && pwd)
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
SOURCE=$(cd -- "$HERE/../../.." && pwd)
BUILDER=harness-orangepi4pro-builder
[[ -f $BASE ]] || { echo "No base image at $BASE" >&2; exit 1; }
if [[ -f $BASE.sha ]]; then
    (cd -- "$(dirname -- "$BASE")" && shasum -a 256 -c "$(basename -- "$BASE").sha" >/dev/null) ||
        { echo "$BASE does not match its .sha." >&2; exit 1; }
fi
if [[ -n $(git -C "$SOURCE" status --porcelain --untracked-files=no) ]]; then
    echo 'Uncommitted changes are not part of the build; it uses HEAD.' >&2
fi
# The key is computed from the committed scripts, as the container sees them.
KEY_SOURCE=$(mktemp -d)
trap 'rm -rf "$KEY_SOURCE"' EXIT
git -C "$SOURCE" archive HEAD os/platforms/orangepi-4pro os/packaging/labwc | tar -x -C "$KEY_SOURCE"
KEY=$(bash "$KEY_SOURCE/os/platforms/orangepi-4pro/base-key.sh" "$BASE")
echo "Base key: $KEY"

docker build --platform linux/arm64 -t "$BUILDER" - <<'EOF'
FROM debian:bookworm
ENV DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8 \
    RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq xz-utils python3 python3-venv build-essential musl-tools \
      cmake ninja-build pkg-config bison parted e2fsprogs fdisk udev \
      libffi-dev libexpat1-dev libxml2-dev libudev-dev libmtdev-dev libevdev-dev libseat-dev \
      libegl-dev libgles-dev libgbm-dev hwdata libglib2.0-dev libcairo2-dev libpango1.0-dev \
      libpng-dev librsvg2-dev libpciaccess-dev \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal \
 && rustup target add aarch64-unknown-linux-musl
EOF

# Volumes: phase 1 (compositor sources and prefix, base images) and phase 2 caches.
docker run --rm --privileged --platform linux/arm64 \
    -v "$SOURCE":/src:ro -v "$BASE":/base.img:ro -v "$OUT":/out \
    -v harness-orangepi4pro-wl-work:/cache/wl \
    -v harness-orangepi4pro-wl:/opt/harness-wl \
    -v harness-orangepi4pro-base:/cache/base \
    -v harness-orangepi4pro-cargo:/usr/local/cargo/registry \
    -v harness-orangepi4pro-target:/cache/tui-target \
    -v harness-orangepi4pro-npm:/root/.npm \
    -e HARNESS_WL_WORK=/cache/wl -e BASE_KEY="$KEY" -e PHASES="$PHASES" \
    "$BUILDER" bash -euo pipefail -c '
git config --global --add safe.directory /src
git clone -q /src /build
cd /build
COMMIT=$(git rev-parse --short HEAD)
HERE=os/platforms/orangepi-4pro

# Phase 1, only when its key is new (or asked for with --base).
HARNESS_BASE=/cache/base/base-$BASE_KEY.img
if [[ $PHASES == harness && ! -f $HARNESS_BASE ]]; then
    echo "No base for key $BASE_KEY yet: run with --base first." >&2
    exit 1
elif [[ -f $HARNESS_BASE && $PHASES != base ]]; then
    echo "Phase 1: reusing base $BASE_KEY"
else
    echo "Phase 1: building base $BASE_KEY"
    # The compositor has its own key: its sources and done-markers are reused only for the
    # same script, labwc source and patch.
    COMPOSITOR_KEY=$(cat $HERE/build-compositor.sh os/packaging/labwc/source.json \
        os/packaging/labwc/session-lock-presentation.patch | sha256sum | cut -c1-16)
    if [[ $(cat /opt/harness-wl/.harness-key 2>/dev/null) != "$COMPOSITOR_KEY" ]]; then
        find /opt/harness-wl /cache/wl -mindepth 1 -delete
    fi
    bash $HERE/build-compositor.sh
    echo "$COMPOSITOR_KEY" > /opt/harness-wl/.harness-key
    bash $HERE/build-base.sh /base.img "$HARNESS_BASE" "$BASE_KEY"
    find /cache/base -name "base-*.img" ! -name "base-$BASE_KEY.img" -delete
fi
[[ $PHASES != base ]] || { ls -la /cache/base; exit 0; }

# Phase 2: Harness from this commit. The clone is fresh; cargo output is not.
ln -s /cache/tui-target tui/target
HARNESS_OS_RUNTIME_DIR=/build/os/work/runtime-arm bash os/tools/build-runtime.sh
IMG=/build/harness-orangepi4pro-debian12-$COMMIT.img
bash $HERE/build-image.sh "$HARNESS_BASE" /build/os/work/runtime-arm "$IMG"
xz -T0 -6 -c "$IMG" > "/out/${IMG##*/}.xz"
cd /out && sha256sum "${IMG##*/}.xz" > "${IMG##*/}.xz.sha256"
ls -la /out
'
