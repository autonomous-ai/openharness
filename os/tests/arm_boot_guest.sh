#!/usr/bin/env bash
# PID 1 in a private QEMU test disk; never installed on a user's computer.
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
exec </dev/console >/dev/console 2>&1
set -u
finish() {
    status=$?
    trap - EXIT
    set +e
    printf '\nHARNESS_ARM_BOOT_EXIT=%s\n' "$status"
    sync
    /bin/busybox poweroff -f
    while true; do sleep 10; done
}
trap finish EXIT
set -e
mkdir -p /proc /sys /run /dev/pts /dev/shm
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t tmpfs -o mode=0755 tmpfs /run
mount -t devpts devpts /dev/pts
mount -t tmpfs -o mode=1777 tmpfs /dev/shm
printf harness > /proc/sys/kernel/hostname
test "$(uname -m)" = aarch64
test "$(uname -r)" = "$(cat /etc/harness-test-kernel)"
test "$(getconf PAGESIZE)" = 16384
printf 'HARNESS_ARM_KERNEL=%s PAGESIZE=%s\n' "$(uname -r)" "$(getconf PAGESIZE)"
modprobe virtio_net
ip link set lo up
ip link set eth0 up
ip address add 10.0.2.15/24 dev eth0
ip route add default via 10.0.2.2
printf 'nameserver 10.0.2.3\n' > /etc/resolv.conf
python3 - <<'PY' > /results/boot.json
import json, os, platform
print(json.dumps({'architecture': platform.machine(), 'kernel': platform.release(),
                  'page_size': os.sysconf('SC_PAGE_SIZE'),
                  'uptime_seconds': float(open('/proc/uptime').read().split()[0])}, indent=2))
PY
setpriv --reuid=1000 --regid=1000 --clear-groups \
    env HOME=/home/me TERM=xterm-256color LANG=C.UTF-8 \
    python3 /opt/harness-native/os/tests/runtime_native.py \
    --runtime /opt/harness-native/runtime --architecture aarch64 \
    --source-commit "$(cat /etc/harness-test-source)" \
    --opencode /opt/harness-agent/node_modules/.bin/opencode \
    --output /results/native-runtime
