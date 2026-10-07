#!/usr/bin/env python3
"""Native Asahi partition-preparation test on a fresh, owned sparse VM disk."""
import argparse
import json
from pathlib import Path
import platform
import subprocess
import time

from arm_boot import digest
from arm_session import fixture_identity
from asahi_encryption_vm import MaintenanceVM
from session_vm import put

ROOT = Path(__file__).resolve().parents[1]


def guest(vm, action, folder):
    put(vm, '/var/tmp/harness-asahi-target.py', (ROOT / 'platforms/apple-silicon/target.py').read_text())
    put(vm, '/var/tmp/harness-target-guest.py', Path(__file__).with_name('asahi_target_guest.py').read_text())
    output, code = vm.command('unshare --mount --propagation private python3 /var/tmp/harness-target-guest.py ' + action,
                              timeout=120, check=action != 'interrupt')
    if action == 'interrupt':
        assert code == 75, output
        return {'exit_code': code, 'phase': 'interrupted after first GPT write'}
    raw = vm.read_file('/var/tmp/harness-target-result.json')
    (folder / (action + '.json')).write_bytes(raw)
    return json.loads(raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--fixture-source', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if (platform.system(), platform.machine()) != ('Darwin', 'arm64'):
        parser.error('Use the native Apple Silicon host observer.')
    info = fixture_identity(args.fixture, args.fixture_source)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    maintenance = output / 'maintenance.raw'
    disk = output / 'target.raw'
    with disk.open('xb') as handle:
        handle.truncate(24 * 1024**3)
    subprocess.run(['zstd', '-d', '--sparse', args.fixture / 'guest.raw.zst', '-o', maintenance], check=True, timeout=120)
    assert digest(maintenance) == info['raw_disk']['sha256']
    receipt = {'status': 'running', 'started_at': time.time(), 'publication': False,
               'maintenance_source': args.fixture_source,
               'fixture_manifest_sha256': digest(args.fixture / 'manifest.json'),
               'limitations': ['Firmware ESP UUID is injected: QEMU has no Apple firmware handoff.',
                               'Protected APFS/recovery partitions contain sentinel bytes, not real macOS filesystems.',
                               'Interruption is between completed writes; torn GPT copies are refused, not auto-repaired.',
                               'No payload copy, encryption, installer UI or physical Apple support is claimed.'],
               'host': {name: subprocess.check_output([name, '--version'], text=True).splitlines()[0]
                        for name in ('python3', 'qemu-system-aarch64', 'zstd')},
               'inputs': {str(path.relative_to(ROOT)): digest(path) for path in
                          [ROOT / 'platforms/apple-silicon/target.py', ROOT / 'tools/fedora_payload.py'] +
                          [Path(__file__).with_name(name) for name in
                           ('asahi_target_vm.py', 'asahi_target_guest.py', 'asahi_encryption_vm.py',
                            'asahi_encryption_guest.py', 'asahi_firstboot_vm.py', 'arm_boot.py',
                            'arm_session.py', 'fedora_session_vm.py', 'session_vm.py', 'vm.py')]}}
    vm = None
    try:
        vm = MaintenanceVM(output / 'first-attempt', maintenance, args.fixture / 'Image', disk)
        vm.start()
        vm.command('dnf5 install -y --setopt=install_weak_deps=False --setopt=gpgcheck=True gdisk dosfstools', timeout=180)
        receipt['guest_versions'], _ = vm.command('rpm -q gdisk dosfstools util-linux util-linux-core')
        receipt['initialize'] = guest(vm, 'initialize', output)
        receipt['interrupt'] = guest(vm, 'interrupt', output)
        receipt['first_shutdown'] = vm.poweroff()
        vm.close()
        vm = MaintenanceVM(output / 'offline-resume', maintenance, args.fixture / 'Image', disk)
        vm.start(offline=True)
        receipt['resume'] = guest(vm, 'resume', output)
        receipt['second_shutdown'] = vm.poweroff()
        receipt.update(status='passed')
        print('Partition preparation resumes after reboot; protected bytes unchanged; changed or damaged GPT refused.', flush=True)
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        raise
    finally:
        try:
            if vm:
                vm.close()
        finally:
            receipt['finished_at'] = time.time()
            (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    if receipt['status'] != 'passed':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
