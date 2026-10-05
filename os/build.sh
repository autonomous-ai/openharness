#!/usr/bin/env bash
# Build on x86_64 Arch Linux as root (the workflow uses an isolated container).
set -euo pipefail
OS_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
[[ $(uname -m) == x86_64 && $EUID == 0 ]] || { echo 'Build requires x86_64 Linux and root.' >&2; exit 1; }
cd "$OS_DIR"
SOURCE_ROOT=$(cd "$OS_DIR/.." && pwd)
[[ -z $(git -c safe.directory="$SOURCE_ROOT" -C "$SOURCE_ROOT" status --porcelain --untracked-files=normal) ]] || {
    echo 'Commit source changes before building a traceable OS image.' >&2
    exit 1
}
export HARNESS_OS_SOURCE_SHA=${HARNESS_OS_SOURCE_SHA:-$(git -c safe.directory="$SOURCE_ROOT" -C "$SOURCE_ROOT" rev-parse HEAD)}
VERSION=$(python3 -c 'import json; print(json.load(open("lock.json"))["version"])')
SNAPSHOT=$(python3 -c 'import json; print(json.load(open("lock.json"))["arch_snapshot"])')
BUILD_DIR=${HARNESS_OS_BUILD_DIR:-$OS_DIR/work}
RUNTIME_DIR=${HARNESS_OS_RUNTIME_DIR:-$OS_DIR/work/runtime}
[[ -s "$RUNTIME_DIR/source.json" && -x "$RUNTIME_DIR/harness-tui" ]] || {
    echo 'Build the OS runtimes first with make -C os runtime on x86_64 Linux.' >&2
    exit 1
}
mkdir -p "$BUILD_DIR" "$OS_DIR/dist"
[[ ! -e "$BUILD_DIR/profile" ]] || { echo 'Use a fresh build directory; refusing to reuse an incomplete image.' >&2; exit 1; }
cp -a /usr/share/archiso/configs/releng "$BUILD_DIR/profile"
PROFILE="$BUILD_DIR/profile"
# The source profile supplies the upstream BIOS/UEFI boot machinery only.
rm -rf "$PROFILE/airootfs"
mkdir -p "$PROFILE/airootfs"
cp packages.x86_64 "$PROFILE/packages.x86_64"
cat > "$PROFILE/pacman.conf" <<EOF
[options]
Architecture = auto
CheckSpace
ParallelDownloads = 8
SigLevel = Required DatabaseOptional
LocalFileSigLevel = Optional
[harness-build]
SigLevel = Optional TrustAll
Server = file://$BUILD_DIR/repo
[core]
Server = https://archive.archlinux.org/repos/$SNAPSHOT/\$repo/os/\$arch
[extra]
Server = https://archive.archlinux.org/repos/$SNAPSHOT/\$repo/os/\$arch
EOF
# Reuse the same package assembly for fresh images and small development updates.
# Use the same source-versioned identity as its update-channel package. An ISO
# installation should not immediately be offered this identical build again.
python3 tools/build-package.py --runtime "$RUNTIME_DIR" --output "$BUILD_DIR/repo" --development
repo-add "$BUILD_DIR/repo/harness-build.db.tar.gz" "$BUILD_DIR/repo/"*.pkg.tar.gz
python3 tools/build-hardware.py --config "$PROFILE/pacman.conf" \
    --work "$BUILD_DIR/hardware-build" \
    --output "$PROFILE/airootfs/usr/share/harness-os/hardware/broadcom"
python3 tools/build-nvidia.py --config "$PROFILE/pacman.conf" \
    --work "$BUILD_DIR/nvidia-build" \
    --output "$PROFILE/airootfs/usr/share/harness-os/hardware/nvidia"
cp -a live/. "$PROFILE/airootfs/"
mkdir -p "$PROFILE/airootfs/root" "$PROFILE/airootfs/etc/pacman.d/hooks"
cp tools/customize-live.sh "$PROFILE/airootfs/root/setup-live.sh"
cat > "$PROFILE/airootfs/etc/pacman.d/hooks/99-harness-live.hook" <<'EOF'
[Trigger]
Operation = Install
Type = Package
Target = harness-os
[Action]
Description = Preparing the Harness live session
When = PostTransaction
Exec = /bin/bash /root/setup-live.sh
EOF
cat >> "$PROFILE/profiledef.sh" <<EOF

iso_name="harness"
iso_label="HN_OS"
iso_publisher="OpenHarness"
iso_application="Harness: boot into hn"
iso_version="$VERSION"
airootfs_image_type="squashfs"
# Match the measured compression profile and bound builder CPU/cache use.
airootfs_image_tool_options=("-comp" "zstd" "-Xcompression-level" "19" "-b" "1M" "-processors" "2" "-mem" "1G")
file_permissions=(
  ["/root"]="0:0:750"
)
EOF
# Use the same LTS kernel in the live USB and on disk.
python3 - "$PROFILE" <<'PY'
from pathlib import Path
import re, sys
p = Path(sys.argv[1])
for d in ['syslinux', 'efiboot', 'grub']:
    for f in (p / d).rglob('*'):
        if f.is_file():
            try: s = f.read_text()
            except UnicodeDecodeError: continue
            s = s.replace('vmlinuz-linux', 'vmlinuz-linux-lts').replace('initramfs-linux.img', 'initramfs-linux-lts.img')
            s = s.replace('Arch Linux install medium', 'Install Harness')
            # The 256 MiB Archiso default cannot install even one current agent.
            # tmpfs grows on demand; this is a ceiling, not reserved memory.
            s = s.replace('archisobasedir=%INSTALL_DIR%', 'archisobasedir=%INSTALL_DIR% cow_spacesize=50%')
            # Keep a short opportunity to choose recovery media or firmware tools.
            s = re.sub(r'(?m)^timeout(?:=|\s+)\d+', lambda m: 'timeout=1' if '=' in m[0] else 'timeout 1', s)
            s = re.sub(r'(?m)^TIMEOUT\s+\d+', 'TIMEOUT 10', s)  # Syslinux uses tenths of a second.
            s = re.sub(r'(?m)^beep on$', 'beep off', s)
            s = re.sub(r'(?m)^play .*$', '', s)
            s = s.replace('MENU TITLE Arch Linux', 'MENU TITLE Harness')
            s = re.sub(r'(?m)^MENU BACKGROUND .*\n', '', s)
            f.write_text(s)
PY
chown -R 0:0 "$PROFILE/airootfs"
mkarchiso -v -w "$BUILD_DIR/archiso" -o "$OS_DIR/dist" "$PROFILE"
python3 tools/manifest.py "$OS_DIR/dist" "$BUILD_DIR/archiso/x86_64/airootfs"
python3 tools/inspect_image.py "$OS_DIR/dist/"*.iso
