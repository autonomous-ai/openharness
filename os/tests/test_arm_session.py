"""Keep the graphical ARM fixture separate from PC installation/update artifacts."""
import json
import io
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest

from arm_boot import digest
from arm_session import SessionVM, fixture_identity, frame_contains, runtime_identity, stage


class ARMFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir()
        elf = bytearray(64)
        elf[:7] = b'\x7fELF\x02\x01\x01'
        elf[16:18] = (2).to_bytes(2, 'little')
        elf[18:20] = (183).to_bytes(2, 'little')
        elf[20:24] = (1).to_bytes(4, 'little')
        for name, data in [('harness-tui', elf), ('cli.js', b'fixture'), ('notify.mjs', b'fixture')]:
            (self.runtime / name).write_bytes(data)
        self.info = {'source_commit': 'a' * 40, 'dirty': False, 'architecture': 'aarch64',
                     'target': 'aarch64-unknown-linux-musl',
                     'files': {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p)} for p in self.runtime.iterdir()}}
        self.save()

    def save(self):
        (self.runtime / 'source.json').write_text(json.dumps(self.info))

    def test_rejects_wrong_source_target_and_dirty_payload(self):
        runtime_identity(self.runtime, 'a' * 40)
        for key, value in [('source_commit', 'b' * 40), ('dirty', True), ('architecture', 'x86_64'),
                           ('target', 'x86_64-unknown-linux-musl')]:
            original = self.info[key]
            self.info[key] = value
            self.save()
            with self.subTest(key=key), self.assertRaises(ValueError):
                runtime_identity(self.runtime, 'a' * 40)
            self.info[key] = original

    def test_rejects_modified_runtime_and_mislabelled_elf(self):
        binary = self.runtime / 'harness-tui'
        data = bytearray(binary.read_bytes())
        data[18:20] = (62).to_bytes(2, 'little')
        binary.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            runtime_identity(self.runtime, 'a' * 40)
        self.info['files']['harness-tui']['sha256'] = digest(binary)
        self.save()
        with self.assertRaisesRegex(ValueError, 'ARM64 ELF'):
            runtime_identity(self.runtime, 'a' * 40)

    def test_session_payload_contains_user_updates_but_no_pc_installer_or_system_updates(self):
        destination = self.root / 'overlay'
        receipt = stage(self.runtime, destination, 'a' * 40)
        files = receipt['files']
        for path in ['usr/lib/harness-os/install.py', 'usr/lib/harness-os/runtime_update.py',
                     'usr/lib/harness-os/release_update.py', 'etc/mkinitcpio.conf.d/20-harness-apple-keyboard.conf']:
            self.assertNotIn(path, files)
        self.assertIn('usr/lib/systemd/user/harness-update.timer', files)
        self.assertIn('usr/lib/harness-os/live_update.py', files)
        self.assertEqual(receipt['runtime']['system_profile'], 'fedora')
        self.assertEqual((destination / 'usr/lib/harness/hn').readlink(), Path('harness-tui'))
        self.assertEqual(receipt['runtime']['architecture'], 'aarch64')
        self.assertIn('chromium-browser', (destination / 'usr/bin/hn-browser').read_text())
        self.assertNotIn('--no-sandbox', (destination / 'usr/bin/hn-browser').read_text())


class PortableFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        kernel = bytearray(64)
        kernel[24:32] = (4).to_bytes(8, 'little')
        kernel[56:60] = b'ARM\x64'
        (self.folder / 'Image').write_bytes(kernel)
        (self.folder / 'guest.raw.zst').write_bytes(b'checksum fixture; never booted')
        self.info = {'schema': 1, 'status': 'prepared', 'source_commit': 'a' * 40,
                     'raw_disk': {'bytes': 6 * 1024 ** 3, 'sha256': 'b' * 64},
                     'artifacts': {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p)}
                                   for p in self.folder.iterdir()}}
        self.save()

    def save(self):
        (self.folder / 'manifest.json').write_text(json.dumps(self.info))

    def test_requires_prepared_exact_source(self):
        fixture_identity(self.folder, 'a' * 40)
        with self.assertRaisesRegex(ValueError, 'exact clean source'):
            fixture_identity(self.folder, 'c' * 40)
        self.info['status'] = 'passed'
        self.save()
        with self.assertRaisesRegex(ValueError, 'prepared fixture'):
            fixture_identity(self.folder, 'a' * 40)

    def test_rejects_corruption_and_symlinks_before_boot(self):
        disk = self.folder / 'guest.raw.zst'
        original = disk.read_bytes()
        disk.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            fixture_identity(self.folder, 'a' * 40)
        other = self.folder / 'other'
        other.write_bytes(original)
        disk.unlink()
        disk.symlink_to(other)
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            fixture_identity(self.folder, 'a' * 40)

    def test_rejects_unbounded_disk_and_other_artifact_names(self):
        self.info['raw_disk']['bytes'] = 1024 ** 4
        self.save()
        with self.assertRaisesRegex(ValueError, 'private disk identity'):
            fixture_identity(self.folder, 'a' * 40)
        self.info['artifacts']['../other'] = self.info['artifacts'].pop('Image')
        self.save()
        with self.assertRaisesRegex(ValueError, 'kernel and compressed private disk'):
            fixture_identity(self.folder, 'a' * 40)


class VisibleFrames(unittest.TestCase):
    def test_agent_name_in_status_bar_is_not_ready_input(self):
        # Actual failed frame: the status bar appeared before the composer,
        # so the earlier name-only assertion sent the prompt into startup.
        starting = 'Terminal harness 10-5 6:42\n[me@harness ~]$\n0: opencode*\nharness 06:42'
        expected = ['OpenCode', 'Ask anything']
        self.assertFalse(frame_contains(starting, expected))
        self.assertTrue(frame_contains(starting + '\nOpenCode\nAsk anything...\nBuild OpenCode Zen', expected))

    def test_agent_transcript_is_not_a_loaded_browser_page(self):
        # The retained failure frame showed the generated HTML in OpenCode
        # while Chromium was still starting in the background.
        transcript = ('Terminal harness 10-5 5:53 [me@harness ~]$\n'
                      'Wrote index.html\n<title>Harness ARM Demo</title>\n'
                      'The page displays Count: 0 and an Increment button.\n'
                      'Build Big Pickle OpenCode Zen')
        expected = ['Harness ARM Demo', 'Count: 0', 'Increment']
        self.assertFalse(frame_contains(transcript, expected, absent=['me@harness']))
        self.assertFalse(frame_contains('Harness ARM Demo', expected, absent=['me@harness']))
        browser = 'Harness ARM Demo\n/home/me/projects/demo/index.html\nHarness ARM Demo\nCount: 0\nIncrement'
        self.assertTrue(frame_contains(browser, expected, absent=['me@harness']))


class GuestPoweroff(unittest.TestCase):
    def machine(self, event, exit_code=0):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        machine = object.__new__(SessionVM)
        machine.folder = Path(temporary.name)
        machine.log = io.BytesIO()
        machine.serial, console = socket.socketpair()
        machine.qmp, monitor = socket.socketpair()
        self.addCleanup(machine.serial.close)
        self.addCleanup(machine.qmp.close)
        # A real child/socket pair exposes serial backpressure: merely waiting
        # for process exit without draining output cannot complete this probe.
        producer = '''import json,socket,sys,time
serial=socket.socket(fileno=int(sys.argv[1]))
qmp=socket.socket(fileno=int(sys.argv[2]))
request=b''
while not request.endswith(b'\\n'):
 request+=serial.recv(1024)
assert request==b'sync; systemctl poweroff --no-block\\n'
serial.sendall(b'x'*(2*1024*1024))
qmp.sendall((sys.argv[3]+'\\n').encode())
time.sleep(.02)
sys.exit(int(sys.argv[4]))
'''
        machine.process = subprocess.Popen(
            [sys.executable, '-c', producer, str(console.fileno()), str(monitor.fileno()),
             json.dumps(event), str(exit_code)], pass_fds=(console.fileno(), monitor.fileno()))
        console.close()
        monitor.close()

        def cleanup():
            if machine.process.poll() is None:
                machine.process.terminate()
            machine.process.wait(timeout=5)
        self.addCleanup(cleanup)
        return machine

    def test_drains_console_and_requires_guest_shutdown(self):
        event = {'event': 'SHUTDOWN', 'data': {'guest': True, 'reason': 'guest-shutdown'}}
        machine = self.machine(event)
        receipt = machine.poweroff(timeout=5)
        self.assertEqual(receipt['status'], 'passed')
        self.assertEqual(machine.log.getvalue(), b'x' * (2 * 1024 * 1024))
        self.assertEqual(receipt['events'], [event])
        self.assertEqual(receipt['exit_code'], 0)

    def test_host_quit_is_not_successful_guest_poweroff(self):
        machine = self.machine({'event': 'SHUTDOWN', 'data': {'guest': False, 'reason': 'host-qmp-quit'}})
        with self.assertRaisesRegex(RuntimeError, 'guest poweroff event'):
            machine.poweroff(timeout=5)
        receipt = json.loads((machine.folder / 'shutdown.json').read_text())
        self.assertEqual(receipt['status'], 'failed')

    def test_guest_event_does_not_hide_unsuccessful_exit(self):
        machine = self.machine({'event': 'SHUTDOWN', 'data': {'guest': True, 'reason': 'guest-shutdown'}}, exit_code=1)
        with self.assertRaisesRegex(RuntimeError, 'exited unsuccessfully'):
            machine.poweroff(timeout=5)


if __name__ == '__main__':
    unittest.main()
