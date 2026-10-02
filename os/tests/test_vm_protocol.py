"""Exercise command framing with a real shell, without QEMU or guest assumptions."""
import importlib.util
import io
from pathlib import Path
import socket
import subprocess
import unittest

spec = importlib.util.spec_from_file_location('hn_vm', Path(__file__).with_name('vm.py'))
vm_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm_module)


class SerialProtocol(unittest.TestCase):
    def setUp(self):
        self.vm = vm_module.VM.__new__(vm_module.VM)
        self.vm.serial, guest = socket.socketpair()
        self.vm.log = io.BytesIO()
        self.vm.process = subprocess.Popen(['bash', '--noprofile', '--norc'], stdin=guest, stdout=guest, stderr=guest)
        guest.close()

    def tearDown(self):
        self.vm.process.terminate()
        self.vm.process.wait(timeout=5)
        self.vm.serial.close()

    def test_explicit_exit_and_exec_preserve_serial_session(self):
        self.assertEqual(self.vm.command('exit 7', timeout=5, check=False)[1], 7)
        self.assertEqual(self.vm.command('exec printf still-connected', timeout=5)[0], 'still-connected')
        self.assertEqual(self.vm.command('printf next-probe', timeout=5)[0], 'next-probe')

    def test_failed_probe_reports_status_and_allows_diagnostics(self):
        with self.assertRaisesRegex(RuntimeError, 'Guest command failed \\(3\\)'):
            self.vm.command("printf 'probe failed'; exit 3", timeout=5)
        self.assertEqual(self.vm.command('printf diagnostics', timeout=5)[0], 'diagnostics')


if __name__ == '__main__':
    unittest.main()
