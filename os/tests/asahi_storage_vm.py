#!/usr/bin/env python3
"""Fresh encrypted Asahi payload install with real interruption and offline retries."""
import argparse
import json
from pathlib import Path
import platform
import re
import subprocess
import time

from arm_boot import digest
from arm_session import fixture_identity
from asahi_encryption_vm import MaintenanceVM
from asahi_target_vm import guest as target_guest
from session_vm import put

ROOT = Path(__file__).resolve().parents[1]


def storage_guest(vm, action, image_hash, source):
    for name in ('storage.py', 'target.py'):
        put(vm, '/var/tmp/' + name, (ROOT / 'platforms/apple-silicon' / name).read_text())
    put(vm, '/var/tmp/harness-storage-guest.py', Path(__file__).with_name('asahi_storage_guest.py').read_text())
    put(vm, '/var/tmp/harness-storage-input.json', json.dumps({'image_sha256': image_hash, 'source_commit': source}))
    output, code = vm.command('unshare --mount --propagation private python3 /var/tmp/harness-storage-guest.py ' + action,
                              timeout=420, check=False)
    expected = {'interrupt-encryption': 76, 'interrupt-copy': 77, 'finish': 0}[action]
    if code != expected:
        raise RuntimeError(f'{action} exited {code}, expected {expected}: {output[-6000:]}')
    if code:
        return {'exit_code': code, 'phase': action}
    raw = vm.read_file('/var/tmp/harness-storage-result.json')
    (vm.folder / 'result.json').write_bytes(raw)
    return json.loads(raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--fixture-source', required=True)
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--image-source', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if (platform.system(), platform.machine()) != ('Darwin', 'arm64'):
        parser.error('Use the native Apple Silicon host observer.')
    if not re.fullmatch('[a-f0-9]{40}', args.image_source) or not re.fullmatch('[a-f0-9]{64}', args.sha256):
        parser.error('Use full source and image SHA-256 identities.')
    source = args.image.resolve()
    if args.image.is_symlink() or not source.is_file() or digest(source) != args.sha256:
        parser.error('Use the regular, SHA-256-verified private image.')
    info = fixture_identity(args.fixture, args.fixture_source)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    maintenance, disk = output / 'maintenance.raw', output / 'target.raw'
    with disk.open('xb') as handle:
        handle.truncate(24 * 1024**3)
    subprocess.run(['zstd', '-d', '--sparse', args.fixture / 'guest.raw.zst', '-o', maintenance], check=True, timeout=120)
    assert digest(maintenance) == info['raw_disk']['sha256']
    paths = [ROOT / 'platforms/apple-silicon' / name for name in ('target.py', 'storage.py')]
    paths += [ROOT / 'tools/fedora_payload.py']
    paths += [Path(__file__).with_name(name) for name in
              ('asahi_storage_vm.py', 'asahi_storage_guest.py', 'asahi_target_vm.py', 'asahi_target_guest.py',
               'asahi_encryption_vm.py', 'asahi_encryption_guest.py', 'asahi_firstboot_vm.py',
               'arm_boot.py', 'arm_session.py', 'fedora_session_vm.py', 'session_vm.py', 'vm.py')]
    receipt = {'status': 'running', 'started_at': time.time(), 'publication': False,
               'image_sha256': args.sha256, 'image_source': args.image_source,
               'maintenance_source': args.fixture_source, 'fixture_manifest_sha256': digest(args.fixture / 'manifest.json'),
               'inputs': {str(path.relative_to(ROOT)): digest(path) for path in paths},
               'limitations': ['QEMU supplies the firmware ESP UUID; protected macOS/recovery partitions contain sentinels.',
                               'No physical Apple or complete bootable installer claim.',
                               'Known public test password: never publish the resulting disk.'], 'shutdowns': []}
    vm = None
    try:
        vm = MaintenanceVM(output / 'prepare', maintenance, args.fixture / 'Image', disk, source=source)
        vm.start()
        vm.command('dnf5 install -y --setopt=install_weak_deps=False --setopt=gpgcheck=True gdisk dosfstools cryptsetup btrfs-progs e2fsprogs rsync', timeout=180)
        receipt['initialize'] = target_guest(vm, 'initialize', output)
        receipt['partition_interruption'] = target_guest(vm, 'interrupt', output)
        receipt['shutdowns'].append(vm.poweroff())
        vm.close()
        vm = MaintenanceVM(output / 'encryption', maintenance, args.fixture / 'Image', disk, source=source)
        vm.start(offline=True)
        receipt['target_acceptance'] = target_guest(vm, 'resume', output)
        receipt['encryption_interruption'] = storage_guest(vm, 'interrupt-encryption', args.sha256, args.image_source)
        receipt['shutdowns'].append(vm.poweroff())
        vm.close()
        vm = MaintenanceVM(output / 'partial-copy', maintenance, args.fixture / 'Image', disk, source=source)
        vm.start(offline=True)
        receipt['copy_interruption'] = storage_guest(vm, 'interrupt-copy', args.sha256, args.image_source)
        receipt['shutdowns'].append(vm.poweroff())
        vm.close()
        vm = MaintenanceVM(output / 'completed-copy', maintenance, args.fixture / 'Image', disk, source=source)
        vm.start(offline=True)
        receipt['result'] = storage_guest(vm, 'finish', args.sha256, args.image_source)
        receipt['shutdowns'].append(vm.poweroff())
        receipt['status'] = 'passed'
        print('Fresh LUKS2 enrollment, interrupted rsync, offline reboot/resume and preserved work passed.', flush=True)
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        raise
    finally:
        try:
            if vm:
                vm.close()
        finally:
            receipt.update(finished_at=time.time(), original_source_unchanged=digest(source) == args.sha256)
            if not receipt['original_source_unchanged']:
                receipt.update(status='failed', error='The source image changed.')
            (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    if receipt['status'] != 'passed':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
