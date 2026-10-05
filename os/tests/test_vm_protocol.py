"""Exercise command framing with a real shell, without QEMU or guest assumptions."""
import importlib.util
import io
import json
from pathlib import Path
import shlex
import socket
import subprocess
import tempfile
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

    def test_file_bytes_survive_shell_integration_before_first_json_event(self):
        # The live guest's OSC 3008 prefix shares the first event's serial line.
        # Reading the original file must retain that event, not silently skip it.
        self.vm.send(r'''trap 'printf "\033]3008;start=fixture;type=command\033\\"' DEBUG''' + '\n')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "agent's first event.jsonl"
            event = {'type': 'text', 'part': {'text': '42'}}
            path.write_text(json.dumps(event) + '\n')
            console, _ = self.vm.command('cat ' + shlex.quote(str(path)))
            with self.assertRaises(json.JSONDecodeError):
                json.loads(console)
            self.assertEqual(json.loads(self.vm.read_file(path)), event)

    def test_file_transfer_preserves_binary_and_empty_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'output'
            for payload in [bytes(range(256)) * 4, b'']:
                with self.subTest(size=len(payload)):
                    path.write_bytes(payload)
                    self.assertEqual(self.vm.read_file(path), payload)

    def test_missing_guest_file_is_not_reported_as_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'Guest command failed'):
                self.vm.read_file(Path(directory) / 'missing')


if __name__ == '__main__':
    unittest.main()
