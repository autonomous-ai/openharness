#!/usr/bin/env python3
"""A Harness not signed in hosts its setup hotspot as it starts, network or not, and gives the
radio to someone at its screen.

The image installs (unencrypted, so nobody types a disk password) in a VM with two simulated Wi-Fi
radios (mac80211_hwsim): the computer's card, and a "phone" in a network namespace of its own.

    python3 tests/setup_hotspot_vm.py --iso dist/harness-dev-….iso [--output folder]
"""
import argparse
import base64
import json
import re
from pathlib import Path
import shlex
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vm import VM  # noqa: E402

PASSWORD = 'harness'


def put(vm, path, text, mode='644'):
    data = base64.b64encode(text.encode()).decode()
    vm.command(f': > {shlex.quote(path)}.b64')
    for start in range(0, len(data), 1500):
        vm.command(f"printf %s {shlex.quote(data[start:start + 1500])} >> {shlex.quote(path)}.b64")
    vm.command(f'base64 -d {shlex.quote(path)}.b64 > {shlex.quote(path)} && rm {shlex.quote(path)}.b64 && chmod {mode} {shlex.quote(path)}')


def root(command):
    return f'printf %s\\\\n {shlex.quote(PASSWORD)} | sudo -S -p "" sh -c {shlex.quote(command)}'


def until(vm, condition, seconds, what):
    """[condition], a shell test run as root, true within [seconds]."""
    _, status = vm.command(root(f'for n in $(seq {seconds}); do {condition} && exit 0; sleep 1; done; exit 1'),
                           timeout=seconds + 30, check=False)
    if status:
        raise AssertionError(what)


HOTSPOT_UP = "nmcli -t -f NAME connection show --active | grep -qx harness-setup"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--iso', required=True, type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--memory', type=int, default=4096)
    parser.add_argument('--video', choices=['virtio-vga', 'VGA'], default='virtio-vga')
    args = parser.parse_args()
    folder = (args.output or Path.cwd() / 'setup-hotspot-vm-results').resolve()
    folder.mkdir(parents=True, exist_ok=False)
    result = dict(iso=str(args.iso), checks=[], status='running', started_at_unix=time.time())
    vm = VM(folder, args.iso.resolve(), 'bios', args.memory, video=args.video)
    try:
        vm.start(live=True)
        vm.monitor('set_link', name='hnnet', up=False)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=300)
        vm.shell_ready = True
        vm.command('stty -echo')
        vm.command('nmcli networking off')
        config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda', username='me', hostname='harness',
                      password=PASSWORD, encrypt=False, serial_console=True)
        put(vm, '/run/hn-config.json', json.dumps(config), '600')
        vm.command('python3 /usr/lib/harness-os/install.py --config /run/hn-config.json --yes-erase-disk '
                   '> /run/hn-install.log 2>&1 || { tail -40 /run/hn-install.log; exit 1; }', timeout=2400)
        result['checks'].append('Unattended unencrypted installation')
        vm.command('mount -o subvol=@ /dev/vda3 /mnt')
        getty, _ = vm.command('cat /mnt/etc/systemd/system/getty@tty1.service.d/password.conf')
        assert "--login-options '-p -- me'" in getty, getty
        result['checks'].append('The screen asks only the password of the one account')
        put(vm, '/mnt/etc/modules-load.d/hwsim.conf', 'mac80211_hwsim\n')
        put(vm, '/mnt/etc/modprobe.d/hwsim.conf', 'options mac80211_hwsim radios=2\n')
        vm.command('sync; umount /mnt')
        vm.stop()

        vm.start(live=False)
        # No cable yet: the computer starts offline.
        vm.monitor('set_link', name='hnnet', up=False)
        vm.wait(r'login:', timeout=400)
        vm.send('me\n')
        vm.wait(r'Password:')
        vm.send(PASSWORD + '\n')
        vm.wait(r'\$ ')
        vm.shell_ready = True
        vm.command('stty -echo')

        # Not signed in, no network: the hotspot as it starts.
        until(vm, HOTSPOT_UP, 90, 'No setup hotspot on a computer not signed in')
        name, _ = vm.command('/usr/bin/python3 /usr/lib/harness-os/setup.py name')
        result['hotspot'] = re.findall(r'Harness-[A-Za-z0-9]+', name)[-1]
        result['checks'].append('Not signed in, the hotspot is up as the computer starts')

        # The phone: the other radio, in its own namespace, on the hotspot.
        phone = ('ap=$(nmcli -t -f DEVICE,CONNECTION device | grep ":harness-setup$" | cut -d: -f1); '
                 'for d in /sys/class/net/*; do [ -d $d/wireless ] && [ ${d##*/} != "$ap" ] && dev=${d##*/}; done; '
                 'phy=$(cat /sys/class/net/$dev/phy80211/name); ip netns add phone; iw phy $phy set netns name phone; '
                 'ip netns exec phone ip link set lo up; ip netns exec phone ip link set $dev up; '
                 f'printf "network={{\\n ssid=\\"{result["hotspot"]}\\"\\n key_mgmt=NONE\\n}}\\n" > /run/phone.conf; '
                 'ip netns exec phone wpa_supplicant -B -i $dev -c /run/phone.conf; echo $dev > /run/phone-dev')
        vm.command(root(phone))
        until(vm, 'ip netns exec phone iw dev $(cat /run/phone-dev) link | grep -q "Connected to"', 40,
              'The phone did not join the hotspot')
        vm.command(root('ip netns exec phone ip addr add 10.42.0.77/24 dev $(cat /run/phone-dev)'))
        until(vm, 'ip netns exec phone curl -sf -m 5 http://10.42.0.1/setup > /run/setup.json', 30,
              'The hotspot page did not answer the phone')
        info = json.loads(vm.read_file('/run/setup.json'))
        result['setup_offline'] = info
        assert info['signedIn'] is False and info['online'] is False and info['hotspot'] == result['hotspot'], info
        result['checks'].append('The phone joins it over the air and reads it is not signed in and offline')

        # A cable: the hotspot stays for the phone, which now signs in without a Wi-Fi.
        vm.monitor('set_link', name='hnnet', up=True)
        until(vm, "nmcli -t -f TYPE,STATE device | grep -q '^ethernet:connected'", 60, 'Ethernet did not connect')
        time.sleep(15)
        until(vm, HOTSPOT_UP, 5, 'The hotspot went when a cable came, though not signed in')
        until(vm, 'ip netns exec phone curl -sf -m 5 http://10.42.0.1/setup > /run/setup.json', 30,
              'The page went with the cable')
        info = json.loads(vm.read_file('/run/setup.json'))
        assert info['online'] is True, info
        result['checks'].append('On a cable the hotspot stays, and says online so the phone skips the Wi-Fi')

        # Someone at the screen, offline: the Wi-Fi page takes the radio, and keeps it.
        vm.monitor('set_link', name='hnnet', up=False)
        until(vm, "! nmcli -t -f TYPE,STATE device | grep -q '^ethernet:connected'", 60, 'Ethernet did not go')
        vm.command(root("setsid script -qfc 'python3 /usr/lib/harness-os/network.py --first-use' /run/page.log "
                        '> /dev/null 2>&1 < /dev/null & echo $! > /run/page.pid'))
        until(vm, f'test -f /run/harness-os/setup-screen && ! {HOTSPOT_UP}', 30,
              'The screen\'s Wi-Fi page did not take the radio from the hotspot')
        time.sleep(20)
        until(vm, f'! {HOTSPOT_UP}', 3, 'The hotspot came back while the screen holds the radio')
        page, _ = vm.command(root("cat /run/page.log | tr -d '\\033' | grep -ao 'Connect to Wi-Fi\\|Rescan\\|No Wi-Fi networks found' | sort -u"))
        result['page'] = page.strip().splitlines()
        result['checks'].append('The screen\'s Wi-Fi page took the radio from the hotspot, scanned, and kept it')
        vm.command(root('kill -- -$(cat /run/page.pid); sleep 2'))
        time.sleep(15)
        until(vm, f'! {HOTSPOT_UP}', 3, 'The hotspot came back once the page closed, before sign-in')
        result['checks'].append('Held until signed in: the page gone, the hotspot stays down')
        # Left alone (what the page does after SCREEN_IDLE): the hotspot comes back for a phone.
        vm.command(root('rm -f /run/harness-os/setup-screen'))
        until(vm, HOTSPOT_UP, 40, 'The hotspot did not come back once the screen let the radio go')
        result['checks'].append('Let go, the hotspot comes back for a phone')
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
