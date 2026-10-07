#!/usr/bin/env bash
# Same pinned native compiler for images and standalone update packages.
set -euo pipefail
SOURCE_ROOT=$(cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$SOURCE_ROOT"
COMPOSITOR_OUTPUT=${1:?Pass a fresh checkout-relative output directory}
[[ $COMPOSITOR_OUTPUT != /* && $COMPOSITOR_OUTPUT != *..* ]] || exit 1
LOCK_SNAPSHOT=$(python3 -c 'import json; print(json.load(open("os/packaging/labwc/source.json"))["arch_snapshot"])')
docker run --rm -v "$SOURCE_ROOT:/source" -w /source \
    -e LOCK_SNAPSHOT="$LOCK_SNAPSHOT" -e COMPOSITOR_OUTPUT="$COMPOSITOR_OUTPUT" \
    archlinux:base-devel@sha256:51dd3d24f7fba779e7c471caeee7804c50e8c134ad948e19685a1c83a42facc3 \
    bash -euc '
      printf "Server = https://archive.archlinux.org/repos/%s/\$repo/os/\$arch\n" "$LOCK_SNAPSHOT" > /etc/pacman.d/mirrorlist
      pacman -Syu --noconfirm --needed labwc meson cmocka wayland-protocols glib2-devel xorg-xwayland python git
      python3 os/tools/build-compositor.py --output "$COMPOSITOR_OUTPUT"
    '
