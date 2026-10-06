import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('t2_update', Path(__file__).parents[1] / 't2_update.py')
t2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t2)


class T2Updates(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source, self.staging, self.saved = [self.root / x for x in ['source', 'staging', 'saved']]
        for path in [self.source, self.staging, self.saved]:
            path.mkdir()
        self.old = self.kernel('7.2.7')
        self.new = self.kernel('7.2.8')
        (self.root / t2.PIN).parent.mkdir(parents=True)
        (self.root / t2.PIN).write_text(json.dumps(self.old))

    def kernel(self, version):
        pin = copy.deepcopy(json.loads((Path(__file__).parents[1] / 'platforms/apple-t2/kernel.json').read_text()))
        pin['kernel_release'] = version + '-test-t2'
        package = pin['package']
        package.update(version=version + '-1', filename='linux-t2-' + version + '-1-x86_64.pkg.tar.zst')
        package['url'] = t2.UPSTREAM + 'v' + version + '/' + package['filename']
        prefix = 'usr/lib/modules/' + pin['kernel_release'] + '/'
        files = {'.PKGINFO': ('pkgname = linux-t2\npkgbase = linux-t2\npkgver = ' + version + '-1\narch = x86_64\n').encode(),
                 prefix + 'pkgbase': b'linux-t2\n', prefix + 'vmlinuz': bytes(0x202) + b'HdrS' + version.encode()}
        for name in pin['required_modules']:
            files[prefix + 'kernel/' + name + '.ko.zst'] = (version + name).encode()
        raw = self.root / (version + '.tar')
        with tarfile.open(raw, 'w') as output:
            for name, data in files.items():
                member = tarfile.TarInfo(name)
                member.mode, member.size = 0o644, len(data)
                output.addfile(member, io.BytesIO(data))
        path = self.source / package['filename']
        subprocess.run(['zstd', '-q', str(raw), '-o', str(path)], check=True, timeout=10)
        package.update(t2.KERNEL.identity(path))
        return pin

    def commands(self, argv, **kwargs):
        if argv[0] == 'vercmp':
            return '1\n'
        if argv == ['pacman', '-Q', 'linux-t2']:
            return 'linux-t2 ' + self.old['package']['version'] + '\n'
        raise AssertionError(argv)

    def prepare(self):
        with patch.object(t2.subprocess, 'check_output', side_effect=self.commands), \
                patch.object(t2, 'download', side_effect=AssertionError('Offline bundle must not use network')):
            return t2.prepare(self.new, self.source, self.staging, self.root)

    def harness_package(self, pin):
        target = self.root / 'previous-harness.pkg.tar.gz'
        with tarfile.open(target, 'w:gz') as output:
            data = json.dumps(pin).encode()
            member = tarfile.TarInfo(str(t2.PIN))
            member.size = len(data)
            output.addfile(member, io.BytesIO(data))
        return target

    def test_offline_staging_and_retained_rollback_verify_real_archives(self):
        change = self.prepare()
        self.assertEqual(change['candidate'], self.new)
        self.assertEqual(change['previous'], self.old)
        self.assertEqual(set(change['candidate_files']), {'.PKGINFO', 'pkgbase', 'vmlinuz', *self.new['required_modules']})
        self.assertEqual((self.staging / self.new['package']['filename']).stat().st_mode & 0o777, 0o600)
        t2.retain(change, self.staging, self.saved)
        package = self.harness_package(self.old)
        with patch.object(t2, 'download', side_effect=AssertionError('Rollback must remain offline')):
            previous = t2.rollback(change, self.saved, package)
        self.assertEqual(t2.KERNEL.identity(previous), t2.KERNEL.identity(self.source / self.old['package']['filename']))
        previous.write_bytes(b'corrupt rollback')
        with self.assertRaisesRegex(ValueError, 'pinned artifact'):
            t2.rollback(change, self.saved, package)

    def test_corrupt_supplied_kernel_cannot_be_used_or_silently_downloaded(self):
        (self.source / self.new['package']['filename']).write_bytes(b'incomplete')
        with self.assertRaisesRegex(ValueError, 'pinned artifact'):
            self.prepare()

    def test_rollback_refuses_an_unrelated_harness_kernel_pin(self):
        change = self.prepare()
        t2.retain(change, self.staging, self.saved)
        with self.assertRaisesRegex(ValueError, 'rollback and retained'):
            t2.rollback(change, self.saved, self.harness_package(self.new))

    def test_unchanged_pin_does_not_download_and_downgrade_is_refused(self):
        with patch.object(t2, 'stage', side_effect=AssertionError('No download')), \
                patch.object(t2.subprocess, 'check_output', return_value='-1'):
            self.assertIsNone(t2.prepare(self.old, self.source, self.staging, self.root))
            with self.assertRaisesRegex(ValueError, 'advance the pinned'):
                t2.prepare(self.new, self.source, self.staging, self.root)

    def test_malformed_download_identity_and_boot_contract_are_rejected(self):
        changes = [lambda p: p['package'].update(name='linux-lts'),
                   lambda p: p['package'].update(filename='../elsewhere'),
                   lambda p: p['package'].update(bytes=True),
                   lambda p: p['package'].update(bytes=257 * 1024 * 1024),
                   lambda p: p['package'].update(url='file:///etc/passwd'),
                   lambda p: p['package'].update(url=p['package']['url'].replace('github.com/', 'github.com.evil.test/')),
                   lambda p: p.update(early_modules=['brcmfmac']),
                   lambda p: p.update(kernel_parameters=['init=/bin/sh'])]
        for change in changes:
            pin = copy.deepcopy(self.new)
            change(pin)
            with self.subTest(pin=pin), self.assertRaises(ValueError):
                t2.validate_pin(pin)

    def test_streamed_download_rejects_corruption_truncation_and_http_redirect(self):
        good = (self.source / self.new['package']['filename']).read_bytes()
        for data, url in [(good, self.new['package']['url']), (b'wrong', self.new['package']['url']),
                          (good + b'extra', self.new['package']['url']), (good, 'http://example.test/file')]:
            response = io.BytesIO(data)
            response.url = url
            target = self.staging / 'download.pkg.tar.zst'
            with patch.object(t2, 'urlopen', return_value=response):
                if data == good and url.startswith('https://'):
                    t2.download(self.new, target)
                    self.assertEqual(target.read_bytes(), good)
                    target.unlink()
                else:
                    with self.assertRaises(ValueError):
                        t2.download(self.new, target)
                    self.assertFalse(target.exists())

    def test_readback_detects_missing_unlock_module_and_altered_kernel(self):
        change = self.prepare()
        selected = change['candidate_files']
        raw = self.root / '7.2.8.tar'
        # Extract only the invented fixture files into this disposable test root.
        with tarfile.open(raw) as archive:
            for member in archive:
                if member.name == '.PKGINFO':
                    continue
                target = self.root / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.extractfile(member).read())
        (self.root / t2.PIN).write_text(json.dumps(self.new))
        boot = self.root / 'boot'
        (boot / 'grub').mkdir(parents=True)
        (boot / 'vmlinuz-linux-t2').write_bytes((self.root / selected['vmlinuz']['path']).read_bytes())
        (boot / 'grub/grub.cfg').write_text('vmlinuz-linux-t2 ' + ' '.join(self.new['kernel_parameters']))
        files = ''.join('/' + name + '.ko.zst\n' for name in self.new['early_modules'])
        def command(argv, **kwargs):
            if argv[0] == 'pacman': return 'linux-t2 ' + self.new['package']['version']
            if argv[0] == 'modinfo': return self.new['kernel_release'] + ' SMP preempt '
            if argv[0] == 'lsinitcpio': return files
            raise AssertionError(argv)
        with patch.object(t2.subprocess, 'check_output', side_effect=command):
            t2.verify(self.new, selected, self.root)
            files = ''
            with self.assertRaisesRegex(ValueError, 'unlock input module missing'):
                t2.verify(self.new, selected, self.root)
            (boot / 'vmlinuz-linux-t2').write_bytes(b'wrong kernel')
            with self.assertRaisesRegex(ValueError, 'boot kernel differs'):
                t2.verify(self.new, selected, self.root)


if __name__ == '__main__':
    unittest.main()
