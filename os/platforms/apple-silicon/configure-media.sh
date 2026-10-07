#!/bin/bash
set -euo pipefail

# Runs only inside KIWI's disposable root; no live-machine configuration.
test -f /.kconfig
test -f /usr/share/harness-installer/media.json
test -f /usr/share/harness-installer/payload.raw

printf 'uninitialized\n' > /etc/machine-id
printf 'harness\n' > /etc/hostname
rm -f /var/lib/systemd/random-seed /etc/ssh/ssh_host_*_key /etc/reconfigSys
usermod -L root

# Removable media must not maintain the internal Asahi ESP or initialize an
# installed OS. Firmware loading in dracut-asahi remains upstream-owned.
rm -rf /boot/efi/m1n1
rm -f /boot/efi/.builder
systemctl mask getty@.service serial-getty@.service sshd.service \
    systemd-firstboot.service first-boot.service initial-setup.service \
    asahi-setup-swap-firstboot.service asahi-extras-firstboot.service
systemctl enable harness-installer.service
systemctl set-default multi-user.target

mkdir -p /etc/dracut.conf.d
printf 'hostonly="no"\nadd_drivers+=" virtio_input "\n' > /etc/dracut.conf.d/20-harness-installer.conf
printf 'KEYMAP=us\nFONT=eurlatgr\n' > /etc/vconsole.conf
sed -i 's/^SELINUX=.*/SELINUX=enforcing/' /etc/selinux/config
sed -i 's/DEFAULTKERNEL=kernel-core/DEFAULTKERNEL=kernel-16k-core/' /etc/sysconfig/kernel
rpm --import /etc/pki/rpm-gpg/RPM-GPG-KEY-fedora-44-primary

# Use the verified installed image's policy before the live kernel ever reads
# source labels. Unknown types would otherwise be copied as unlabeled_t.
# Move whole trees after RPM transactions so no stale live-only modules remain.
policy=/usr/share/harness-installer/policy
test -f "$policy/etc/selinux/targeted/contexts/files/file_contexts"
test -f "$policy/var/lib/selinux/targeted/active/policy.kern"
rm -rf /etc/selinux/targeted /var/lib/selinux/targeted
mv "$policy/etc/selinux/targeted" /etc/selinux/targeted
mv "$policy/var/lib/selinux/targeted" /var/lib/selinux/targeted
rm -rf "$policy"
