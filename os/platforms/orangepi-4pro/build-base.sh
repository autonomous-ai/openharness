#!/usr/bin/env bash
# Phase 1: the base image, which changes rarely. Orange Pi's official Debian 12 server image,
# grown by 3 GB, with Debian's session packages, Node 22 and the private compositor build.
# Phase 2 (build-image.sh) adds Harness itself to a copy of it.
# Run as root on an aarch64 Debian 12 host, after build-compositor.sh.
# Usage: build-base.sh BASE.img OUTPUT_BASE.img [KEY]   (KEY from base-key.sh, recorded)
set -euo pipefail
BASE=${1:?official Orangepi4pro_*_debian_bookworm_server_*.img}
OUT=${2:?output base image}
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
KEY=${3:-$("$HERE/base-key.sh" "$BASE")}
PREFIX=${HARNESS_WL_PREFIX:-/opt/harness-wl}
[[ $EUID == 0 && $(uname -m) == aarch64 ]] || { echo 'Run as root on aarch64.' >&2; exit 1; }
[[ -x $PREFIX/bin/labwc ]] || { echo "Build the compositor first: $HERE/build-compositor.sh" >&2; exit 1; }
source "$HERE/image-lib.sh"

PARTIAL=$OUT.partial
cp --sparse=always "$BASE" "$PARTIAL"
attach_image "$PARTIAL" +3G
curl -fsSL https://deb.nodesource.com/setup_22.x -o "$MNT/tmp/nodesource.sh"
chroot "$MNT" /bin/bash -euo pipefail <<'EOF'
export DEBIAN_FRONTEND=noninteractive LC_ALL=C
bash /tmp/nodesource.sh >/dev/null 2>&1
rm -f /tmp/nodesource.sh
# Session tools from Debian 12, plus the runtime libraries of the private compositor build.
apt-get install -y -qq nodejs jq curl tmux python3 foot chromium dbus-user-session swayidle grim slurp \
    wl-clipboard xdg-desktop-portal-wlr xdg-utils fonts-dejavu fonts-noto-color-emoji fonts-noto-cjk \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 librsvg2-2 libxml2 libglib2.0-0 libpng16-16 \
    libmtdev1 libevdev2 libudev1 libseat1 libgbm1 libegl1 libgles2 hwdata >/dev/null
apt-get clean
rm -rf /root/.npm
EOF
mkdir -p "$MNT$PREFIX"
cp -a "$PREFIX/." "$MNT$PREFIX/"
rm -rf "$MNT$PREFIX/include" "$MNT$PREFIX/share/doc"
if chroot "$MNT" ldd "$PREFIX/bin/labwc" | grep 'not found'; then
    echo 'The compositor is missing a library in the image.' >&2
    exit 1
fi
chroot "$MNT" "$PREFIX/bin/labwc" --version
printf '{\n  "board": "orangepi4pro",\n  "base": "%s",\n  "base_key": "%s"\n}\n' "$(basename -- "$BASE")" "$KEY" \
    > "$MNT/etc/harness-base.json"
release_image
mv "$PARTIAL" "$OUT"
echo "$OUT ($KEY)"
