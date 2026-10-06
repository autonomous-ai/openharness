import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'os/tools'))
import asahi_image as image

spec = importlib.util.spec_from_file_location('asahi_image_check', Path(__file__).with_name('asahi_image_check.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)
hook_spec = importlib.util.spec_from_file_location('asahi_configure', ROOT / 'os/platforms/apple-silicon/configure.py')
hook = importlib.util.module_from_spec(hook_spec)
hook_spec.loader.exec_module(hook)


class Recipe(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)

    def test_lock_requires_native_content_addressed_builder_and_known_release(self):
        original = image.read_lock()
        for key, value in [('builder_image', 'fedora:latest'), ('fedora_release', 'rawhide')]:
            lock = copy.deepcopy(original)
            lock[key] = value
            path = self.root / 'lock.json'
            path.write_text(json.dumps(lock))
            with self.assertRaisesRegex(ValueError, 'reviewed'):
                image.read_lock(path)

    def test_chroot_guard_requires_the_actual_asahi_release_identity(self):
        with patch.dict(os.environ, {'HARNESS_ASAHI_IMAGE_BUILD': '1'}), \
                patch.object(hook.os, 'geteuid', return_value=0), \
                patch.object(hook.platform, 'machine', return_value='aarch64'), \
                patch.object(hook.Path, 'is_file', return_value=True), \
                patch.object(hook.platform, 'freedesktop_os_release') as release:
            release.return_value = {'ID': 'fedora-asahi-remix', 'VERSION_ID': '44', 'ID_LIKE': 'fedora'}
            hook.require_build_environment()
            for identity in ({'ID': 'fedora', 'VERSION_ID': '44'},
                             {'ID': 'fedora-asahi-remix', 'VERSION_ID': '45'},
                             {'ID': 'ubuntu', 'ID_LIKE': 'fedora', 'VERSION_ID': '44'}):
                release.return_value = identity
                with self.subTest(identity=identity), self.assertRaisesRegex(RuntimeError, 'Asahi KIWI'):
                    hook.require_build_environment()

    def test_upstream_tree_cannot_drift_from_pinned_source(self):
        def git(*args):
            return subprocess.check_output(['git', '-C', str(self.root), *args], text=True).strip()
        git('init', '-q')
        (self.root / 'config.xml').write_text('<image/>')
        git('add', 'config.xml')
        git('-c', 'user.name=Image test', '-c', 'user.email=image@example.invalid', 'commit', '-qm', 'fixture')
        lock = {'upstream': {'commit': git('rev-parse', 'HEAD'), 'tree': git('rev-parse', 'HEAD^{tree}')}}
        self.assertIn('config.xml', image.upstream_identity(self.root, lock))
        with self.assertRaisesRegex(ValueError, 'pinned'):
            image.upstream_identity(self.root, {'upstream': {**lock['upstream'], 'tree': '0' * 40}})
        (self.root / 'config.xml').write_text('<image changed="true"/>')
        with self.assertRaisesRegex(ValueError, 'clean'):
            image.upstream_identity(self.root, lock)

    def test_rpm_requirements_preserve_provides_but_reject_unreviewed_expressions(self):
        base = 'python3\nfoot\nlabwc\nNetworkManager\n'
        result = image.requirements(base + 'rpmlib(CompressedFileNames) <= 3.0.4-1\nnodejs22 >= 22.0\n/usr/bin/sh\nlibc.so.6(GLIBC_2.17)(64bit)\n')
        self.assertIn('nodejs22 >= 22.0', result)
        self.assertIn('/usr/bin/sh', result)
        self.assertIn('libc.so.6(GLIBC_2.17)(64bit)', result)
        self.assertFalse(any(item.startswith('rpmlib') for item in result))
        for invalid in ['nodejs; false', '-y', 'nodejs $(id)', '(nodejs or nodejs22)']:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                image.requirements(base + invalid)
        with self.assertRaisesRegex(ValueError, 'missing'):
            image.requirements('python3\n')

    def test_harness_extends_minimal_and_preserves_platform_and_signature_policy(self):
        (self.root / 'platforms').mkdir()
        (self.root / 'platforms/minimal.xml').write_text('<image><preferences>original partition layout</preferences></image>')
        (self.root / 'config.xml').write_text('''<image name="Fedora-Asahi-Remix">
          <description><specification>Fedora</specification></description>
          <preferences><release-version>44</release-version><rpm-check-signatures>true</rpm-check-signatures></preferences>
          <include from="this://./platforms/minimal.xml"/>
        </image>''')
        (self.root / 'config.sh').write_text('#!/bin/bash\nupdate-m1n1 /boot/efi/m1n1/boot.bin\nexit 0\n')
        image.extend_recipe(self.root, ['python3', 'foot'], {'base': {'fedora_release': '44'}})
        profile = ET.parse(self.root / 'platforms/harness.xml')
        self.assertEqual(profile.find('profiles/profile/requires').get('profile'), 'Minimal')
        packages = {element.get('name') for element in profile.findall('packages/package')}
        self.assertTrue({'foot', 'greetd', 'chromium', 'asahi-audio', 'speakersafetyd'} <= packages)
        self.assertFalse(any('gnome' in name or 'plasma' in name for name in packages))
        self.assertEqual(ET.parse(self.root / 'config.xml').findtext('preferences/rpm-check-signatures'), 'true')
        self.assertIn('original partition layout', (self.root / 'platforms/minimal.xml').read_text())
        self.assertIn('update-m1n1 /boot/efi/m1n1/boot.bin', (self.root / 'config.sh').read_text())


class ActualDiskContract(unittest.TestCase):
    def table(self):
        return {'partitiontable': {'label': 'gpt', 'unit': 'sectors', 'sectorsize': 4096, 'partitions': [
            {'start': 256, 'size': 128000, 'type': 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B'},
            {'start': 128256, 'size': 262144, 'type': 'BC13C2FF-59E6-4262-A352-B275FD6F7172'},
            {'start': 390400, 'size': 1048576, 'type': 'B921B045-1DF0-41C3-AF44-4C6F280D3FAE'},
        ]}}

    def test_actual_partition_table_rejects_foreign_overlapping_and_truncated_images(self):
        good = self.table()
        self.assertEqual(len(check.partition_layout(good, 6 * 1024 ** 3)), 3)
        for label in ('sector', 'foreign', 'generic', 'overlap', 'extra'):
            table = self.table()
            part = table['partitiontable']
            if label == 'sector':
                part['sectorsize'] = 512
            elif label == 'foreign':
                part['partitions'][2]['type'] = '7C3457EF-0000-11AA-AA11-00306543ECAC'  # APFS
            elif label == 'generic':
                part['partitions'][2]['type'] = '0FC63DAF-8483-4772-8E79-3D69D8477DE4'
            elif label == 'overlap':
                part['partitions'][2]['start'] = 300000
            else:
                part['partitions'].append(part['partitions'][2])
            with self.subTest(label=label), self.assertRaises(ValueError):
                check.partition_layout(table, 6 * 1024 ** 3)
        with self.assertRaisesRegex(ValueError, 'out-of-bounds'):
            check.partition_layout(good, 1024 ** 3)

    def test_partial_mount_failure_releases_only_its_own_image_devices(self):
        with tempfile.TemporaryDirectory() as temporary:
            calls = []
            def run(*args):
                calls.append(args)
                if args[0] == 'losetup' and '--find' in args:
                    return '/dev/loop7\n'
                if args[0] == 'mount' and '/dev/loop7p2' in args:
                    raise RuntimeError('ext4 mount failed')
                return ''
            with self.assertRaisesRegex(RuntimeError, 'ext4 mount'):
                with check.mounted_image(Path('/image.raw'), Path(temporary), run):
                    self.fail('Must not inspect incomplete mounts')
            self.assertEqual(calls[-2:], [('umount', Path(temporary) / 'esp'), ('losetup', '--detach', '/dev/loop7')])
            self.assertIn('--read-only', calls[0])

    def test_inspection_mounts_prevent_journal_replay_and_release_owned_devices(self):
        with tempfile.TemporaryDirectory() as temporary:
            calls = []
            def run(*args):
                calls.append(args)
                return '/dev/loop7\n' if args[0] == 'losetup' and '--find' in args else ''
            with check.mounted_image(Path('/image.raw'), Path(temporary), run) as mounts:
                self.assertEqual(set(mounts), {'esp', 'boot', 'root'})
                options = {args[-1].name: args[2] for args in calls if args[0] == 'mount'}
                self.assertEqual(options['boot'], 'ro,noload')
                self.assertEqual(options['root'], 'ro,rescue=nologreplay,subvol=root')
                self.assertIn('--read-only', calls[0])
            self.assertEqual(calls[-4:], [('umount', Path(temporary) / label)
                                         for label in ('root', 'boot', 'esp')] +
                                        [('losetup', '--detach', '/dev/loop7')])

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.root, self.boot, self.esp = (self.folder / name for name in ('root', 'boot', 'esp'))
        for folder in (self.root, self.boot, self.esp):
            folder.mkdir()
        self.identity = {'session_package': {'files': {}, 'symlinks': {}}, 'first_boot': {'files': {}}}
        for name, (local, mode) in image.FIRST_BOOT_FILES.items():
            path = self.put(self.root, name, (ROOT / 'os/platforms/apple-silicon' / local).read_text())
            path.chmod(mode)
            self.identity['first_boot']['files'][name] = {'sha256': image.digest(path), 'mode': mode}
        enabled = self.root / 'etc/systemd/system/multi-user.target.wants/harness-firstboot.service'
        enabled.parent.mkdir(parents=True)
        enabled.symlink_to('/usr/lib/systemd/system/harness-firstboot.service')
        files = {
            'usr/share/harness-os/image.json': json.dumps(self.identity),
            'etc/passwd': 'root:x:0:0:root:/root:/bin/bash\nnobody:x:65534:65534:Nobody:/:/sbin/nologin\n',
            'etc/shadow': 'root:!:20732:0:99999:7:::\n',
            'etc/machine-id': 'uninitialized\n', 'etc/hostname': 'harness\n',
            'etc/selinux/config': 'SELINUX=enforcing\n',
        }
        for relative, text in files.items():
            self.put(self.root, relative, text)
        for folder, relative in [(self.boot, 'vmlinuz-test'), (self.boot, 'initramfs-test.img'),
                                 (self.esp, 'm1n1/boot.bin'), (self.esp, 'EFI/BOOT/BOOTAA64.EFI')]:
            self.put(folder, relative, 'x' * 4096)

    def put(self, folder, name, text):
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def inspect(self):
        return check.inspect_root(self.root, self.boot, self.esp, self.identity, owner_uid=os.geteuid())

    def test_actual_root_boot_provenance_and_pristine_identity(self):
        evidence = self.inspect()
        self.assertIn('esp/m1n1/boot.bin', evidence)
        self.assertEqual(evidence['boot/vmlinuz-test']['bytes'], 4096)

    def test_reject_firstboot_tampering_or_already_provisioned_image(self):
        path = self.root / 'usr/lib/harness-os/firstboot.py'
        original = path.read_bytes()
        path.write_text('changed')
        with self.assertRaisesRegex(ValueError, 'first-boot payload'):
            self.inspect()
        path.write_bytes(original)
        done = self.put(self.root, 'var/lib/harness-os/firstboot.done', 'me@harness\n')
        with self.assertRaisesRegex(ValueError, 'already entered'):
            self.inspect()
        done.unlink()
        self.put(self.root, 'etc/systemd/system/multi-user.target.wants/initial-setup.service', 'conflict')
        with self.assertRaisesRegex(ValueError, 'competing'):
            self.inspect()

    def test_reject_known_password_fixture_or_fixed_machine_secrets(self):
        mutations = [
            ('etc/passwd', 'me:x:1000:1000::/home/me:/bin/bash\n', 'pre-provisioned'),
            ('etc/shadow', 'root:$knownpassword:20732:0:99999:7:::\n', 'unlocked root'),
            ('etc/machine-id', 'a' * 32, 'fixed machine ID'),
            ('etc/selinux/config', 'SELINUX=permissive\n', 'SELinux'),
        ]
        for name, text, message in mutations:
            path = self.root / name
            original = path.read_text()
            with self.subTest(name=name):
                path.write_text(text)
                with self.assertRaisesRegex(ValueError, message):
                    self.inspect()
                path.write_text(original)
        self.put(self.root, 'etc/ssh/ssh_host_ed25519_key', 'not for distribution')
        with self.assertRaisesRegex(ValueError, 'SSH host key'):
            self.inspect()

    def test_reject_incomplete_boot_files_and_unproven_payload(self):
        path = self.esp / 'm1n1/boot.bin'
        path.write_bytes(b'')
        with self.assertRaisesRegex(ValueError, 'boot file'):
            self.inspect()
        path.write_bytes(b'x' * 4096)
        self.put(self.root, 'usr/share/harness-os/image.json', '{}')
        with self.assertRaisesRegex(ValueError, 'provenance'):
            self.inspect()


if __name__ == '__main__':
    unittest.main()
