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
COMPOSITOR_DIR=${HARNESS_OS_COMPOSITOR_DIR:-$OS_DIR/work/compositor}
PLATFORM=${HARNESS_OS_PLATFORM:-pc}
[[ $PLATFORM == pc || $PLATFORM == apple-t2 ]] || { echo 'Unknown OS boot platform.' >&2; exit 1; }
[[ -s "$RUNTIME_DIR/source.json" && -x "$RUNTIME_DIR/harness-tui" ]] || {
    echo 'Build the OS runtimes first with make -C os runtime on x86_64 Linux.' >&2
    exit 1
}
[[ -s "$COMPOSITOR_DIR/manifest.json" && -x "$COMPOSITOR_DIR/labwc" ]] || {
    echo 'Build the compositor first with make -C os compositor.' >&2
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
python3 tools/build-package.py --runtime "$RUNTIME_DIR" --compositor "$COMPOSITOR_DIR" --output "$BUILD_DIR/repo" --development
PROFILE_ARGS=(--profile "$PROFILE" --platform "$PLATFORM")
if [[ $PLATFORM == apple-t2 ]]; then
    [[ -n ${HARNESS_OS_T2_BUNDLE:-} ]] || { echo 'Prepare the pinned T2 kernel bundle first.' >&2; exit 1; }
    PROFILE_ARGS+=(--t2-bundle "$HARNESS_OS_T2_BUNDLE")
fi
python3 tools/configure-boot-profile.py "${PROFILE_ARGS[@]}"
REPO_PACKAGES=("$BUILD_DIR/repo/"*.pkg.tar.gz)
if [[ $PLATFORM == apple-t2 ]]; then
    REPO_PACKAGES+=("$BUILD_DIR/repo/"*.pkg.tar.zst)
fi
repo-add "$BUILD_DIR/repo/harness-build.db.tar.gz" "${REPO_PACKAGES[@]}"
if [[ $PLATFORM == pc ]]; then
  python3 tools/build-hardware.py --config "$PROFILE/pacman.conf" \
    --work "$BUILD_DIR/hardware-build" \
    --output "$PROFILE/airootfs/usr/share/harness-os/hardware/broadcom"
  python3 tools/build-nvidia.py --config "$PROFILE/pacman.conf" \
    --work "$BUILD_DIR/nvidia-build" \
    --output "$PROFILE/airootfs/usr/share/harness-os/hardware/nvidia"
fi
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

iso_name="$([[ $PLATFORM == apple-t2 ]] && echo harness-t2 || echo harness)"
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
chown -R 0:0 "$PROFILE/airootfs"
mkarchiso -v -w "$BUILD_DIR/archiso" -o "$OS_DIR/dist" "$PROFILE"
python3 tools/manifest.py "$OS_DIR/dist" "$BUILD_DIR/archiso/x86_64/airootfs"
python3 tools/inspect_image.py "$OS_DIR/dist/"*.iso
