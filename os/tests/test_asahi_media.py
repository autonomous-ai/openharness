import copy
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'os/tools'))
import asahi_media as build
import asahi_media_check as check

spec = importlib.util.spec_from_file_location('asahi_media_runtime', ROOT / 'os/platforms/apple-silicon/media.py')
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)


class Media(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.payload = self.root / 'payload.raw'
        self.payload.write_bytes(b'private image fixture')
        self.image_source = 'a' * 40
        self.producer = {'head_sha': self.image_source, 'id': 123, 'path': '.github/workflows/os-asahi-image.yml',
                         'repository': {'full_name': 'autonomous-ai/openharness'},
                         'status': 'completed', 'conclusion': 'success'}
        self.receipt = {'status': 'passed', 'image': {'kind': 'harness-asahi-image-construction',
            'source_commit': self.image_source, 'profile': 'Harness', 'published': False, 'release_ready': False},
            'artifact': {'bytes': self.payload.stat().st_size, 'sha256': build.digest(self.payload)}}
        self.identity = {'schema': 1, 'kind': 'harness-asahi-installer-media', 'source_commit': 'b' * 40,
            'published': False, 'release_ready': False, 'payload': {'source_commit': self.image_source,
                'bytes': self.payload.stat().st_size, 'sha256': build.digest(self.payload)}}
        self.manifest = self.root / 'media.json'
        self.manifest.write_text(json.dumps(self.identity))

    def test_only_successfully_inspected_same_repository_image_is_packaged(self):
        good = build.payload_identity(self.payload, self.receipt, self.producer, self.image_source)
        self.assertEqual(good['sha256'], build.digest(self.payload))
        for key, value in [('head_sha', 'c' * 40), ('conclusion', 'failure'),
                           ('repository', {'full_name': 'other/repo'}), ('path', 'unrelated.yml')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                build.payload_identity(self.payload, self.receipt, {**self.producer, key: value}, self.image_source)
        bad = copy.deepcopy(self.receipt)
        bad['image']['source_commit'] = 'c' * 40
        with self.assertRaisesRegex(ValueError, 'provenance'):
            build.payload_identity(self.payload, bad, self.producer, self.image_source)

    def test_corrupt_and_symlink_payloads_cannot_be_packaged(self):
        link = self.root / 'link.raw'
        link.symlink_to(self.payload)
        with self.assertRaisesRegex(ValueError, 'differs'):
            build.payload_identity(link, self.receipt, self.producer, self.image_source)
        self.payload.write_bytes(b'X' * self.payload.stat().st_size)
        with self.assertRaisesRegex(ValueError, 'differs'):
            build.payload_identity(self.payload, self.receipt, self.producer, self.image_source)

    def test_live_manifest_rejects_missing_identity_size_and_writable_files(self):
        self.assertEqual(media.identity(self.root, os.geteuid()), self.identity)
        for key, value in [('sha256', 'bad'), ('source_commit', 'main'), ('bytes', 0)]:
            bad = copy.deepcopy(self.identity)
            bad['payload'][key] = value
            self.manifest.write_text(json.dumps(bad))
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'manifest'):
                media.identity(self.root, os.geteuid())
        self.manifest.write_text(json.dumps(self.identity))
        self.payload.chmod(0o666)
        with self.assertRaisesRegex(ValueError, 'files have changed'):
            media.identity(self.root, os.geteuid())
        self.payload.chmod(0o644)
        original = self.root / 'original.raw'
        self.payload.rename(original)
        self.payload.symlink_to(original)
        with self.assertRaisesRegex(ValueError, 'files have changed'):
            media.identity(self.root, os.geteuid())

    def test_live_loop_is_readonly_4096_byte_and_detached_after_failed_install(self):
        calls = []
        def run(*args):
            calls.append(args)
            return '/dev/loop9' if '--find' in args else ''
        with patch.object(media, 'identity', return_value=self.identity), \
                patch.object(media.installer.storage, 'run', side_effect=run):
            with self.assertRaisesRegex(RuntimeError, 'install failed'):
                with media.payload_device(self.root) as payload:
                    self.assertEqual(payload.sha256, self.identity['payload']['sha256'])
                    self.assertEqual(payload.device, '/dev/loop9')
                    raise RuntimeError('install failed')
        self.assertEqual(calls[0], ('losetup', '--find', '--show', '--read-only', '--partscan',
                                   '--sector-size', '4096', self.payload))
        self.assertEqual(calls[-1], ('losetup', '--detach', '/dev/loop9'))

    def test_device_settle_failure_also_releases_owned_loop(self):
        calls = []
        def run(*args):
            calls.append(args)
            if args[0] == 'udevadm':
                raise RuntimeError('settle failed')
            return '/dev/loop9' if '--find' in args else ''
        with patch.object(media, 'identity', return_value=self.identity), \
                patch.object(media.installer.storage, 'run', side_effect=run):
            with self.assertRaisesRegex(RuntimeError, 'settle failed'):
                with media.payload_device(self.root):
                    self.fail('Must not start without the source devices')
        self.assertEqual(calls[-1], ('losetup', '--detach', '/dev/loop9'))

    def test_recipe_keeps_signed_asahi_boot_without_installed_or_desktop_profiles(self):
        includes = ('repositories/core.xml', 'repositories/asahi.xml', 'components/boot.xml',
                    'components/base.xml', 'platforms/minimal.xml', 'platforms/workstation.xml')
        (self.root / 'config.xml').write_text('<image name="Fedora-Asahi-Remix"><description><specification/>'
            '</description><preferences><release-version>44</release-version><rpm-check-signatures>true'
            '</rpm-check-signatures></preferences>' + ''.join('<include from="this://./' + p + '"/>'
                                                             for p in includes) + '</image>')
        build.live_recipe(self.root)
        recipe = ET.parse(self.root / 'config.xml')
        self.assertEqual({n.get('from') for n in recipe.findall('include')},
            {'this://./' + p for p in includes[:3]})
        live = recipe.find('preferences/type')
        self.assertEqual(live.get('flags'), 'overlay')
        self.assertEqual(live.get('filesystem'), 'squashfs')
        self.assertEqual(live.get('hybridpersistent'), 'false')
        self.assertNotIn('rd.live.overlay.persistent', live.get('kernelcmdline'))
        self.assertIn('systemd.unit=multi-user.target', live.get('kernelcmdline'))
        self.assertEqual(recipe.findtext('preferences/rpm-check-signatures'), 'true')
        self.assertEqual(recipe.findtext('preferences/locale'), 'C')
        selected = {p.get('name') for p in recipe.findall('packages/package')}
        self.assertTrue({'dracut-kiwi-live', 'cryptsetup', 'rsync', 'grub2-efi-aa64-cdboot'} <= selected)
        self.assertFalse(selected & {'harness-os-session', 'greetd', 'chromium', 'initial-setup'})


class FirmwareMedia(unittest.TestCase):
    def test_only_one_bounded_gpt_esp_can_be_mounted(self):
        partition = {'type': 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B', 'start': 4096, 'size': 40960}
        table = {'label': 'gpt', 'unit': 'sectors', 'sectorsize': 512, 'partitions': [partition]}
        document = {'partitiontable': table}
        self.assertEqual(check.efi_partition(document, 24 * 1024**2),
                         {'offset': 2 * 1024**2, 'bytes': 20 * 1024**2})
        for change in ({'label': 'dos'}, {'sectorsize': 4096}, {'partitions': []},
                       {'partitions': [partition, partition]},
                       {'partitions': [{**partition, 'start': 0}]},
                       {'partitions': [{**partition, 'size': 100000}]}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                check.efi_partition({'partitiontable': {**table, **change}}, 24 * 1024**2)

    def test_firmware_files_require_arm64_executables_and_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            esp = Path(tmp)
            boot = esp / 'EFI/BOOT'
            boot.mkdir(parents=True)
            pe = bytearray(2048)
            pe[:2] = b'MZ'
            struct.pack_into('<I', pe, 0x3c, 128)
            pe[128:132] = b'PE\0\0'
            struct.pack_into('<H', pe, 132, 0xaa64)
            struct.pack_into('<H', pe, 152, 0x20b)
            struct.pack_into('<H', pe, 220, 10)
            shim = boot / 'BOOTAA64.EFI'
            shim.write_bytes(pe)
            (boot / 'grubaa64.efi').write_bytes(pe)
            config = boot / 'grub.cfg'
            config.write_text('configfile /boot/grub2/grub.cfg\n')
            self.assertEqual(len(check.inspect_efi(esp)), 3)
            for offset, value in ((132, 0x8664), (152, 0x10b), (220, 3)):
                bad = bytearray(pe)
                struct.pack_into('<H', bad, offset, value)
                shim.write_bytes(bad)
                with self.subTest(offset=offset), self.assertRaisesRegex(ValueError, 'ARM64'):
                    check.inspect_efi(esp)
            shim.write_bytes(pe)
            config.unlink()
            with self.assertRaisesRegex(ValueError, 'Missing'):
                check.inspect_efi(esp)


class PolicyMedia(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.source = self.root / 'source'
        for name in ('etc/selinux/targeted/policy/policy.35',
                     'etc/selinux/targeted/contexts/files/file_contexts',
                     'var/lib/selinux/targeted/active/policy.kern'):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(name.encode())

    def test_installed_policy_and_store_are_copied_exactly(self):
        output = self.root / 'stage'
        expected = build.policy_inventory(self.source, os.geteuid())
        self.assertEqual(build.stage_policy(self.source, output, os.geteuid()), expected)
        self.assertEqual(build.policy_inventory(output, os.geteuid()), expected)
        for name in expected:
            self.assertEqual((self.source / name).read_bytes(), (output / name).read_bytes())

    def test_incomplete_or_ambiguous_compiled_policy_is_refused(self):
        binary = self.source / 'etc/selinux/targeted/policy/policy.35'
        binary.rename(binary.with_name('policy.34'))
        binary.write_bytes(b'Other policy')
        with self.assertRaisesRegex(ValueError, 'complete installed SELinux policy'):
            build.policy_inventory(self.source, os.geteuid())
        binary.unlink()
        (self.source / 'var/lib/selinux/targeted/active/policy.kern').unlink()
        with self.assertRaisesRegex(ValueError, 'complete installed SELinux policy'):
            build.policy_inventory(self.source, os.geteuid())

    def test_redirected_writable_and_special_policy_files_are_refused(self):
        binary = self.source / 'etc/selinux/targeted/policy/policy.35'
        binary.chmod(0o666)
        with self.assertRaisesRegex(ValueError, 'unexpected type, owner or mode'):
            build.policy_inventory(self.source, os.geteuid())
        binary.unlink()
        binary.symlink_to(self.root / 'outside')
        with self.assertRaisesRegex(ValueError, 'unexpected type, owner or mode'):
            build.policy_inventory(self.source, os.geteuid())
        binary.unlink()
        os.mkfifo(binary, 0o600)
        with self.assertRaisesRegex(ValueError, 'unexpected type, owner or mode'):
            build.policy_inventory(self.source, os.geteuid())

    def test_policy_parent_cannot_redirect_the_copy(self):
        parent = self.source / 'etc/selinux'
        original = parent.with_name('saved-selinux')
        parent.rename(original)
        parent.symlink_to(original)
        with self.assertRaisesRegex(ValueError, 'path was redirected'):
            build.stage_policy(self.source, self.root / 'stage', os.geteuid())
        self.assertFalse((self.root / 'stage').exists())

    def test_failed_unmount_never_deletes_the_source_tree(self):
        mount = self.root / 'mount'
        mount.mkdir()
        sentinel = mount / 'keep'
        calls = []
        def run(*args):
            calls.append(args)
            if args[0] == 'losetup':
                return '/dev/loop9'
            if args[0] == 'mount':
                sentinel.write_text('Read-only source data')
            if args[0] == 'umount':
                raise RuntimeError('Unmount failed')
            return ''
        with patch.object(build.tempfile, 'mkdtemp', return_value=str(mount)), \
                patch.object(build, 'run', side_effect=run):
            with self.assertRaisesRegex(RuntimeError, 'Unmount failed'):
                with build.image_root(self.root / 'verified.raw'):
                    pass
        self.assertEqual(sentinel.read_text(), 'Read-only source data')
        self.assertFalse(any('--detach' in command for command in calls))


if __name__ == '__main__':
    unittest.main()
