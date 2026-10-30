#!/usr/bin/env python3
"""An encrypted Harness unlocked from a "phone" over its setup hotspot, as it starts.

The image installs encrypted in a VM with two simulated Wi-Fi radios (mac80211_hwsim). One is the
computer's card: its startup hosts Harness-XXXX on it (harness-unlock). The other is the phone, in
a network namespace of its own so nothing reaches the computer but over the air: it joins the
hotspot, gets an address from it, reads /setup, sends a wrong password, then the right one. The
computer must then start, with nobody at its screen.

    python3 tests/unlock_vm.py --iso dist/harness-….iso [--output folder]
"""
import argparse
import base64
import json
from pathlib import Path
import shlex
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vm import VM  # noqa: E402

PASSWORD = 'test-password-123'

# The phone, in the computer's startup: a test-only mkinitcpio hook beside harness-unlock.
HOOK = '''#!/bin/bash
build() {
    add_file /usr/lib/harness-os/unlock-test/phone /usr/lib/harness-os/unlock-test/phone 755
    add_file /usr/lib/harness-os/unlock-test/udhcpc /usr/lib/harness-os/unlock-test/udhcpc 755
    add_file /usr/lib/harness-os/unlock-test/password /usr/lib/harness-os/unlock-test/password 600
    add_file /usr/lib/harness-os/unlock-test/phone.service /usr/lib/systemd/system/harness-unlock-phone.service 644
    add_symlink /usr/lib/systemd/system/initrd.target.wants/harness-unlock-phone.service ../harness-unlock-phone.service
    add_file /etc/modprobe.d/hwsim.conf
}
'''

PHONE = r'''#!/bin/sh
say() { echo "HN_PHONE $*" > /dev/ttyS0; }
for _ in $(seq 90); do [ -f /run/harness-unlock/tcpsvd.pid ] && break; sleep 1; done
ap=$(cat /run/harness-unlock/device 2>/dev/null); name=$(cat /run/harness-unlock/name 2>/dev/null)
say "hotspot ${name:-none} on ${ap:-none}"
dev=
for path in /sys/class/net/*; do
    [ -d "$path/wireless" ] && [ "${path##*/}" != "$ap" ] && dev=${path##*/}
done
phy=$(cat "/sys/class/net/$dev/phy80211/name")
unshare -n sleep 100000 &
holder=$!
sleep 1
iw phy "$phy" set netns "$holder"
on() { nsenter -t "$holder" -n "$@"; }
on ip link set lo up
on ip link set "$dev" up
printf 'network={\n    ssid="%s"\n    key_mgmt=NONE\n    scan_ssid=1\n}\n' "$name" > /run/phone.conf
on wpa_supplicant -B -i "$dev" -c /run/phone.conf
for _ in $(seq 40); do on iw dev "$dev" link | grep -q 'Connected to' && break; sleep 1; done
say "link $(on iw dev "$dev" link | head -1)"
on udhcpc -i "$dev" -n -q -t 10 -s /usr/lib/harness-os/unlock-test/udhcpc >/dev/null 2>&1
say "address $(on ip -4 addr show dev "$dev" | grep -o 'inet [0-9./]*')"
say "route $(on ip route get 10.42.0.1 | head -1)"
say "setup $(on wget -q -T 10 -O - http://10.42.0.1/setup 2>&1)"
say "wrong $(on wget -q -T 60 -O - --post-data=not-the-password http://10.42.0.1/setup/unlock 2>&1)"
say "right $(on wget -q -T 60 -O - --post-data="$(cat /usr/lib/harness-os/unlock-test/password)" http://10.42.0.1/setup/unlock 2>&1)"
'''

UDHCPC = '''#!/bin/sh
case $1 in bound|renew) ip addr add "$ip/${mask:-24}" dev "$interface" ;; esac
'''

UNIT = '''[Unit]
Description=Test phone unlocking this computer over its setup hotspot
DefaultDependencies=no
After=harness-unlock.service
Conflicts=initrd-switch-root.target
Before=initrd-switch-root.target

[Service]
Type=simple
ExecStart=/usr/lib/harness-os/unlock-test/phone
ExecStop=/bin/sh -c 'sleep 3'
'''


def put(vm, path, text, mode='644'):
    data = base64.b64encode(text.encode()).decode()
    vm.command(f': > {shlex.quote(path)}.b64')
    for start in range(0, len(data), 1500):
        vm.command(f"printf %s {shlex.quote(data[start:start + 1500])} >> {shlex.quote(path)}.b64")
    vm.command(f'base64 -d {shlex.quote(path)}.b64 > {shlex.quote(path)} && rm {shlex.quote(path)}.b64 && chmod {mode} {shlex.quote(path)}')


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--iso', required=True, type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--memory', type=int, default=4096)
    parser.add_argument('--video', choices=['virtio-vga', 'VGA'], default='virtio-vga')
    args = parser.parse_args()
    folder = (args.output or Path.cwd() / 'unlock-vm-results').resolve()
    folder.mkdir(parents=True, exist_ok=False)
    result = dict(iso=str(args.iso), checks=[], status='running', started_at_unix=time.time())
    vm = VM(folder, args.iso.resolve(), 'bios', args.memory, video=args.video)
    try:
        vm.start(live=True)
        vm.monitor('set_link', name='hnnet', up=False)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=300)
        vm.shell_ready = True
        vm.command('stty -echo')
        # The computer's card and the phone, both simulated; loaded here, so the startup that the
        # installer builds takes the driver as it takes a real card's (harness-unlock).
        vm.command('modprobe mac80211_hwsim radios=2 && nmcli networking off')
        config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda', username='me', hostname='harness',
                      password=PASSWORD, encrypt=True, serial_console=True)
        put(vm, '/run/hn-config.json', json.dumps(config), '600')
        vm.command('python3 /usr/lib/harness-os/install.py --config /run/hn-config.json --yes-erase-disk '
                   '> /run/hn-install.log 2>&1 || { tail -40 /run/hn-install.log; exit 1; }', timeout=2400)
        result['checks'].append('Unattended encrypted installation')
        # The installed startup, plus the test phone.
        vm.command(f'printf %s {shlex.quote(PASSWORD)} | cryptsetup open /dev/vda3 hnroot -d - '
                   '&& mount -o subvol=@ /dev/mapper/hnroot /mnt && mount /dev/vda2 /mnt/boot')
        hooks, _ = vm.command("grep '^HOOKS' /mnt/etc/mkinitcpio.conf")
        assert 'block harness-unlock sd-encrypt' in hooks, hooks
        result['checks'].append('The installer put harness-unlock before sd-encrypt')
        args_line, _ = vm.command("grep -h 'rd.luks.options' /mnt/etc/default/grub")
        assert 'tries=0' in args_line, args_line
        vm.command('mkdir -p /mnt/usr/lib/harness-os/unlock-test')
        put(vm, '/mnt/usr/lib/initcpio/install/harness-unlock-test', HOOK)
        put(vm, '/mnt/usr/lib/harness-os/unlock-test/phone', PHONE, '755')
        put(vm, '/mnt/usr/lib/harness-os/unlock-test/udhcpc', UDHCPC, '755')
        put(vm, '/mnt/usr/lib/harness-os/unlock-test/phone.service', UNIT)
        put(vm, '/mnt/usr/lib/harness-os/unlock-test/password', PASSWORD, '600')
        put(vm, '/mnt/etc/modprobe.d/hwsim.conf', 'options mac80211_hwsim radios=2\n')
        put(vm, '/mnt/etc/mkinitcpio.conf.d/90-unlock-test.conf', 'MODULES+=(mac80211_hwsim)\n')
        vm.command("sed -i 's/harness-unlock /harness-unlock harness-unlock-test /' /mnt/etc/mkinitcpio.conf")
        vm.command('arch-chroot /mnt mkinitcpio -P > /run/hn-mkinitcpio.log 2>&1 || { tail -30 /run/hn-mkinitcpio.log; exit 1; }',
                   timeout=900)
        listing, _ = vm.command('lsinitcpio /mnt/boot/initramfs-linux-lts.img | grep -E "harness-unlock|mac80211_hwsim|wpa_supplicant|dnsmasq"')
        (folder / 'initramfs-listing.txt').write_text(listing)
        vm.command('sync; umount -R /mnt; cryptsetup close hnroot')
        vm.stop()

        # Nobody types at the screen: only the phone can open the disk.
        vm.start(live=False)
        started = time.monotonic()
        out = vm.wait(r'HN_PHONE wrong [^\r\n]*\r?\n', timeout=600)
        # Nobody types at the screen: reaching the login is the phone's password having opened the disk.
        out += vm.wait(r'login:', timeout=300)
        lines = [line.strip() for line in out.splitlines() if line.startswith('HN_PHONE')]
        result['phone'] = lines
        print('\n'.join(lines), flush=True)
        text = '\n'.join(lines)
        assert 'hotspot Harness-' in text, text
        assert 'link Connected to' in text, text
        assert 'address inet 10.42.0.' in text, text
        assert '"locked":true' in text, text
        assert '401' in text.split('wrong ', 1)[1].splitlines()[0], text
        assert 'right ' in text and '"state":"unlocked"' in text.split('right ', 1)[1], text
        result['checks'].append('The phone joined Harness-XXXX over the air, got an address and read that it is locked')
        result['checks'].append('A wrong password is refused and the disk stays locked')
        result['checks'].append('The right password opened the disk')
        result['unlocked_to_login_seconds'] = round(time.monotonic() - started, 1)
        result['checks'].append('The computer went on starting to its login, with nobody at its screen')
        result['status'] = 'passed'
    except BaseException as error:
        result['status'] = 'failed'
        result['error'] = repr(error)
        raise
    finally:
        result['finished_at_unix'] = time.time()
        (folder / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        try:
            vm.stop()
        except Exception:
            pass


if __name__ == '__main__':
    main()
