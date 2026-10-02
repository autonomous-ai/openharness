"""Exercise fixture ownership and cleanup without touching installed sessions.

Build cli/dist/cli.js first. Set HARNESS_BENCH_NODE and HARNESS_BENCH_TMUX to
absolute pinned executables, or let this test resolve node/tmux on PATH.
Failed and successful run receipts are retained in /private/tmp.
"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

import connected_run


class ConnectedRunnerPreflightTests(unittest.TestCase):
    def test_missing_sampler_never_starts_the_stack(self):
        root = Path('/private/tmp') / ('harness-connected-preflight-' + uuid.uuid4().hex)
        args = SimpleNamespace(
            root=root, app=Path('/private/tmp/harness-native-benchmark-not-built/Fixture.app'),
            node=Path('/usr/bin/false'), tmux=Path('/usr/bin/false'),
            sampler=root / 'missing-sampler', terminals=1, bundle=None, label='preflight',
        )
        with patch.object(connected_run, 'validate_benchmark_bundle'), \
                patch.object(connected_run.subprocess, 'Popen') as spawn:
            with self.assertRaises(FileNotFoundError):
                connected_run.run(args)
            spawn.assert_not_called()
        self.assertFalse(root.exists())


@unittest.skipUnless(sys.platform == 'darwin', 'macOS fixture isolation')
class ConnectedStackTests(unittest.TestCase):
    def setUp(self):
        self.root = Path('/private/tmp') / ('harness-connected-lifecycle-' + uuid.uuid4().hex)
        self.command = [
            os.environ.get('HARNESS_BENCH_NODE') or shutil.which('node'),
            str(Path(__file__).with_name('connected_stack.mjs')),
            '--root=' + str(self.root),
            '--tmux=' + str(Path(os.environ.get('HARNESS_BENCH_TMUX') or shutil.which('tmux')).resolve()),
            '--terminals=1',
        ]

    def start(self):
        env = dict(os.environ, HARNESS_FIXTURE_SECRET_SENTINEL='not-a-real-secret',
                   CODEX_HOME='/private/tmp/not-the-fixture-profile')
        child = subprocess.Popen(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, env=env)
        self.addCleanup(self.stop, child)
        return child

    @staticmethod
    def stop(child):
        if child.poll() is None:
            if not child.stdin.closed:
                child.stdin.close()
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.terminate()
                child.wait(timeout=15)
        for pipe in [child.stdin, child.stdout, child.stderr]:
            if not pipe.closed:
                pipe.close()

    def wait_for(self, name, child):
        path = self.root / name
        deadline = time.monotonic() + 45
        while not path.exists():
            self.assertIsNone(child.poll(), f'Fixture exited before {name}')
            self.assertLess(time.monotonic(), deadline, f'Waiting for {name}')
            time.sleep(0.05)
        return path

    def assert_stopped(self, child, had_daemon=False):
        child.wait(timeout=15)
        errors = child.stderr.read()
        self.assertEqual(child.returncode, 0, errors)
        cleanup = json.loads((self.root / 'cleanup.json').read_text())
        self.assertTrue(cleanup['success'], cleanup)
        self.assertEqual(cleanup['errors'], [])
        if had_daemon:
            self.assertEqual(cleanup['daemonExit'], 0)
        with socket.socket(socket.AF_UNIX) as probe:
            with self.assertRaises((FileNotFoundError, ConnectionRefusedError)):
                probe.connect(str(self.root / 'tmux.sock'))

    def test_eof_during_startup_cleans_up_pending_tmux_creation(self):
        child = self.start()
        child.stdin.close()
        self.assert_stopped(child)

    def test_eof_after_ready_stops_only_the_private_stack(self):
        child = self.start()
        stack = json.loads(self.wait_for('stack.json', child).read_text())
        self.assertEqual(len(stack['agents']), 1)
        env = json.loads((self.root / 'environment.json').read_text())
        self.assertNotIn('HARNESS_FIXTURE_SECRET_SENTINEL', env)
        self.assertEqual(env['HOME'], str(self.root / 'home'))
        self.assertEqual(env['CODEX_HOME'], str(self.root / 'codex_home'))
        self.assertEqual(env['TMUX'].split(',')[0], str(self.root / 'tmux.sock'))
        child.stdin.close()
        self.assert_stopped(child, had_daemon=True)

    def test_sigterm_during_daemon_startup_cleans_up(self):
        child = self.start()
        self.wait_for('daemon.log', child)
        child.terminate()
        self.assert_stopped(child)

    def test_existing_root_is_refused_and_preserved(self):
        self.root.mkdir(mode=0o700)
        sentinel = self.root / 'preserve-me'
        sentinel.write_text('existing evidence')
        child = self.start()
        child.stdin.close()
        child.wait(timeout=5)
        self.assertNotEqual(child.returncode, 0)
        self.assertEqual(sentinel.read_text(), 'existing evidence')
        self.assertFalse((self.root / 'tmux.sock').exists())
        self.assertFalse((self.root / 'daemon.log').exists())


if __name__ == '__main__':
    unittest.main()
