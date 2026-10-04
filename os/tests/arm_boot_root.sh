#!/usr/bin/env bash
# Build only the disposable test guest, inside its named container.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates git python3 tmux libutf8proc3 \
    procps kmod iproute2 util-linux passwd busybox-static
install -m 755 /inputs/node /usr/local/bin/node
install -m 755 /inputs/tmux /usr/local/bin/tmux
node --version
tmux -V
cp -a /inputs/modules /lib/
chown -R root:root /lib/modules
depmod -a "$(cat /inputs/kernel-release)"
cp -a /inputs/payload /opt/harness-native
cp -a /inputs/agent /opt/harness-agent
install -m 755 /inputs/guest-init /sbin/harness-test-init
cp /inputs/kernel-release /etc/harness-test-kernel
cp /inputs/source-commit /etc/harness-test-source
existing=$(getent passwd 1000 | cut -d: -f1 || true)
if [[ -n "$existing" ]]; then
    usermod --login me --home /home/me --move-home --shell /bin/bash "$existing"
else
    useradd --create-home --uid 1000 --shell /bin/bash me
fi
mkdir -p /results /dev/pts /dev/shm /run
chown 1000:1000 /results
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' > /results/userspace-packages.tsv
chmod 644 /results/userspace-packages.tsv
apt-get clean
rm -rf /var/lib/apt/lists/*
