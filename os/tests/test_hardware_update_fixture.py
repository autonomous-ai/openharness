"""Reject plausible false passes in the private changed-kernel acceptance gate."""
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from hardware_update_guest import (EARLY, NVIDIA, database, expected_versions,
    initramfs_identity, payload_identity, validate_lock, validate_probe, validate_recovery, validate_transition)
from hardware_update_vm import verify_image

LOCK = json.loads(Path(__file__).with_name('hardware-update.lock.json').read_text())


def probe(candidate=False):
    kernel = LOCK['candidate' if candidate else 'baseline']['kernel']
    packages = expected_versions(LOCK, candidate)
    modules = {name: {'path': f'/usr/lib/modules/{kernel}/kernel/{name}.ko.zst',
                     'vermagic': kernel + ' SMP preempt mod_unload', 'sha256': 'a' * 64,
                     'version': '615.71.09', 'owner': 'nvidia-open-lts'} for name in NVIDIA}
    modules['wl'] = {'path': f'/usr/lib/modules/{kernel}/updates/dkms/wl.ko.zst',
                     'vermagic': kernel + ' SMP preempt mod_unload', 'sha256': 'b' * 64, 'version': '6.30.223.271'}
    kernel_hash, initrd_hash = ('c' * 64, 'd' * 64) if candidate else ('e' * 64, 'f' * 64)
    return {'running_kernel': kernel, 'installed_kernel': kernel, 'packages': packages,
            'headers_kernel': kernel, 'package_kernel_sha256': kernel_hash,
            'boot': {'vmlinuz-linux-lts': kernel_hash, 'initramfs-linux-lts.img': initrd_hash, 'grub/grub.cfg': '9' * 64},
            'modules': modules, 'dkms': f'broadcom-wl/6.30.223.271, {kernel}, x86_64: installed',
            'initramfs': {'kernel_namespaces': [kernel], 'early_modules': dict.fromkeys(EARLY, 'present')},
            'runtime': {'files': LOCK['baseline']['runtime_files'], 'runtime_json_sha256': '8' * 64},
            'system_sha256': '7' * 64, 'pacman_config': 'original dated config', 'install': {'root_uuid': 'root', 'boot_uuid': 'boot'}}


class LockTests(unittest.TestCase):
    def test_recorded_different_kernel_target(self):
        validate_lock(LOCK)

    def test_same_kernel_and_partial_headers_are_rejected(self):
        for mutation in ('kernel', 'headers'):
            with self.subTest(mutation=mutation):
                lock = copy.deepcopy(LOCK)
                if mutation == 'kernel':
                    lock['candidate']['kernel'] = lock['baseline']['kernel']
                else:
                    lock['candidate']['packages']['linux-lts-headers']['version'] = lock['baseline']['packages']['linux-lts-headers']
                with self.assertRaises(AssertionError):
                    validate_lock(lock)

    def test_mixed_dates_or_live_mirror_are_rejected(self):
        for url in ('https://archive.archlinux.org/repos/2026/10/03/extra/os/x86_64/extra.db',
                    'https://mirror.example/extra/os/x86_64/extra.db'):
            lock = copy.deepcopy(LOCK)
            lock['candidate']['repositories']['extra']['url'] = url
            with self.assertRaises(AssertionError):
                validate_lock(lock)


class ArtifactTests(unittest.TestCase):
    def test_exact_manifest_source_and_image_bytes_required(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            iso = root / 'fixture.iso'
            iso.write_bytes(b'original immutable image')
            lock = copy.deepcopy(LOCK)
            old = lock['baseline']
            old['iso'] = dict(name=iso.name, bytes=iso.stat().st_size, sha256=hashlib.sha256(iso.read_bytes()).hexdigest())
            manifest = {'source_commit': old['source_commit'], 'iso': old['iso'],
                        'arch_snapshot': old['snapshot'], 'package_version': old['packages']['harness-os'],
                        'harness_inputs': {'files': old['runtime_files'], 'source_commit': old['source_commit']},
                        'capabilities': ['broadcom-offline', 'nvidia-offline']}
            path = root / 'manifest.json'
            path.write_text(json.dumps(manifest))
            old['manifest_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(verify_image(iso, lock), manifest)
            iso.write_bytes(b'changed! immutable image')
            with self.assertRaises(AssertionError):
                verify_image(iso, lock)
            iso.write_bytes(b'original immutable image')
            manifest['source_commit'] = '0' * 40
            path.write_text(json.dumps(manifest))
            with self.assertRaises(AssertionError):
                verify_image(iso, lock)

    def test_archive_database_preserves_signature_and_epoch(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'extra.db'
            data = b'%NAME%\nnvidia-open-lts\n\n%VERSION%\n1:615.71.09-7\n\n%PGPSIG%\nYWN0dWFsLXNpZ25hdHVyZQ==\n\n'
            with tarfile.open(path, 'w:gz') as archive:
                info = tarfile.TarInfo('nvidia-open-lts-615.71.09-7/desc')
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            parsed = database(path)['nvidia-open-lts']
            self.assertEqual(parsed['VERSION'], ['1:615.71.09-7'])
            self.assertEqual(parsed['PGPSIG'], ['YWN0dWFsLXNpZ25hdHVyZQ=='])


class AutomaticHooksTests(unittest.TestCase):
    def test_pre_reboot_uname_stays_old_but_new_modules_are_checked(self):
        row = probe(True)
        row['running_kernel'] = LOCK['baseline']['kernel']
        validate_probe(row, LOCK, True, LOCK['baseline']['kernel'])
        with self.assertRaises(AssertionError):
            validate_probe(row, LOCK, True, LOCK['candidate']['kernel'])

    def test_missing_dkms_rebuild_wrong_abi_and_nvidia_fallback_fail(self):
        mutations = [lambda p: p.update(dkms=''),
                     lambda p: p['modules']['wl'].update(vermagic=LOCK['baseline']['kernel'] + ' SMP'),
                     lambda p: p['modules']['nvidia_uvm'].update(vermagic=LOCK['baseline']['kernel'] + ' SMP'),
                     lambda p: p['modules']['nvidia'].update(owner='nvidia-open-dkms'),
                     lambda p: p['modules']['nvidia_modeset'].update(version='previous-version'),
                     lambda p: p.update(headers_kernel=LOCK['baseline']['kernel']),
                     lambda p: p.update(package_kernel_sha256='stale-boot-kernel')]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                row = probe(True)
                mutation(row)
                with self.assertRaises(AssertionError):
                    validate_probe(row, LOCK, True, LOCK['candidate']['kernel'])

    def test_initramfs_needs_new_namespace_early_gpu_and_gsp_not_wl(self):
        kernel = LOCK['candidate']['kernel']
        firmware = ['nvidia/615.71.09/gsp_ga10x.bin', 'nvidia/615.71.09/gsp_tu10x.bin']
        lines = [f'usr/lib/modules/{kernel}/kernel/drivers/video/{name}.ko.zst' for name in EARLY]
        lines += ['usr/lib/firmware/' + name + '.zst' for name in firmware]
        listing = '\n'.join(lines)
        self.assertEqual(initramfs_identity(listing, kernel, firmware)['kernel_namespaces'], [kernel])
        for invalid in (listing.replace(kernel, LOCK['baseline']['kernel']), '\n'.join(lines[1:]),
                        '\n'.join(lines[:-1]), listing + '\nusr/lib/modules/another/kernel/stale.ko'):
            with self.subTest(invalid=invalid), self.assertRaises(AssertionError):
                initramfs_identity(invalid, kernel, firmware)

    def test_changed_package_labels_do_not_substitute_for_changed_kernel_bytes(self):
        old, new = probe(), probe(True)
        validate_transition(old, new)
        new['boot']['vmlinuz-linux-lts'] = old['boot']['vmlinuz-linux-lts']
        with self.assertRaises(AssertionError):
            validate_transition(old, new)

    def test_correct_initramfs_names_with_stale_module_or_gsp_bytes_fail(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            installed, extracted = root / 'installed', root / 'initrd'
            firmware = 'nvidia/615.71.09/gsp_tu10x.bin'
            identity = {'early_modules': {}, 'firmware': [firmware]}
            modules = {}
            for name in EARLY:
                relative = 'usr/lib/modules/new/kernel/' + name + '.ko'
                archived = extracted / relative
                archived.parent.mkdir(parents=True, exist_ok=True)
                archived.write_bytes(('module payload ' + name).encode())
                source = installed / (name + '.ko.gz')
                source.parent.mkdir(parents=True, exist_ok=True)
                with gzip.open(source, 'wb') as handle:
                    handle.write(archived.read_bytes())
                modules[name] = {'path': str(source)}
                identity['early_modules'][name] = relative
            original = installed / 'firmware' / firmware
            original.parent.mkdir(parents=True)
            original.write_bytes(b'signed GSP payload')
            archived = extracted / 'usr/lib/firmware' / firmware
            archived.parent.mkdir(parents=True)
            archived.write_bytes(original.read_bytes())
            result = payload_identity(extracted, identity, modules, installed / 'firmware')
            self.assertEqual(set(result), set(EARLY) | {firmware})
            for bad in (extracted / identity['early_modules']['nvidia'], archived):
                good = bad.read_bytes()
                bad.write_bytes(b'stale or corrupt payload under the correct filename')
                with self.assertRaisesRegex(AssertionError, 'different payload bytes'):
                    payload_identity(extracted, identity, modules, installed / 'firmware')
                bad.write_bytes(good)

    def test_runtime_must_stay_frozen_while_distro_packages_may_change(self):
        old, new = probe(), probe(True)
        old['packages']['nodejs'], new['packages']['nodejs'] = '22.1-1', '22.2-1'
        validate_transition(old, new)
        new['runtime']['runtime_json_sha256'] = 'changed-runtime'
        with self.assertRaises(AssertionError):
            validate_transition(old, new)


class RecoveryTests(unittest.TestCase):
    def test_full_root_boot_and_later_project_edit_must_agree(self):
        old, restored = probe(), probe()
        transaction = {'checkpoint': {'boot_sha256': old['boot']}}
        project = {'keep.txt': {'sha256': 'edited-after-checkpoint', 'uid': 1000, 'gid': 1000, 'mtime_ns': 42},
                   'new.txt': {'sha256': 'new-after-checkpoint', 'uid': 1000, 'gid': 1000, 'mtime_ns': 43}}
        validate_recovery(old, restored, transaction, project, copy.deepcopy(project))
        for mutation in (lambda r: r['packages'].update({'linux-lts-headers': 'wrong'}),
                         lambda r: r['boot'].update({'grub/grub.cfg': 'changed'}),
                         lambda r: r['modules']['wl'].update(sha256='newer-module'),
                         lambda r: r.update(running_kernel=LOCK['candidate']['kernel']),
                         lambda r: r.update(pacman_config='new snapshot')):
            row = copy.deepcopy(restored)
            mutation(row)
            with self.assertRaises(AssertionError):
                validate_recovery(old, row, transaction, project, project)
        for changed in ({'keep.txt': project['keep.txt']},
                        {**project, 'keep.txt': {'sha256': 'old-before-checkpoint', 'uid': 1000, 'gid': 1000, 'mtime_ns': 1}}):
            with self.assertRaises(AssertionError):
                validate_recovery(old, restored, transaction, project, changed)


if __name__ == '__main__':
    unittest.main()
