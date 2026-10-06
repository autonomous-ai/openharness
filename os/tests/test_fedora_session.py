"""Portable setup transaction checks; real Fedora PAM/login belongs to the VM."""
import importlib.util
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'fedora_session.py'
spec = importlib.util.spec_from_file_location('fedora_session', SOURCE)
session = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session)


class Fixture(session.Setup):
    """Only emulate external Fedora tools; exercise all actual file operations."""
    def __init__(self, root):
        super().__init__(root)
        self.commands = []
        self.fail = None
        self.default = 'multi-user.target'

    def run(self, *command, check=True):
        self.commands.append(command)
        if self.fail and self.fail in command:
            raise session.SetupError('Injected external command failure: ' + self.fail)
        if 'visudo' in command[0] and '-f' in command:
            text = Path(command[-1]).read_text()
            assert text == self.plan('owner', None, 'multi-user.target')[session.SUDOERS]['after']['text']
        if command[0].endswith('systemctl'):
            if 'is-active' in command:
                return 'inactive'
            if 'is-enabled' in command:
                return ('enabled' if command[-1] == 'greetd.service' and
                        self.snapshot(session.ALIAS) == session.link('/usr/lib/systemd/system/greetd.service')
                        else 'disabled')
            if 'get-default' in command:
                return self.default
            if 'enable' in command:
                if not self.path(session.ALIAS).is_symlink():
                    self.path(session.ALIAS).symlink_to('/usr/lib/systemd/system/greetd.service')
            if 'set-default' in command:
                path = self.path(session.TARGET)
                if path.is_symlink():
                    path.unlink()
                path.symlink_to('/usr/lib/systemd/system/graphical.target')
        return ''


class FedoraSession(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.setup = Fixture(self.root)
        self.uid = os.geteuid() or 1000
        self.put('etc/os-release', 'ID=fedora\n')
        self.put('usr/share/harness-os/runtime.json', '{"system_profile":"fedora"}\n')
        self.put('etc/passwd', f'root:x:0:0:root:/root:/bin/bash\nowner:x:{self.uid}:1000:Owner:/home/owner:/bin/bash\n')
        self.put('etc/shadow', 'owner:$6$fixture$existing-password-hash:20000:0:99999:7:::\n', 0o600)
        self.put('etc/login.defs', 'UID_MIN 100\n')
        self.put('etc/shells', '/bin/bash\n')
        self.put('etc/greetd/config.toml', '# Fedora vendor config remains byte-for-byte intact\n')
        self.put('etc/pam.d/greetd', 'session include system-auth\n')
        self.put('etc/sudoers.d/existing', '# Existing administrative policy\n', 0o440)
        self.put('usr/lib/systemd/system/greetd.service', '[Unit]\nConflicts=getty@tty1.service\n[Install]\nAlias=display-manager.service\n')
        for name in ('usr/bin/greetd', 'usr/bin/agreety', 'usr/bin/harness-session', 'usr/sbin/visudo', 'bin/bash'):
            self.put(name, '#!/bin/sh\nexit 0\n', 0o755)
        self.put('home/owner/.profile', 'export EXISTING=keep\n')
        self.put('home/owner/projects/project.py', 'print("existing project")\n')
        if os.geteuid() == 0:
            os.chown(self.root / 'home/owner', self.uid, 1000)
        (self.root / 'etc/systemd/system').mkdir(parents=True)
        (self.root / 'var/lib').mkdir(parents=True)
        (self.root / 'run').mkdir()
        self.setup.path(session.TARGET).symlink_to('/usr/lib/systemd/system/multi-user.target')
        self.protected = self.snapshot_protected()
        patcher = patch.object(session.platform, 'machine', return_value='aarch64')
        patcher.start()
        self.addCleanup(patcher.stop)

    def put(self, name, text, mode=0o644):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        path.chmod(mode)

    def snapshot_protected(self):
        return {name: (self.root / name).read_bytes() for name in (
            'etc/passwd', 'etc/shadow', 'etc/pam.d/greetd', 'etc/greetd/config.toml',
            'etc/sudoers.d/existing', 'home/owner/.profile', 'home/owner/projects/project.py')}

    def assert_original(self):
        self.assertEqual(self.setup.snapshot(session.TARGET), session.link('/usr/lib/systemd/system/multi-user.target'))
        self.assertFalse(self.setup.path(session.STATE).exists())
        for name in session.PATHS[:-1]:
            self.assertIsNone(self.setup.snapshot(name))
        self.assertEqual(self.snapshot_protected(), self.protected)

    def test_enable_disable_restores_exact_state_without_starting_services(self):
        self.setup.enable('owner')
        state = self.setup.load()
        self.assertEqual(state['phase'], 'enabled')
        self.assertEqual(state['uid'], self.uid)
        self.assertEqual(self.snapshot_protected(), self.protected)
        self.assertEqual(self.setup.snapshot(session.SUDOERS)['mode'], 0o440)
        self.assertEqual(self.setup.snapshot(session.TARGET), session.link('/usr/lib/systemd/system/graphical.target'))
        self.assertIn('source_profile = false', self.setup.path(session.CONFIG).read_text())
        self.assertIn(('/usr/bin/systemctl', '--no-reload', 'enable', 'greetd.service'), self.setup.commands)
        self.assertIn(('/usr/bin/systemctl', '--no-reload', 'set-default', 'graphical.target'), self.setup.commands)
        self.assertFalse(any(word in {'start', 'stop', 'restart', 'isolate'} for cmd in self.setup.commands for word in cmd))
        self.setup.disable()
        self.assert_original()

    def test_asahi_remix_identity_can_enable_and_restore_the_existing_login(self):
        for identity in ('fedora-asahi-remix', '"fedora-asahi-remix"', "'fedora-asahi-remix'"):
            with self.subTest(identity=identity):
                self.put('etc/os-release', f'NAME="Fedora Asahi Remix"\nID={identity}\nID_LIKE=fedora\nVERSION_ID=44\n')
                self.setup.enable('owner')
                self.assertEqual(self.setup.load()['phase'], 'enabled')
                self.assertEqual(self.snapshot_protected(), self.protected)
                self.setup.disable()
                self.assert_original()

    def test_foreign_or_malformed_distribution_cannot_change_login_policy(self):
        for release in ('ID=arch\nID_LIKE=fedora\n', 'ID=another-fedora-remix\nID_LIKE=fedora\n',
                        'ID=fedora-asahi-remix-extra\n', 'ID="fedora-asahi-remix\n',
                        "ID='fedora-asahi-remix\"\n"):
            with self.subTest(release=release):
                self.put('etc/os-release', release)
                with self.assertRaisesRegex(session.SetupError, 'native Fedora ARM'):
                    self.setup.enable('owner')
                self.assert_original()
                self.assertEqual(self.setup.commands, [])

    def test_asahi_identity_still_requires_the_native_fedora_runtime(self):
        self.put('etc/os-release', 'ID=fedora-asahi-remix\nID_LIKE=fedora\n')
        with patch.object(session.platform, 'machine', return_value='x86_64'):
            with self.assertRaisesRegex(session.SetupError, 'native Fedora ARM'):
                self.setup.enable('owner')
        self.put('usr/share/harness-os/runtime.json', '{"system_profile":"arch"}\n')
        with self.assertRaisesRegex(session.SetupError, 'native Fedora ARM'):
            self.setup.enable('owner')
        self.assert_original()
        self.assertEqual(self.setup.commands, [])

    def test_idempotent_enable_checks_identity_and_does_not_rewrite(self):
        self.setup.enable('owner')
        before = {name: self.setup.path(name).lstat().st_mtime_ns for name in session.PATHS}
        self.assertIn('already enabled', self.setup.enable('owner'))
        self.assertEqual(before, {name: self.setup.path(name).lstat().st_mtime_ns for name in session.PATHS})
        with self.assertRaisesRegex(session.SetupError, 'different account'):
            self.setup.enable('another')
        self.setup.disable()
        self.assertIn('not enabled', self.setup.disable())

    def test_existing_graphical_default_is_not_rewritten(self):
        self.setup.default = 'graphical.target'
        self.setup.path(session.TARGET).unlink()
        # With no /etc override, Fedora owns the vendor default target.
        self.setup.enable('owner')
        self.assertIsNone(self.setup.snapshot(session.TARGET))
        self.assertFalse(any('set-default' in command for command in self.setup.commands))
        self.setup.disable()
        self.assertIsNone(self.setup.snapshot(session.TARGET))

    def test_pristine_vendor_preset_alias_survives_enable_and_disable(self):
        previous = session.link('/usr/lib/systemd/system/greetd.service')
        self.setup.path(session.ALIAS).symlink_to(previous['target'])
        self.setup.enable('owner')
        self.assertEqual(self.setup.load()['files'][session.ALIAS], {'before': previous, 'after': previous})
        self.setup.disable()
        self.assertEqual(self.setup.snapshot(session.ALIAS), previous)
        self.setup.path(session.ALIAS).unlink()
        self.assert_original()

    def test_missing_autologin_flag_is_rejected_before_host_access(self):
        result = subprocess.run([sys.executable, str(SOURCE), 'enable', '--user', 'owner'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('--autologin', result.stderr)

    def test_accounts_need_recovery_authentication_and_existing_sudo(self):
        for user in ('root', 'missing', 'owner,ALL', 'owner\nroot'):
            with self.subTest(user=user), self.assertRaises(session.SetupError):
                self.setup.enable(user)
            self.assert_original()
        for password in ('', '!', '*', '!$6$locked$existing-password-hash', 'x'):
            self.put('etc/shadow', f'owner:{password}:20000:0:99999:7:::\n', 0o600)
            with self.subTest(password=password), self.assertRaisesRegex(session.SetupError, 'password'):
                self.setup.enable('owner')
            self.assertFalse(self.setup.path(session.STATE).exists())
        self.put('etc/shadow', self.protected['etc/shadow'].decode(), 0o600)
        self.setup.fail = 'disable'
        with self.assertRaisesRegex(session.SetupError, 'external command failure'):
            self.setup.enable('owner')
        self.assert_original()

    def test_valid_password_with_aging_disabled_is_preserved(self):
        for last_change in ('', '-1'):
            for maximum in ('', '1', '99999'):
                with self.subTest(last_change=last_change, maximum=maximum):
                    self.put('etc/shadow', f'owner:$y$j9T$existing-password-hash:{last_change}:0:{maximum}:7:::\n', 0o600)
                    self.protected = self.snapshot_protected()
                    self.setup.enable('owner')
                    self.assertEqual(self.snapshot_protected(), self.protected)
                    self.setup.disable()
                    self.assert_original()

    def test_forced_password_change_and_expired_accounts_are_still_rejected(self):
        for last_change, maximum, expires in (('0', '99999', ''), ('1', '1', ''),
                                               ('', '99999', '1'), ('-1', '', '1')):
            with self.subTest(last_change=last_change, maximum=maximum, expires=expires):
                self.put('etc/shadow', f'owner:$y$j9T$existing-password-hash:{last_change}:0:{maximum}:7::{expires}:\n', 0o600)
                self.protected = self.snapshot_protected()
                with self.assertRaisesRegex(session.SetupError, 'usable, unexpired password'):
                    self.setup.enable('owner')
                self.assert_original()

    def test_conflicting_configuration_is_never_overwritten(self):
        for name in (session.CONFIG, session.DROPIN, session.SUDOERS, session.ALIAS):
            self.put(name, 'existing admin configuration\n')
            with self.subTest(path=name), self.assertRaises(session.SetupError):
                self.setup.enable('owner')
            self.assertEqual(self.setup.path(name).read_text(), 'existing admin configuration\n')
            self.setup.path(name).unlink()
        self.assert_original()

    def test_foreign_service_install_policy_is_rejected_before_changes(self):
        self.put('usr/lib/systemd/system/greetd.service', '[Install]\nAlias=display-manager.service\nWantedBy=another.target\n')
        with self.assertRaisesRegex(session.SetupError, 'enablement policy differs'):
            self.setup.enable('owner')
        self.assert_original()

    def test_tampering_refuses_disable_before_any_managed_file_changes(self):
        self.setup.enable('owner')
        self.setup.path(session.SUDOERS).chmod(0o640)
        self.setup.path(session.SUDOERS).write_text('# administrator edited this policy\n')
        self.setup.path(session.SUDOERS).chmod(0o440)
        before = {name: self.setup.snapshot(name) for name in session.PATHS}
        with self.assertRaisesRegex(session.SetupError, 'configuration changed'):
            self.setup.disable()
        self.assertEqual(before, {name: self.setup.snapshot(name) for name in session.PATHS})
        self.assertEqual(self.setup.load()['phase'], 'enabled')

    def test_failure_validating_rule_or_enabling_login_rolls_back(self):
        for failing in ('-f', 'enable', 'set-default'):
            self.setup.fail = failing
            with self.subTest(failing=failing), self.assertRaisesRegex(session.SetupError, 'external command failure'):
                self.setup.enable('owner')
            self.assert_original()

    def test_no_space_committing_configuration_restores_prior_files(self):
        original_link = os.link
        def no_space(source, destination, **kwargs):
            if destination == self.setup.path(session.SUDOERS):
                raise OSError(errno.ENOSPC, 'No space left on device')
            return original_link(source, destination, **kwargs)
        with patch.object(session.os, 'link', side_effect=no_space):
            with self.assertRaises(OSError) as failure:
                self.setup.enable('owner')
        self.assertEqual(failure.exception.errno, errno.ENOSPC)
        self.assert_original()

    def test_interrupted_enable_and_disable_are_recoverable(self):
        self.setup.enable('owner')
        state = self.setup.load()
        state['phase'] = 'enabling'
        self.setup.save(state)
        self.setup.path(session.SUDOERS).unlink()
        self.setup.path(session.TARGET).unlink()
        with self.assertRaisesRegex(session.SetupError, 'interrupted'):
            self.setup.enable('owner')
        self.setup.disable()
        self.assert_original()
        self.setup.enable('owner')
        state = self.setup.load()
        state['phase'] = 'disabling'
        self.setup.save(state)
        self.setup.path(session.ALIAS).unlink()
        self.setup.disable()
        self.assert_original()

    def test_symlink_configuration_directory_and_receipt_are_refused(self):
        redirected = self.root / 'redirected'
        redirected.mkdir()
        directory = self.root / 'etc/systemd/system/greetd.service.d'
        directory.symlink_to(redirected)
        with self.assertRaisesRegex(session.SetupError, 'symlink configuration directory'):
            self.setup.enable('owner')
        self.assertEqual(list(redirected.iterdir()), [])
        directory.unlink()
        self.setup.path(session.STATE).parent.mkdir()
        self.setup.path(session.STATE).symlink_to(self.root / 'etc/shadow')
        with self.assertRaisesRegex(session.SetupError, 'private regular file'):
            self.setup.disable()
        self.assertEqual(self.snapshot_protected(), self.protected)

    def test_concurrent_setup_cannot_write_over_receipt(self):
        with self.setup.locked():
            with self.assertRaisesRegex(session.SetupError, 'Another session setup'):
                with self.setup.locked():
                    self.fail('second setup acquired lock')


if __name__ == '__main__':
    unittest.main()
