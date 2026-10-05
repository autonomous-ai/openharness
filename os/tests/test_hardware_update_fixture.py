"""Reject plausible false passes in the private changed-kernel acceptance gate."""
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path
import select
import socket
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest

from hardware_update_guest import (EARLY, NVIDIA, database, expected_versions,
    initramfs_identity, module_identity, payload_identity, validate_lock, validate_probe, validate_recovery, validate_transition)
from hardware_update_vm import graceful_stop, verify_image

LOCK = json.loads(Path(__file__).with_name('hardware-update.lock.json').read_text())


def probe(candidate=False):
    kernel = LOCK['candidate' if candidate else 'baseline']['kernel']
    packages = expected_versions(LOCK, candidate)
    modules = {name: {'path': f'/usr/lib/modules/{kernel}/kernel/{name}.ko.zst',
                     'vermagic': kernel + ' SMP preempt mod_unload', 'sha256': 'a' * 64,
                     'version': '615.71.09', 'owner': 'nvidia-open-lts'} for name in NVIDIA}
    modules['wl'] = {'path': f'/usr/lib/modules/{kernel}/updates/dkms/wl.ko.zst',
                     'vermagic': kernel + ' SMP preempt mod_unload', 'sha256': 'b' * 64, 'version': '6.30.223.271'}
    for row in modules.values():
        row.update(resolved_path=row['path'], module_root=f'/usr/lib/modules/{kernel}')
    kernel_hash, initrd_hash = ('c' * 64, 'd' * 64) if candidate else ('e' * 64, 'f' * 64)
    return {'running_kernel': kernel, 'installed_kernel': kernel, 'packages': packages,
            'headers_kernel': kernel, 'package_kernel_sha256': kernel_hash,
            'boot': {'vmlinuz-linux-lts': kernel_hash, 'initramfs-linux-lts.img': initrd_hash, 'grub/grub.cfg': '9' * 64},
            'modules': modules, 'module_root': f'/usr/lib/modules/{kernel}',
            'dkms': f'broadcom-wl/6.30.223.271, {kernel}, x86_64: installed',
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


class ShutdownTests(unittest.TestCase):
    # Real owned subprocess/sockets exercise serial and buffered QMP independently,
    # including quiet guests, stale events and failure to exit. This does not boot
    # a VM or turn simulated transport evidence into native kernel acceptance.
    CHILD = r'''
import json, os, re, signal, socket, sys
channel = socket.socket(fileno=int(sys.argv[1]))
qmp = socket.socket(fileno=int(sys.argv[2]))
mode = sys.argv[3]
powerdown = b'[ 12.34] reboot: Power down\r\n'
shutdown = {'event': 'SHUTDOWN', 'data': {'guest': True, 'reason': 'guest-shutdown'},
            'timestamp': {'seconds': 1234, 'microseconds': 5678}}
def encode(row):
    return (json.dumps(row) + '\r\n').encode()
if mode == 'stale-buffer':
    channel.sendall(powerdown)
barrier = json.loads(qmp.makefile('rb').readline())
assert barrier['execute'] == 'query-status'
response = {'return': {'running': True, 'singlestep': False, 'status': 'running'}, 'id': barrier['id']}
if mode == 'barrier-failure':
    response = {'error': {'class': 'GenericError', 'desc': 'query failed'}, 'id': barrier['id']}
# One write exercises events buffered alongside the correlated response.
qmp.sendall((encode(shutdown) if mode == 'stale-event' else b'') + encode(response))
request = b''
while b'\n' not in request:
    chunk = channel.recv(65536)
    if not chunk:
        sys.exit(0)
    request += chunk
marker = re.search(rb'HN_POWEROFF_[0-9a-f]+', request).group()
if mode == 'unrelated-exception' or mode == 'serial-timeout':
    signal.pause()
if mode in ('ack', 'command-failure'):
    status = b'7' if mode == 'command-failure' else b'0'
    channel.sendall(b'\r\n' + marker + b':' + status + b'\r\n')
if mode not in ('quiet-guest', 'no-proof', 'stale-log', 'stale-buffer', 'stale-event'):
    channel.sendall(powerdown)
channel.close()
if mode == 'qmp-timeout':
    signal.pause()
if mode.startswith('cause-'):
    reason = mode.removeprefix('cause-')
    shutdown['data'] = {'guest': reason.startswith('guest-'), 'reason': reason}
if mode == 'guest-string':
    shutdown['data']['guest'] = 'true'
if mode not in ('no-proof', 'stale-log', 'stale-buffer', 'stale-event', 'kernel-only'):
    qmp.sendall(encode(shutdown))
    if mode == 'duplicate-event':
        qmp.sendall(encode(shutdown))
qmp.close()
if mode == 'exit-timeout':
    signal.pause()
sys.exit(9 if mode == 'nonzero' else 0)
'''

    def exercise(self, mode, expected=None):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            host, guest = socket.socketpair()
            qmp_host, qmp_guest = socket.socketpair()
            qmp_file = qmp_host.makefile('rb')
            process = subprocess.Popen([sys.executable, '-c', self.CHILD, str(guest.fileno()), str(qmp_guest.fileno()), mode],
                                       pass_fds=(guest.fileno(), qmp_guest.fileno()), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            guest.close()
            qmp_guest.close()
            log = (folder / 'serial.log').open('ab', buffering=0)
            if mode == 'stale-log':
                log.write(b'[ 1.0] reboot: Power down\n')
            if mode == 'stale-buffer':
                self.assertTrue(select.select([host], [], [], 5)[0], 'Child did not prepare stale bytes')
            stopped = []

            def send(command):
                if mode == 'unrelated-exception':
                    raise ValueError('unrelated transport error')
                host.sendall(command.encode())
                if mode == 'buffered-exit':
                    process.wait(timeout=5)

            vm = SimpleNamespace(folder=folder, boot_count=2, process=process, serial=host, log=log,
                                 qmp=qmp_host, qmp_file=qmp_file, send=send, stop=lambda: stopped.append(process.poll()))
            try:
                if expected:
                    with self.assertRaises(expected):
                        graceful_stop(vm, True, timeout=.5)
                else:
                    event = graceful_stop(vm, True, timeout=5)
                    self.assertEqual(event['status'], 'passed')
                    self.assertTrue(event['serial_eof'])
                    self.assertEqual(event['guest_power_down'], mode != 'quiet-guest')
                    self.assertEqual(event['guest_shutdown'], {'guest': True, 'reason': 'guest-shutdown'})
                    self.assertEqual(event['qmp_after_request'][0]['timestamp'], {'seconds': 1234, 'microseconds': 5678})
                    self.assertEqual(event['qemu_exit_status'], 0)
                    self.assertEqual(event['command_status'], 0 if mode == 'ack' else None)
                recorded = json.loads((folder / 'shutdown-events.jsonl').read_text())
                self.assertEqual(recorded['qemu_pid'], process.pid)
                self.assertEqual(recorded['status'], 'failed' if expected else 'passed')
                self.assertEqual(stopped, [] if expected else [0], 'Forced cleanup must not establish graceful shutdown')
                if mode == 'stale-event':
                    self.assertEqual(recorded['qmp_before_request'][0]['event'], 'SHUTDOWN')
                    self.assertEqual(recorded['qmp_after_request'], [])
            finally:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)
                process.stderr.close()
                host.close()
                qmp_file.close()
                qmp_host.close()
                log.close()

    def test_real_exit_after_ack_or_early_serial_disconnect(self):
        for mode in ('ack', 'early-disconnect', 'quiet-guest', 'buffered-exit'):
            with self.subTest(mode=mode):
                self.exercise(mode)

    def test_missing_fresh_guest_proof_or_nonzero_exit_fails(self):
        for mode in ('no-proof', 'stale-log', 'stale-buffer', 'stale-event', 'kernel-only', 'nonzero', 'command-failure'):
            with self.subTest(mode=mode):
                self.exercise(mode, AssertionError)

    def test_unrelated_errors_and_transport_or_exit_timeouts_fail(self):
        for mode, error in [('unrelated-exception', ValueError), ('serial-timeout', TimeoutError),
                            ('qmp-timeout', TimeoutError),
                            ('exit-timeout', subprocess.TimeoutExpired)]:
            with self.subTest(mode=mode):
                self.exercise(mode, error)

    def test_host_exit_reboot_panic_and_ambiguous_events_fail(self):
        for mode in ('cause-host-qmp-quit', 'cause-host-signal', 'cause-guest-reset',
                     'cause-guest-panic', 'duplicate-event', 'guest-string', 'barrier-failure'):
            with self.subTest(mode=mode):
                self.exercise(mode, AssertionError)


class AutomaticHooksTests(unittest.TestCase):
    def test_module_alias_resolution_is_strict_and_kernel_scoped(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            kernel = LOCK['baseline']['kernel']
            modules = root / 'usr/lib/modules'
            installed = modules / kernel / 'extramodules/wl.ko'
            installed.parent.mkdir(parents=True)
            installed.write_bytes(b'actual module payload')
            (root / 'lib').symlink_to('usr/lib', target_is_directory=True)
            raw = root / 'lib/modules' / kernel / 'extramodules/wl.ko'
            row = module_identity(raw, kernel, modules)
            self.assertEqual(row['path'], str(raw))
            self.assertEqual(row['resolved_path'], str(installed.resolve()))
            self.assertEqual(row['module_root'], str((modules / kernel).resolve()))
            self.assertEqual(row['sha256'], hashlib.sha256(installed.read_bytes()).hexdigest())
            for other in (LOCK['candidate']['kernel'], kernel + '-other'):
                outside = modules / other / 'wl.ko'
                outside.parent.mkdir()
                outside.write_bytes(installed.read_bytes())
                with self.assertRaisesRegex(AssertionError, 'escapes expected kernel'):
                    module_identity(outside, kernel, modules)
                alias = installed.with_name('escaped.ko')
                alias.symlink_to(outside)
                with self.assertRaisesRegex(AssertionError, 'escapes expected kernel'):
                    module_identity(alias, kernel, modules)
                alias.unlink()
            with self.assertRaisesRegex(AssertionError, 'Not a regular module'):
                module_identity(installed.parent, kernel, modules)
            with self.assertRaises(FileNotFoundError):
                module_identity(installed.with_name('missing.ko'), kernel, modules)

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
                     lambda p: p['modules']['wl'].update(resolved_path='/tmp/usr/lib/modules/' + LOCK['candidate']['kernel'] + '/wl.ko'),
                     lambda p: p['modules']['wl'].update(resolved_path='/usr/lib/modules/' + LOCK['baseline']['kernel'] + '/wl.ko'),
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
            result = payload_identity({'main': extracted}, identity, modules, installed / 'firmware')
            self.assertEqual(set(result), set(EARLY) | {firmware})
            for bad in (extracted / identity['early_modules']['nvidia'], archived):
                good = bad.read_bytes()
                bad.write_bytes(b'stale or corrupt payload under the correct filename')
                with self.assertRaisesRegex(AssertionError, 'different payload bytes'):
                    payload_identity({'main': extracted}, identity, modules, installed / 'firmware')
                bad.write_bytes(good)

    def test_compressed_payload_keeps_its_path_in_early_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            segments = {name: root / name for name in ('early', 'main')}
            kernel = LOCK['baseline']['kernel']
            modules, listings = {}, {'early': [], 'main': []}
            for index, name in enumerate(EARLY):
                segment = 'early' if index == 0 else 'main'
                relative = f'usr/lib/modules/{kernel}/extramodules/{name}.ko' + ('.gz' if segment == 'early' else '')
                archived = segments[segment] / relative
                archived.parent.mkdir(parents=True, exist_ok=True)
                opener = gzip.open if segment == 'early' else open
                with opener(archived, 'wb') as handle:
                    handle.write(('module ' + name).encode())
                source = root / ('installed-' + name + '.ko')
                source.write_bytes(('module ' + name).encode())
                modules[name] = {'path': str(source)}
                listings[segment].append(relative)
            firmware = 'nvidia/615.71.09/gsp_tu10x.bin'
            original = root / 'firmware' / firmware
            original.parent.mkdir(parents=True)
            original.write_bytes(b'GSP bytes')
            archived = segments['early'] / 'usr/lib/firmware' / (firmware + '.gz')
            archived.parent.mkdir(parents=True)
            with gzip.open(archived, 'wb') as handle:
                handle.write(original.read_bytes())
            listings['early'].append(str(archived.relative_to(segments['early'])))
            identity = initramfs_identity('\n'.join(listings['early'] + listings['main']), kernel, [firmware])
            # Reproduce attempt 1: the unchanged compressed filename is listed,
            # but selecting only the main archive cannot find its payload.
            with self.assertRaisesRegex(AssertionError, 'Missing or ambiguous archived module'):
                payload_identity({'main': segments['main']}, identity, modules, root / 'firmware')
            result = payload_identity(segments, identity, modules, root / 'firmware')
            self.assertEqual(result['nvidia']['segment'], 'early')
            self.assertEqual(result['nvidia_drm']['segment'], 'main')
            self.assertEqual(result[firmware]['segment'], 'early')
            for name, relative in [('nvidia', identity['early_modules']['nvidia']),
                                   (firmware, 'usr/lib/firmware/' + firmware + '.gz')]:
                duplicate = segments['main'] / relative
                duplicate.parent.mkdir(parents=True, exist_ok=True)
                duplicate.write_bytes((segments['early'] / relative).read_bytes())
                with self.assertRaisesRegex(AssertionError, 'ambiguous archived'):
                    payload_identity(segments, identity, modules, root / 'firmware')
                with self.assertRaises(AssertionError):
                    initramfs_identity('\n'.join(listings['early'] + listings['main'] + [relative]), kernel, [firmware])
                duplicate.unlink()

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
