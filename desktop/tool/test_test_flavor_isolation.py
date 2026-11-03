"""Proof: the PR's real CLI, run in the test flavor's environment, leaves the person's home, launchd and Keychain alone.

It never uses this Mac's real HOME: a fake "real" home (a session, Desktop's settings, a launchd definition) stands
for it, and fake `launchctl`, `security` and `open` on PATH record every call. The CLI is the PR's own, bundled into
the test home as `start` installs it. macOS only; needs Node and cli/node_modules.

Run: python3 -m unittest desktop/tool/test_test_flavor_isolation.py
"""
import hashlib
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_flavor  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
CALL_LOG = 'calls.log'
INHERITED_CREDENTIALS = ('GIT_CONFIG_PARAMETERS', 'GH_CONFIG_DIR', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
                         'OPENAI_API_KEY', 'SSH_AUTH_SOCK')
RECORDER = '#!/bin/sh\necho "$(basename "$0") $*" >> "{log}"\n{tail}\n'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def tree_digest(root):
    """sha256 of every file under [root], by relative path."""
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob('*')) if p.is_file()}


def listening(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0


@unittest.skipUnless(sys.platform == 'darwin', 'the Desktop test flavor runs on macOS')
class IsolationProofTest(unittest.TestCase):
    def setUp(self):
        self.node = shutil.which('node')
        if not self.node or not (REPO / 'cli/node_modules').is_dir():
            self.fail('needs node on PATH and cli/node_modules (npm ci in cli/)')
        self.root = Path(tempfile.mkdtemp(prefix='harness-test-flavor-proof.'))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

        self.real_home = self.root / 'real-home'
        (self.real_home / '.harness/auth').mkdir(parents=True)
        (self.real_home / '.harness/auth/session.json').write_text('{"user":{"email":"owner@example.com"}}')
        (self.real_home / '.harness/desktop-app-v2').mkdir(parents=True)
        (self.real_home / '.harness/desktop-app-v2/state.json').write_text('{"theme":"dark"}')
        (self.real_home / 'Library/LaunchAgents').mkdir(parents=True)
        (self.real_home / 'Library/LaunchAgents/ai.autonomous.harness.harnessd.plist').write_text('<plist/>')
        self.before = tree_digest(self.real_home)

        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.log = self.root / CALL_LOG
        self.log.write_text('')
        for name, tail in (('launchctl', 'exit 0'), ('security', 'exit 44'), ('open', 'exit 0')):
            tool = self.bin / name
            tool.write_text(RECORDER.format(log=self.log, tail=tail))
            tool.chmod(0o755)

        self.test_home = self.root / 'test-home'
        self.test_home.mkdir()
        self.shared = self.root / 'shared'
        self.port = free_port()
        base = {
            'HOME': str(self.real_home),
            'PATH': f'{self.bin}:{Path(self.node).parent}:/usr/bin:/bin:/usr/sbin:/sbin',
            'USER': os.environ.get('USER', 'person'),
            'TMPDIR': str(self.root / 'tmp'),
            # What a Tester's agent pane inherits from the person's daemon, and the credentials it carries.
            'ADAPTER_DATA_DIR': str(self.real_home / '.harness/cli/data'),
            'HARNESS_HOOK_ROUTES_DIR': str(self.real_home / '.harness/hook-routes'),
            'TMUX': f'/private/tmp/tmux-{os.getuid()}/default,1,0',
            **{name: f'person-{name.lower()}' for name in INHERITED_CREDENTIALS},
        }
        (self.root / 'tmp').mkdir()
        self.env = test_flavor.flavor_env(base, self.test_home, self.shared, self.port)
        # No backend: the proof is about this Mac, and a closed port answers at once.
        self.env['BACKEND_WS_URL'] = 'ws://127.0.0.1:1'
        self.cli = test_flavor.install_cli(REPO / 'cli', self.test_home, Path(self.node))
        self.addCleanup(self.stop_daemon)

    def test_the_cli_runs_without_the_credentials_a_tester_s_pane_carries(self):
        # The daemon renames its process, so macOS will not show its environment; the CLI gets exactly self.env.
        for name in INHERITED_CREDENTIALS:
            self.assertNotIn(name, self.env, name)

    def harness(self, *args, timeout=120):
        return subprocess.run([self.node, str(self.cli), *args], env=self.env, capture_output=True, text=True,
                              timeout=timeout, cwd=self.test_home)

    def stop_daemon(self):
        # Only the daemon this test started: the pid file in the test home names it.
        self.harness('stop', timeout=60)
        pid_file = self.test_home / '.harness/cli/data/adapter.pid'
        if pid_file.exists():
            try:
                os.kill(int(pid_file.read_text().split()[0]), 15)
            except (ValueError, ProcessLookupError, PermissionError):
                pass

    def test_start_status_sign_out_and_stop_touch_nothing_of_the_person_s(self):
        started = self.harness('start')
        self.assertEqual(started.returncode, 0, started.stdout + started.stderr)
        data = self.test_home / '.harness/cli/data'
        self.assertTrue((data / 'adapter.pid').exists(), 'the daemon pid file is in the test home')
        self.assertTrue(listening(self.port), f'the test daemon listens on its own port {self.port}')

        status = self.harness('auth', 'status', '--json')
        self.assertNotIn('owner@example.com', status.stdout, "the test CLI never sees the person's session")
        # As Desktop's Sign out runs it (desktop/lib/auth/cli_login.dart).
        signed_out = self.harness('logout', '--from-sign-out-button')
        self.assertEqual(signed_out.returncode, 0, signed_out.stdout + signed_out.stderr)
        stopped = self.harness('stop')
        self.assertEqual(stopped.returncode, 0, stopped.stdout + stopped.stderr)

        self.assertEqual(tree_digest(self.real_home), self.before, "the person's home is byte for byte unchanged")
        calls = self.log.read_text().splitlines()
        self.assertEqual([c for c in calls if c.startswith('launchctl')], [], 'launchd is never asked')
        plain_item = re.compile(r'Claude Code-credentials(?!-)')
        self.assertEqual([c for c in calls if c.startswith('security') and plain_item.search(c)], [],
                         "no Keychain call names the person's Claude item")
        self.assertFalse(listening(self.port), 'nothing listens on the test port after stop')


if __name__ == '__main__':
    unittest.main()
