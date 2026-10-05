#!/usr/bin/env python3
"""Test actual media-key dispatch, with a synthetic panel and kernel user LEDs.

Runs only in our disposable VM. The display backlight files are a test fixture;
keyboard illumination uses Linux uleds and the normal session permissions.
Neither this program nor the devices enter a shipped image.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import struct
import subprocess
import time

ROOT = Path('/run/harness-input-test')
PANEL = ROOT / 'backlight/harness_panel'
LEDS = Path('/sys/class/leds')
KEYS = {'down': 224, 'up': 225, 'keyboard-down': 229, 'keyboard-up': 230}


def run(*args, check=True):
    return subprocess.run(args, text=True, capture_output=True, check=check)


def read(path):
    return int(path.read_text().strip())


class Input:
    def __enter__(self):
        run('modprobe', 'uinput')
        self.fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
        # Linux uinput ABI: EV_KEY and the ordinary keyboard range make udev
        # recognize this as a keyboard. Only the requested key is ever emitted.
        fcntl.ioctl(self.fd, 0x40045564, 1)
        for code in range(1, 256):
            fcntl.ioctl(self.fd, 0x40045565, code)
        device = struct.pack('80sHHHHI', b'Harness disposable input test', 3, 1, 1, 1, 0)
        os.write(self.fd, device + bytes(4 * 64 * 4))
        fcntl.ioctl(self.fd, 0x5501)
        run('udevadm', 'settle', '--timeout=10')
        time.sleep(1)  # libinput hotplug follows udev; effects are checked below.
        return self

    def press(self, key):
        for value in [1, 0]:
            os.write(self.fd, struct.pack('llHHi', 0, 0, 1, KEYS[key], value))
            os.write(self.fd, struct.pack('llHHi', 0, 0, 0, 0, 0))
            time.sleep(.06)

    def __exit__(self, *_):
        fcntl.ioctl(self.fd, 0x5502)
        os.close(self.fd)


class KeyboardLight:
    name = 'harness-test::kbd_backlight'

    def __enter__(self):
        run('modprobe', 'uleds')
        self.fd = os.open('/dev/uleds', os.O_RDWR | os.O_NONBLOCK)
        os.write(self.fd, struct.pack('64si', self.name.encode(), 100))
        run('udevadm', 'settle', '--timeout=10')
        self.path = LEDS / self.name / 'brightness'
        assert self.path.exists(), 'The kernel did not create the test LED'
        self.path.write_text('50\n')
        return self

    def __exit__(self, *_):
        os.close(self.fd)


def panel(maximum=100, current=50):
    PANEL.mkdir(parents=True, exist_ok=True)
    (PANEL / 'max_brightness').write_text(str(maximum))
    (PANEL / 'brightness').write_text(str(current))
    # Equivalent to a writable device granted by udev; the real LED below tests
    # logind access separately, without altering its kernel-owned permissions.
    os.chown(PANEL / 'brightness', 1000, -1)


def effect(keys, key, path, expected, events):
    before = read(path)
    started = time.monotonic()
    keys.press(key)
    while read(path) != expected:
        assert time.monotonic() - started < 5, (key, str(path), before, read(path), expected)
        time.sleep(.05)
    # Keep assertions that already match the initial value from racing a late
    # compositor command, especially the floor and maximum-bound cases.
    time.sleep(.15)
    assert read(path) == expected
    events.append({'key': key, 'path': str(path), 'before': before,
                   'after': expected, 'seconds': round(time.monotonic() - started, 3)})


def led_values():
    return {p.parent.name: read(p) for p in LEDS.glob('*/brightness')}


def audit_boot():
    result = {'scope': 'Packaged module availability and generic VM initramfs inventory; not Apple keyboard operation',
              'modules': {}, 'initramfs': {}}
    names = ['hid_apple', 'applespi', 'spi_pxa2xx_platform', 'spi_pxa2xx_pci', 'intel_lpss_pci']
    for name in names:
        info = run('modinfo', name, check=False)
        result['modules'][name] = {'exit_code': info.returncode, 'info': info.stdout, 'error': info.stderr}
    for path in Path('/boot').glob('initramfs-linux-lts*.img'):
        listing = run('lsinitcpio', '-l', str(path))
        result['initramfs'][path.name] = {name: [line for line in listing.stdout.splitlines()
            if '/' + name.replace('_', '-') + '.ko' in line.replace('_', '-')]
            for name in names}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--installed', action='store_true')
    args = parser.parse_args()
    assert os.geteuid() == 0
    assert run('lsblk', '-ndo', 'SERIAL', '/dev/vda').stdout.strip() == 'HN_OS_TEST'
    assert args.config in [Path('/usr/share/harness-os/labwc/rc.xml'),
                           Path('/usr/share/harness-os/labwc-install/rc.xml')]
    ROOT.mkdir(exist_ok=True)
    panel()
    run('mount', '--bind', str(ROOT / 'backlight'), '/sys/class/backlight')
    result = {'status': 'running', 'baseline': [], 'candidate': [],
              'fixture': 'Real compositor/uinput/brightnessctl; synthetic display files, real kernel uleds keyboard light',
              'brightnessctl_version': run('brightnessctl', '--version').stdout.strip()}
    try:
        with Input() as keys, KeyboardLight() as light:
            mode = light.path.stat().st_mode & 0o777
            result['keyboard_light'] = {'path': str(light.path), 'mode': oct(mode),
                'uid': light.path.stat().st_uid, 'gid': light.path.stat().st_gid,
                'user_groups': run('id', 'me').stdout.strip()}
            # Retain the broken baseline using the released, unmodified config.
            panel(current=5)
            effect(keys, 'down', PANEL / 'brightness', 0, result['baseline'])
            original_light = read(light.path)
            keys.press('keyboard-up')
            time.sleep(.4)
            assert read(light.path) == original_light, 'Baseline already has a working keyboard-light binding'
            result['baseline'].append({'missing_keyboard_binding': True})

            args.config.write_bytes(args.candidate.read_bytes())
            pids = run('pgrep', '-u', '1000', '-x', 'labwc').stdout.split()
            assert len(pids) == 1, pids
            os.kill(int(pids[0]), signal.SIGHUP)
            time.sleep(.4)
            events = result['candidate']
            panel(current=50)
            effect(keys, 'up', PANEL / 'brightness', 55, events)
            effect(keys, 'down', PANEL / 'brightness', 50, events)
            panel(current=5)
            effect(keys, 'down', PANEL / 'brightness', 1, events)
            effect(keys, 'down', PANEL / 'brightness', 1, events)
            panel(current=99)
            effect(keys, 'up', PANEL / 'brightness', 100, events)
            # Small-range backlights still move by a real step and never hit 0.
            panel(maximum=15, current=2)
            effect(keys, 'down', PANEL / 'brightness', 1, events)
            effect(keys, 'down', PANEL / 'brightness', 1, events)
            effect(keys, 'up', PANEL / 'brightness', 2, events)
            panel()
            unrelated = {k: v for k, v in led_values().items() if k != light.name}
            effect(keys, 'keyboard-up', light.path, 60, events)
            effect(keys, 'keyboard-down', light.path, 50, events)
            light.path.write_text('5\n')
            effect(keys, 'keyboard-down', light.path, 0, events)
            effect(keys, 'keyboard-up', light.path, 10, events)
            light.path.write_text('99\n')
            effect(keys, 'keyboard-up', light.path, 100, events)
            assert {k: v for k, v in led_values().items() if k != light.name} == unrelated

            # No display device: display keys must not fall through to any LED.
            hidden = ROOT / 'hidden-panel'
            PANEL.rename(hidden)
            try:
                before = led_values()
                keys.press('up')
                keys.press('down')
                time.sleep(.5)
                assert led_values() == before, 'Display keys changed an LED without a panel'
                events.append({'absent_display_preserves_all_leds': True})
            finally:
                hidden.rename(PANEL)
        if args.installed:
            result['apple_boot_audit'] = audit_boot()
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=str(error))
        raise
    finally:
        run('umount', '/sys/class/backlight')
        args.output.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
