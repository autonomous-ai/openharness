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
mkdir -p "$BUILD_DIR/package/usr/lib/harness" "$BUILD_DIR/repo"
cp -a root/. "$BUILD_DIR/package/"
install -Dm 644 "$SOURCE_ROOT/LICENSE" "$BUILD_DIR/package/usr/share/licenses/harness-os/LICENSE"
cp installer.py "$BUILD_DIR/package/usr/lib/harness-os/install.py"
cp system.py "$BUILD_DIR/package/usr/lib/harness-os/system.py"
install -m 755 tools/hn-os "$BUILD_DIR/package/usr/bin/hn-os"
cp lock.json "$BUILD_DIR/package/usr/share/harness-os/lock.json"
install -m 755 "$RUNTIME_DIR/harness-tui" "$BUILD_DIR/package/usr/lib/harness/harness-tui"
install -m 644 "$RUNTIME_DIR/cli.js" "$BUILD_DIR/package/usr/lib/harness/cli.mjs"
install -m 644 "$RUNTIME_DIR/notify.mjs" "$BUILD_DIR/package/usr/lib/harness/notify.mjs"
ln -s harness-tui "$BUILD_DIR/package/usr/lib/harness/hn"
python3 - "$BUILD_DIR/package/usr/lib/harness" "$BUILD_DIR/package/usr/share/harness-os/runtime.json" "$RUNTIME_DIR/source.json" <<'PY'
import hashlib, json, os, sys
from pathlib import Path
root = Path(sys.argv[1])
data = json.loads(Path(sys.argv[3]).read_text())
if data['dirty'] or (os.environ.get('HARNESS_OS_SOURCE_SHA') and data['source_commit'] != os.environ['HARNESS_OS_SOURCE_SHA']):
    raise SystemExit('OS runtime must be built from the same clean source commit as the image.')
data.update(mode='source', files={})
for path in root.iterdir():
    if path.is_file() and not path.is_symlink():
        with path.open('rb') as handle:
            data['files'][path.name] = {'sha256': hashlib.file_digest(handle, 'sha256').hexdigest(), 'bytes': path.stat().st_size}
Path(sys.argv[2]).write_text(json.dumps(data, indent=2) + '\n')
PY
find "$BUILD_DIR/package/usr/bin" "$BUILD_DIR/package/usr/lib/harness-os" -type f -exec chmod 755 {} +
chmod 755 "$BUILD_DIR/package/usr/share/harness-os/labwc/"{autostart,shutdown}
cat > "$BUILD_DIR/package/.PKGINFO" <<EOF
pkgname = harness-os
pkgbase = harness-os
pkgver = 0.1.0-1
pkgdesc = Programmer OS session and verified Harness runtime
url = https://github.com/autonomous-ai/openharness
builddate = ${SOURCE_DATE_EPOCH:-$(date +%s)}
packager = OpenHarness
size = $(du -sb "$BUILD_DIR/package" | cut -f1)
arch = x86_64
license = MIT
depend = nodejs-lts-jod
depend = tmux
depend = foot
depend = labwc
EOF
bsdtar --zstd -cf "$BUILD_DIR/repo/harness-os-0.1.0-1-x86_64.pkg.tar.zst" -C "$BUILD_DIR/package" .PKGINFO etc usr
repo-add "$BUILD_DIR/repo/harness-build.db.tar.gz" "$BUILD_DIR/repo/"*.pkg.tar.zst
cp -a live/. "$PROFILE/airootfs/"
mkdir -p "$PROFILE/airootfs/root" "$PROFILE/airootfs/etc/pacman.d/hooks"
cp tools/customize-live.sh "$PROFILE/airootfs/root/setup-live.sh"
cat > "$PROFILE/airootfs/etc/pacman.d/hooks/99-harness-live.hook" <<'EOF'
[Trigger]
Operation = Install
Type = Package
Target = harness-os
[Action]
Description = Preparing the Programmer OS live session
When = PostTransaction
Exec = /bin/bash /root/setup-live.sh
EOF
cat >> "$PROFILE/profiledef.sh" <<EOF

iso_name="programmer-os"
iso_label="HN_OS"
iso_publisher="OpenHarness"
iso_application="Programmer OS: boot into hn"
iso_version="$VERSION"
airootfs_image_type="squashfs"
airootfs_image_tool_options=("-comp" "zstd" "-Xcompression-level" "6" "-b" "1M")
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
            s = s.replace('Arch Linux install medium', 'Programmer OS - try or install')
            # Keep a short opportunity to choose recovery media or firmware tools.
            s = re.sub(r'(?m)^timeout(?:=|\s+)\d+', lambda m: 'timeout=1' if '=' in m[0] else 'timeout 1', s)
            s = re.sub(r'(?m)^TIMEOUT\s+\d+', 'TIMEOUT 10', s)  # Syslinux uses tenths of a second.
            s = re.sub(r'(?m)^beep on$', 'beep off', s)
            s = re.sub(r'(?m)^play .*$', '', s)
            s = s.replace('MENU TITLE Arch Linux', 'MENU TITLE Programmer OS')
            s = re.sub(r'(?m)^MENU BACKGROUND .*\n', '', s)
            f.write_text(s)
PY
mkarchiso -v -w "$BUILD_DIR/archiso" -o "$OS_DIR/dist" "$PROFILE"
python3 tools/manifest.py "$OS_DIR/dist" "$BUILD_DIR/archiso/x86_64/airootfs"
python3 tools/inspect.py "$OS_DIR/dist/"*.iso
