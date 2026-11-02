"""The power button's factory reset while the disk is locked (root/usr/lib/harness-os/unlock/button):
which devices it listens to, and the GRUB environment block that starts the recovery."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

OS = Path(__file__).resolve().parents[1]
BUTTON = OS / 'root/usr/lib/harness-os/unlock/button'
spec = importlib.util.spec_from_file_location('installer', OS / 'installer.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

# /proc/bus/input/devices: ACPI's power button (KEY_POWER, bit 116), a keyboard without it, and one
# with it among its many keys.
DEVICES = '''I: Bus=0019 Vendor=0000 Product=0001 Version=0000
N: Name="Power Button"
H: Handlers=kbd event3
B: EV=3
B: KEY=10000000000000 0

I: Bus=0011 Vendor=0001 Product=0001 Version=ab41
N: Name="AT Translated Set 2 keyboard"
H: Handlers=sysrq kbd leds event2
B: EV=120013
B: KEY=402000000 3803078f800d001 fecfffdfffefffff fffffffffffffffe

I: Bus=0003 Vendor=046d Product=c52b Version=0111
N: Name="Logitech K400"
H: Handlers=sysrq kbd leds event7
B: EV=120013
B: KEY=1000000000007 ff9f207ac14057ff febeffdfffefffff fffffffffffffffe
'''


class Button(unittest.TestCase):
    def run_button(self, *args, **env):
        return subprocess.run(['sh', str(BUTTON), *args], capture_output=True, text=True, check=True,
                              env=dict(os.environ, **env)).stdout

    def test_it_listens_to_every_device_with_the_power_key(self):
        with tempfile.NamedTemporaryFile('w', suffix='devices') as devices:
            devices.write(DEVICES)
            devices.flush()
            listed = self.run_button('devices', HARNESS_BUTTON_DEVICES=devices.name).split()
        self.assertEqual(listed, ['event3', 'event7'])

    def test_its_grub_block_is_the_installers(self):
        with tempfile.TemporaryDirectory() as folder:
            block = Path(folder) / 'grubenv'
            self.run_button('grubenv', str(block))
            self.assertEqual(block.read_bytes(), installer.grubenv('harness-recovery'))


if __name__ == '__main__':
    unittest.main()
