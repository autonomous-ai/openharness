#!/bin/bash
# Build only inside a disposable, unprivileged ARM Fedora container.
# This is a VM fixture, not an installer for a person's computer.
set -euo pipefail
test -f /.dockerenv
test "$(uname -m)" = aarch64
test -f /inputs/overlay/usr/share/harness-os/runtime.json
manager=$(command -v dnf5 || command -v microdnf)
"$manager" install -y --setopt=install_weak_deps=False --setopt=gpgcheck=True --nodocs \
  systemd systemd-udev systemd-pam systemd-resolved dbus-broker dbus-tools \
  NetworkManager sudo python3 shadow-utils util-linux procps-ng kmod iproute \
  labwc xorg-x11-server-Xwayland foot chromium mesa-dri-drivers \
  pipewire pipewire-pulseaudio wireplumber swayidle swaylock brightnessctl \
  wl-clipboard xdg-utils xdg-desktop-portal-wlr dejavu-sans-mono-fonts \
  google-noto-color-emoji-fonts cascadia-mono-nf-fonts \
  nodejs22 nodejs22-bin nodejs22-npm nodejs22-npm-bin tmux git curl jq ripgrep less which unzip
"$manager" clean all
cp -a --no-preserve=ownership /inputs/overlay/. /
cp -a --no-preserve=ownership /inputs/modules /usr/lib/
depmod -a "$(cat /inputs/kernel-release)"
npm install --prefix /opt/harness-agent --no-audit --no-fund opencode-ai
ln -s /opt/harness-agent/node_modules/.bin/opencode /usr/bin/opencode
opencode --version
useradd --create-home --uid 1000 --groups wheel --shell /bin/bash me
# The empty password belongs only to this test disk and its local QEMU console.
# There is no SSH server, public listener, or host disk attached to the VM.
passwd -d me
printf 'harness\n' > /etc/hostname
printf '127.0.0.1 localhost\n127.0.1.1 harness\n::1 localhost\n' > /etc/hosts
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin me --noclear %I $TERM
EOF
mkdir -p /usr/local/lib/harness-test
cat > /usr/local/lib/harness-test/console <<'EOF'
#!/bin/bash
export PS1='HARNESS_ARM_CONSOLE> '
exec /bin/bash --noprofile --norc -i
EOF
chmod 755 /usr/local/lib/harness-test/console
cat > /etc/systemd/system/harness-test-console.service <<'EOF'
[Unit]
Description=Private QEMU test console
After=systemd-user-sessions.service
Conflicts=serial-getty@ttyAMA0.service
[Service]
ExecStart=/usr/local/lib/harness-test/console
StandardInput=tty
StandardOutput=tty
StandardError=tty
TTYPath=/dev/ttyAMA0
TTYReset=yes
TTYVHangup=yes
# Interactive bash ignores SIGTERM. End this private console like a getty,
# rather than delaying guest shutdown until systemd's service timeout.
KillSignal=SIGHUP
Restart=always
[Install]
WantedBy=multi-user.target
EOF
systemctl mask serial-getty@ttyAMA0.service
systemctl enable getty@tty1.service harness-test-console.service NetworkManager.service systemd-resolved.service
systemctl set-default multi-user.target
mkdir -p /etc/modules-load.d
printf 'virtio_net\nvirtio_gpu\nvirtio_input\n' > /etc/modules-load.d/harness-test.conf
truncate -s 0 /etc/machine-id
rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\t%{ARCH}\n' | sort > /harness-packages.tsv
# Docker replaces these files with host bind mounts. The exported root's copies
# are repaired by the host builder before a fresh regular-file disk is made.
