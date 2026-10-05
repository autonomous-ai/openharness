import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


spec = importlib.util.spec_from_file_location('runtime_native', Path(__file__).with_name('runtime_native.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


@unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'pidfd_open'), 'Linux process ownership check')
class FixtureCleanupTests(unittest.TestCase):
    def test_waits_for_own_worker_and_preserves_similarly_named_home(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / 'home'
            home.mkdir()
            other_home = Path(temporary) / 'home-other'
            other_home.mkdir()
            writer = "import os,time; from pathlib import Path; p=Path(os.environ['HOME'])/'worker'; p.write_text('ready'); time.sleep(60)"
            owned = subprocess.Popen([sys.executable, '-c', writer], env={**os.environ, 'HOME': str(home)})
            other = subprocess.Popen([sys.executable, '-c', writer], env={**os.environ, 'HOME': str(other_home)})
            try:
                runtime.wait(lambda: (home / 'worker').exists() and (other_home / 'worker').exists(), 'Workers', 5)
                sent = runtime.finish_fixture_processes(home)
                self.assertEqual(owned.wait(timeout=2), -signal.SIGTERM)
                self.assertIsNone(other.poll())
                self.assertEqual({item['pid'] for item in sent}, {owned.pid})
            finally:
                for process in [owned, other]:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=2)

    def test_bounds_a_worker_that_ignores_termination(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            worker = ("import os,signal,time; from pathlib import Path; "
                      "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                      "(Path(os.environ['HOME'])/'ready').touch(); time.sleep(60)")
            process = subprocess.Popen([sys.executable, '-c', worker], env={**os.environ, 'HOME': str(home)})
            try:
                runtime.wait(lambda: (home / 'ready').exists(), 'Worker', 5)
                started = time.monotonic()
                sent = runtime.finish_fixture_processes(home)
                self.assertEqual(process.wait(timeout=2), -signal.SIGKILL)
                self.assertLess(time.monotonic() - started, 10)
                self.assertIn('SIGKILL', {item['signal'] for item in sent})
                self.assertEqual({item['pid'] for item in sent}, {process.pid})
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=2)
