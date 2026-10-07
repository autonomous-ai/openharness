"""First-account transaction checks. Native account/PAM behavior needs the VM."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
_modules = tempfile.TemporaryDirectory()
for source in (ROOT / 'fedora_session.py', ROOT / 'platforms/apple-silicon/firstboot.py'):
    shutil.copyfile(source, Path(_modules.name) / source.name)
spec = importlib.util.spec_from_file_location('asahi_firstboot', Path(_modules.name) / 'firstboot.py')
first = importlib.util.module_from_spec(spec)
spec.loader.exec_module(first)
session = first.session


class Fixture(first.FirstBoot):
    def __init__(self, root):
        super().__init__(root)
        self.commands = []
        self.failure = None

    def image(self):
        return 'a' * 40

    def run(self, *command, check=True):
        self.commands.append(command)
        if self.failure == Path(command[0]).name:
            raise session.SetupError('Injected command failure')
        if command[0].endswith('groupadd'):
            with self.path('etc/group').open('a') as stream:
                stream.write('me:x:1000:\n')
        if command[0].endswith('useradd'):
            token = command[command.index('--comment') + 1]
            with self.path('etc/passwd').open('a') as stream:
                stream.write(f'me:x:1000:1000:{token}:/home/me:/bin/bash\n')
        if command[0].endswith('usermod'):
            rows = self.records('passwd')
            for row in rows:
                if row[0] == 'me':
                    row[4] = 'me'
            self.path('etc/passwd').write_text('\n'.join(':'.join(row) for row in rows) + '\n')
        return ''

    def ensure_home(self, state):
        (self.root / 'home/me').mkdir(parents=True, exist_ok=True)

    def set_password(self, password):
        if self.failure == 'password':
            raise session.SetupError('Injected password failure')


class FirstAccount(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.setup = Fixture(self.root)
        self.put('etc/passwd', 'root:x:0:0:root:/root:/bin/bash\nnobody:x:65534:65534:Nobody:/:/sbin/nologin\n')
        self.put('etc/group', 'root:x:0:\nwheel:x:10:\n')
        self.put('etc/shadow', 'root:!:20732:0:99999:7:::\n')
        self.put('etc/os-release', 'ID=fedora-asahi-remix\nVERSION_ID=44\n')
        self.put('usr/share/harness-os/image.json', json.dumps({
            'kind': 'harness-asahi-image-construction', 'profile': 'Harness',
            'release_ready': False, 'source_commit': 'a' * 40}))
        (self.root / 'run').mkdir()

    def put(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def test_refuse_existing_account_group_home_or_unlocked_root_without_a_write(self):
        mutations = [
            ('etc/passwd', 'owner:x:1000:1000:Owner:/home/owner:/bin/bash\n'),
            ('etc/passwd', 'me:x:1000:1000:Me:/home/me:/bin/bash\n'),
            ('etc/group', 'me:x:1000:\n'),
            ('home/me/project', 'keep this work\n'),
            ('etc/shadow', 'root:$6$existing-hash:20732:0:99999:7:::\n'),
        ]
        for name, text in mutations:
            with self.subTest(name=name, text=text):
                path = self.root / name
                before = path.read_text() if path.exists() else None
                self.put(name, text)
                with self.assertRaises(session.SetupError):
                    self.setup.prepare()
                self.assertEqual(path.read_text(), text)
                self.assertFalse((self.root / first.STATE).exists())
                if before is not None:
                    path.write_text(before)
                else:
                    shutil.rmtree(self.root / 'home')

    def test_receipt_is_durable_before_user_creation_and_never_contains_password(self):
        state = self.setup.prepare()
        receipt = self.root / first.STATE
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.setup.commands, [('/usr/sbin/visudo', '-c')])
        self.setup.provision(state, 'private-fixture-password')
        with patch.object(self.setup, 'enable') as enable:
            self.setup.finish(state)
        enable.assert_called_once_with('me')
        self.assertEqual(self.setup.read_state()['phase'], 'complete')
        self.assertEqual(self.setup.prepare()['phase'], 'complete')
        for path in (receipt, self.root / first.DONE):
            self.assertNotIn('private-fixture-password', path.read_text())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('private-fixture-password', repr(self.setup.commands))
        self.assertIn('me:x:1000:1000:me:/home/me:/bin/bash', (self.root / 'etc/passwd').read_text())

    def test_resume_after_group_creation_user_creation_or_password_rejection(self):
        for failure in ('useradd', 'password'):
            with self.subTest(failure=failure):
                self.setUp()
                state = self.setup.prepare()
                self.setup.failure = failure
                with self.assertRaises(session.SetupError):
                    self.setup.provision(state, 'fixture-password')
                self.setup.failure = None
                resumed = self.setup.prepare()
                self.assertEqual(resumed, state)
                self.setup.provision(resumed, 'retry-password')
                self.assertEqual(self.setup.read_state()['phase'], 'password')
                users = [row for row in self.setup.records('passwd') if row[0] == 'me']
                self.assertEqual(len(users), 1)
                groups = [row for row in self.setup.records('group') if row[0] == 'me']
                self.assertEqual(len(groups), 1)

    def test_completed_password_is_not_reset_after_restart(self):
        state = self.setup.prepare()
        self.setup.provision(state, 'fixture-password')
        with patch.object(self.setup, 'set_password') as password:
            with self.assertRaisesRegex(session.SetupError, 'already has'):
                self.setup.provision(self.setup.prepare(), 'replacement')
        password.assert_not_called()

    def test_refuse_changed_account_or_receipt_on_resume(self):
        state = self.setup.prepare()
        self.setup.provision(state, 'fixture-password')
        passwd = self.root / 'etc/passwd'
        passwd.write_text(passwd.read_text().replace('Harness setup ' + state['token'], 'Different owner'))
        with self.assertRaisesRegex(session.SetupError, 'differs'):
            self.setup.prepare()
        receipt = self.root / first.STATE
        data = json.loads(receipt.read_text())
        data['source'] = 'b' * 40
        receipt.write_text(json.dumps(data))
        with self.assertRaisesRegex(session.SetupError, 'receipt has changed'):
            self.setup.prepare()

    def test_password_is_stdin_only_and_rejection_does_not_repeat_secret(self):
        password = 'unique-fixture-secret'
        with patch.object(first.subprocess, 'run', return_value=subprocess.CompletedProcess(
                [], 1, '', password)) as run:
            with self.assertRaises(session.SetupError) as error:
                first.FirstBoot.set_password(self.setup, password)
        self.assertNotIn(password, str(error.exception))
        args, kwargs = run.call_args
        self.assertNotIn(password, repr(args))
        self.assertEqual(kwargs['input'], 'me:' + password + '\n')

    def test_empty_mismatch_and_linebreak_passwords_are_rejected(self):
        for password, repeat in [('', ''), ('one', 'two'), ('one\ntwo', 'one\ntwo')]:
            with self.subTest(password=password), self.assertRaises(ValueError):
                self.setup.validate_password(password, repeat)
        self.setup.validate_password('a', 'a')

    def test_native_image_guard_does_not_accept_other_distributions(self):
        # Exercise the actual guard, while path ownership remains that of the test runner.
        with patch.object(first.platform, 'machine', return_value='aarch64'), \
                patch.object(first.os, 'geteuid', return_value=0), \
                patch.object(self.setup, 'path', side_effect=lambda name: self.root / name):
            self.assertEqual(first.FirstBoot.image(self.setup), 'a' * 40)
            self.put('etc/os-release', 'ID=fedora\nVERSION_ID=44\n')
            with self.assertRaisesRegex(session.SetupError, 'private Harness Mac image'):
                first.FirstBoot.image(self.setup)


if __name__ == '__main__':
    unittest.main()
