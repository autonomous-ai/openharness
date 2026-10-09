# Shared by build-base.sh and build-image.sh: attach an SD image, mount its root partition
# and prepare a chroot with network. Source it; it sets MNT and an EXIT trap that undoes it.

MNT=$(mktemp -d)
LOOP=
MADE_NODE=

release_image() {
    set +e
    if [[ -e $MNT/usr/sbin/policy-rc.d.harness ]]; then
        rm -f "$MNT/usr/sbin/policy-rc.d" "$MNT/usr/sbin/policy-rc.d.harness"
    fi
    if [[ -n $RESOLV ]]; then
        rm -f "$MNT/etc/resolv.conf"
        if [[ -e $MNT/etc/resolv.conf.harness || -L $MNT/etc/resolv.conf.harness ]]; then
            mv "$MNT/etc/resolv.conf.harness" "$MNT/etc/resolv.conf"
        fi
    fi
    for m in dev/pts dev proc sys; do mountpoint -q "$MNT/$m" && umount "$MNT/$m"; done
    mountpoint -q "$MNT" && umount "$MNT"
    [[ -n $LOOP ]] && losetup -d "$LOOP"
    [[ -n $MADE_NODE ]] && rm -f "$MADE_NODE"
    rmdir "$MNT" 2>/dev/null
    LOOP=
    MADE_NODE=
    RESOLV=
}
RESOLV=
trap release_image EXIT

# attach_image IMAGE [GROW]: GROW (e.g. +3G) enlarges the file and its root filesystem first.
attach_image() {
    local image=$1 grow=${2:-} part
    [[ -z $grow ]] || truncate -s "$grow" "$image"
    LOOP=$(losetup -fP --show "$image")
    [[ -z $grow ]] || parted -s "$LOOP" resizepart 1 100%
    partprobe "$LOOP" || true
    part=${LOOP}p1
    if [[ ! -b $part ]]; then
        # A container (build-docker.sh) has no udev to create partition nodes.
        local major minor
        IFS=: read -r major minor < "/sys/class/block/${LOOP#/dev/}p1/dev"
        mknod "$part" b "$major" "$minor"
        MADE_NODE=$part
    fi
    if [[ -n $grow ]]; then
        e2fsck -fy "$part" >/dev/null || true
        resize2fs "$part" >/dev/null
    fi
    mount "$part" "$MNT"
    for m in dev dev/pts proc sys; do mount --bind "/$m" "$MNT/$m"; done
    # Network for the chroot, and no service starts from package scripts; both undone on release.
    if [[ -e $MNT/etc/resolv.conf || -L $MNT/etc/resolv.conf ]]; then
        mv "$MNT/etc/resolv.conf" "$MNT/etc/resolv.conf.harness"
    fi
    RESOLV=1
    cp -L /etc/resolv.conf "$MNT/etc/resolv.conf"
    [[ ! -e $MNT/usr/sbin/policy-rc.d ]] || { echo 'The image already has a policy-rc.d.' >&2; return 1; }
    printf '#!/bin/sh\nexit 101\n' > "$MNT/usr/sbin/policy-rc.d"
    chmod 755 "$MNT/usr/sbin/policy-rc.d"
    touch "$MNT/usr/sbin/policy-rc.d.harness"
}
