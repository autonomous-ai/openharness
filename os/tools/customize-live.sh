#!/bin/bash
set -euo pipefail
# Validate with the exact terminal version being shipped, before compressing it.
foot --check-config --config=/usr/share/harness-os/foot.ini
echo 'en_US.UTF-8 UTF-8' > /etc/locale.gen
locale-gen
echo 'LANG=en_US.UTF-8' > /etc/locale.conf
echo programmer-live > /etc/hostname
ln -sf /usr/share/zoneinfo/UTC /etc/localtime
ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
useradd -m -G wheel,video,audio -s /bin/bash programmer
passwd -d programmer
passwd -d root
mkdir -p /etc/sudoers.d /home/programmer/Projects /etc/systemd/system/getty@tty1.service.d
echo 'programmer ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/10-live
chmod 440 /etc/sudoers.d/10-live
chown programmer:programmer /home/programmer/Projects
systemctl enable NetworkManager systemd-resolved systemd-timesyncd getty@tty1.service
systemctl enable harness-keyring.service
# hn-screen starts the daemon after labwc has published the display environment.
# Linger keeps that runtime alive if its graphical client is restarted.
mkdir -p /var/lib/systemd/linger
touch /var/lib/systemd/linger/programmer
# Agent auth and browser downloads never block boot. No SSH listener by default.
systemctl disable NetworkManager-wait-online.service || true
systemctl mask systemd-networkd.service systemd-networkd-wait-online.service
ln -sf /usr/lib/systemd/system/multi-user.target /etc/systemd/system/default.target
printf '[Service]\nExecStart=\nExecStart=-/usr/bin/agetty --autologin programmer --noclear %%I $TERM\n' > /etc/systemd/system/getty@tty1.service.d/autologin.conf
# A serial console is useful for recovering a live USB; never carried into the install.
mkdir -p /etc/systemd/system/serial-getty@ttyS0.service.d
printf '[Service]\nExecStart=\nExecStart=-/usr/bin/agetty --autologin root --noclear %%I 115200\n' > /etc/systemd/system/serial-getty@ttyS0.service.d/live.conf
systemctl enable serial-getty@ttyS0.service
python3 - <<'PY'
import hashlib, json
from pathlib import Path
lock = json.loads(Path('/usr/share/harness-os/lock.json').read_text())
snapshot = lock['arch_snapshot']
Path('/etc/pacman.conf').write_text(
    '[options]\nArchitecture = auto\nCheckSpace\nSigLevel = Required DatabaseOptional\nLocalFileSigLevel = Optional\n' +
    ''.join(f'[{repo}]\nServer = https://archive.archlinux.org/repos/{snapshot}/$repo/os/$arch\n' for repo in ['core', 'extra']))
# archiso removes /boot from SquashFS after placing boot files on the ISO.
# Keep the exact package-owned kernel location for an offline disk install.
kernels = [p.parent / 'vmlinuz' for p in Path('/usr/lib/modules').glob('*/pkgbase') if p.read_text().strip() == 'linux-lts']
if len(kernels) != 1 or not kernels[0].is_file():
    raise SystemExit('Expected one package-owned LTS kernel for the installer.')
kernel = kernels[0]
with kernel.open('rb') as handle:
    digest = hashlib.file_digest(handle, 'sha256').hexdigest()
Path('/usr/share/harness-os/kernel.json').write_text(json.dumps({'path': str(kernel.relative_to('/')), 'sha256': digest}) + '\n')
PY
pacman -Q > /usr/share/harness-os/packages.txt
rm -rf /var/cache/pacman/pkg/* /root/.cache
