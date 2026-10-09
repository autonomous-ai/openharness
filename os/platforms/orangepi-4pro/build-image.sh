#!/usr/bin/env bash
# Build a Harness SD image for Orange Pi 4 Pro from Orange Pi's official Debian 12 server image.
# Run as root on an aarch64 Debian 12 host (the board itself), after build-runtime.sh and
# build-compositor.sh, so the chroot runs natively and links against the same libraries.
# Usage: build-image.sh BASE.img RUNTIME_DIR OUTPUT.img
# Nothing from the build host's accounts (sign-ins, SSH keys, sources) enters the image.
set -euo pipefail
BASE=${1:?official Orangepi4pro_*_debian_bookworm_server_*.img}
RUNTIME=${2:?runtime directory from os/tools/build-runtime.sh}
OUT=${3:?output image}
SOURCE=$(cd -- "$(dirname -- "$0")/../../.." && pwd)
HERE=$SOURCE/os/platforms/orangepi-4pro
PREFIX=${HARNESS_WL_PREFIX:-/opt/harness-wl}
ACCOUNT=orangepi
[[ $EUID == 0 && $(uname -m) == aarch64 ]] || { echo 'Run as root on aarch64.' >&2; exit 1; }
[[ -x $PREFIX/bin/labwc ]] || { echo "Build the compositor first: $HERE/build-compositor.sh" >&2; exit 1; }
OPENCODE=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$SOURCE/os/packaging/fedora/opencode.lock.json")
MNT=$(mktemp -d)
LOOP=

cleanup() {
    set +e
    for m in dev/pts dev proc sys; do mountpoint -q "$MNT/$m" && umount "$MNT/$m"; done
    mountpoint -q "$MNT" && umount "$MNT"
    [[ -n $LOOP ]] && losetup -d "$LOOP"
    rmdir "$MNT"
}
trap cleanup EXIT

cp --sparse=always "$BASE" "$OUT"
truncate -s +3G "$OUT"
LOOP=$(losetup -fP --show "$OUT")
parted -s "$LOOP" resizepart 1 100%
partprobe "$LOOP"
e2fsck -fy "${LOOP}p1" >/dev/null || true
resize2fs "${LOOP}p1" >/dev/null
mount "${LOOP}p1" "$MNT"
for m in dev dev/pts proc sys; do mount --bind "/$m" "$MNT/$m"; done
# Network for the chroot; the image's own resolv.conf is restored afterwards.
mv "$MNT/etc/resolv.conf" "$MNT/etc/resolv.conf.harness" 2>/dev/null || true
cp -L /etc/resolv.conf "$MNT/etc/resolv.conf"
printf '#!/bin/sh\nexit 101\n' > "$MNT/usr/sbin/policy-rc.d"
chmod 755 "$MNT/usr/sbin/policy-rc.d"
curl -fsSL https://deb.nodesource.com/setup_22.x -o "$MNT/tmp/nodesource.sh"

chroot "$MNT" /bin/bash -euo pipefail <<'EOF'
export DEBIAN_FRONTEND=noninteractive LC_ALL=C
bash /tmp/nodesource.sh >/dev/null 2>&1
# Session tools from Debian 12, plus the runtime libraries of the private compositor build.
apt-get install -y -qq nodejs jq curl tmux python3 foot chromium dbus-user-session swayidle grim slurp \
    wl-clipboard xdg-desktop-portal-wlr xdg-utils fonts-dejavu fonts-noto-color-emoji fonts-noto-cjk \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 librsvg2-2 libxml2 libglib2.0-0 libpng16-16 \
    libmtdev1 libevdev2 libudev1 libseat1 libgbm1 libegl1 libgles2 hwdata >/dev/null
apt-get clean
EOF
mkdir -p "$MNT$PREFIX"
cp -a "$PREFIX/." "$MNT$PREFIX/"
rm -rf "$MNT$PREFIX/include" "$MNT$PREFIX/share/doc"
if chroot "$MNT" ldd "$PREFIX/bin/labwc" | grep 'not found'; then
    echo 'The compositor is missing a library in the image.' >&2
    exit 1
fi

HARNESS_WL_PREFIX=$PREFIX "$HERE/install-session.sh" "$MNT" "$RUNTIME" "$ACCOUNT"
# OpenCode, the version the ARM package pins; other agents install from hn when chosen.
chroot "$MNT" su - "$ACCOUNT" -c "npm_config_prefix=\$HOME/.local npm install -g --no-audit --no-fund opencode-ai@$OPENCODE >/dev/null 2>&1"
python3 - "$MNT/etc/harness-image.json" "$BASE" "$SOURCE" "$OPENCODE" <<'PY'
import json, subprocess, sys
from pathlib import Path
path, base, source, opencode = sys.argv[1:]
commit = subprocess.check_output(['git', '-c', f'safe.directory={source}', '-C', source, 'rev-parse', 'HEAD'], text=True).strip()
Path(path).write_text(json.dumps({'board': 'orangepi4pro', 'base': Path(base).name,
                                  'source_commit': commit, 'opencode': opencode}, indent=2) + '\n')
PY

# Leave no build-host state behind.
rm -f "$MNT/usr/sbin/policy-rc.d" "$MNT/etc/resolv.conf" "$MNT/tmp/nodesource.sh"
mv "$MNT/etc/resolv.conf.harness" "$MNT/etc/resolv.conf" 2>/dev/null || true
rm -rf "$MNT/root/.npm" "$MNT/home/$ACCOUNT/.npm"
for leftover in "home/$ACCOUNT/.ssh/authorized_keys" "home/$ACCOUNT/.harness" "root/.ssh/authorized_keys"; do
    [[ ! -e $MNT/$leftover ]] || { echo "Unexpected build-host state: $leftover" >&2; exit 1; }
done
chroot "$MNT" /usr/lib/harness/hn --version
chroot "$MNT" su - "$ACCOUNT" -c '$HOME/.local/bin/opencode --version'
chroot "$MNT" "$PREFIX/bin/labwc" --version
df -h "$MNT" | tail -1
