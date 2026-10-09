#!/usr/bin/env bash
# Build the Orange Pi 4 Pro image in an arm64 Debian 12 container instead of on the board.
# Runs build-runtime.sh, build-compositor.sh and build-image.sh unchanged inside it.
# An x86-64 host emulates arm64 through Docker's QEMU (slow: a first build takes hours);
# an arm64 host (Apple Silicon, an arm64 Linux runner) builds natively.
# Usage: build-docker.sh BASE.img OUTPUT_DIR
#   BASE.img    Orange Pi's official Orangepi4pro_*_debian_bookworm_server_*.img (checked
#               against its .sha first)
#   OUTPUT_DIR  receives harness-orangepi4pro-debian12-<commit>.img.xz and its .sha256
# The build uses the committed HEAD of this checkout; uncommitted changes are not included.
set -euo pipefail
BASE=$(cd -- "$(dirname -- "${1:?base image}")" && pwd)/$(basename -- "$1")
OUT=$(mkdir -p -- "${2:?output directory}" && cd -- "$2" && pwd)
SOURCE=$(cd -- "$(dirname -- "$0")/../../.." && pwd)
BUILDER=harness-orangepi4pro-builder
[[ -f $BASE ]] || { echo "No base image at $BASE" >&2; exit 1; }
if [[ -n $(git -C "$SOURCE" status --porcelain --untracked-files=no) ]]; then
    echo 'Uncommitted changes are not part of the build; it uses HEAD.' >&2
fi

docker build --platform linux/arm64 -t "$BUILDER" - <<'EOF'
FROM debian:bookworm
ENV DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8 \
    RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq xz-utils python3 python3-venv build-essential musl-tools \
      cmake ninja-build pkg-config parted e2fsprogs fdisk udev \
      libffi-dev libexpat1-dev libxml2-dev libudev-dev libmtdev-dev libevdev-dev libseat-dev \
      libegl-dev libgles-dev libgbm-dev hwdata libglib2.0-dev libcairo2-dev libpango1.0-dev \
      libpng-dev librsvg2-dev libpciaccess-dev \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal \
 && rustup target add aarch64-unknown-linux-musl
EOF

# Named volumes keep the slow parts between builds: cargo downloads, the compositor's
# sources and done-markers, and its install prefix (whose path the image keeps).
docker run --rm --privileged --platform linux/arm64 \
    -v "$SOURCE":/src:ro -v "$BASE":/base.img:ro -v "$OUT":/out \
    -v harness-orangepi4pro-cargo:/usr/local/cargo/registry \
    -v harness-orangepi4pro-wl-work:/cache/wl \
    -v harness-orangepi4pro-wl:/opt/harness-wl \
    -e HARNESS_WL_WORK=/cache/wl \
    "$BUILDER" bash -euo pipefail -c '
git config --global --add safe.directory /src
git clone -q /src /build
cd /build
COMMIT=$(git rev-parse --short HEAD)
HARNESS_OS_RUNTIME_DIR=/build/os/work/runtime-arm bash os/tools/build-runtime.sh
bash os/platforms/orangepi-4pro/build-compositor.sh
IMG=/build/harness-orangepi4pro-debian12-$COMMIT.img
bash os/platforms/orangepi-4pro/build-image.sh /base.img /build/os/work/runtime-arm "$IMG"
xz -T0 -6 -c "$IMG" > "/out/${IMG##*/}.xz"
cd /out && sha256sum "${IMG##*/}.xz" > "${IMG##*/}.xz.sha256"
ls -la /out
'
