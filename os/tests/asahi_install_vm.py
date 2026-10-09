#!/usr/bin/env python3
"""Drive the real install form, then unlock and boot its fresh encrypted target."""
import argparse
from vm_artifacts import discard_passed_disks
import json
from pathlib import Path
import platform
import re
import subprocess
import time

from arm_boot import digest
from arm_session import fixture_identity
from asahi_encryption_vm import MaintenanceVM, unlock
from asahi_firstboot_vm import ImageVM, PASSWORD, evidence, type_line
from asahi_startup_vm import installed
from asahi_target_vm import guest as target_guest
from session_vm import put

ROOT = Path(__file__).resolve().parents[1]


def stage(vm):
    for name in ('install.py', 'startup.py', 'storage.py', 'target.py'):
        put(vm, '/var/tmp/' + name, (ROOT / 'platforms/apple-silicon' / name).read_text())
    put(vm, '/var/tmp/harness-install-guest.py', Path(__file__).with_name('asahi_install_guest.py').read_text())


def inspect(vm, action='inspect'):
    vm.command('unshare --mount --propagation private python3 /var/tmp/harness-install-guest.py ' + action)
    return json.loads(vm.read_file('/var/tmp/harness-install-inspection.json'))


def launch(vm, sha, source):
    assert re.fullmatch('[a-f0-9]{64}', sha) and re.fullmatch('[a-f0-9]{40}', source)
    service = '''[Unit]
Description=Private installer acceptance
Conflicts=getty@tty1.service
After=systemd-vconsole-setup.service
[Service]
ExecStartPre=/usr/bin/chvt 1
ExecStart=/usr/bin/unshare --mount --propagation private /usr/bin/python3 /var/tmp/harness-install-guest.py screen --source-device /dev/vdc --sha256 SHA --image-source SOURCE
StandardInput=tty
StandardOutput=tty
StandardError=journal
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
Environment=TERM=linux LANG=C.UTF-8
UMask=0077
LimitCORE=0
'''.replace('SHA', sha).replace('SOURCE', source)
    put(vm, '/etc/systemd/system/harness-install-acceptance.service', service)
    vm.command('systemctl daemon-reload && systemctl start harness-install-acceptance.service')
    vm.frame('01-install', ['Disk', 'Encryption', 'Repeat password', 'Install Harness'], seconds=60)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('fixture', 'image', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ('fixture-source', 'image-source', 'sha256'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    if (platform.system(), platform.machine()) != ('Darwin', 'arm64'):
        parser.error('Use the native Apple Silicon observer.')
    if not re.fullmatch('[a-f0-9]{40}', args.image_source) or not re.fullmatch('[a-f0-9]{64}', args.sha256):
        parser.error('Use immutable image and source identities.')
    source = args.image.resolve()
    if args.image.is_symlink() or not source.is_file() or digest(source) != args.sha256:
        parser.error('Use the verified regular source image.')
    info = fixture_identity(args.fixture, args.fixture_source)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    maintenance, disk = output / 'maintenance.raw', output / 'target.raw'
    with disk.open('xb') as stream:
        stream.truncate(24 * 1024**3)
    subprocess.run(['zstd', '-d', '--sparse', args.fixture / 'guest.raw.zst', '-o', maintenance], check=True, timeout=120)
    assert digest(maintenance) == info['raw_disk']['sha256']
    paths = [ROOT / 'platforms/apple-silicon' / n for n in ('install.py', 'startup.py', 'storage.py', 'target.py')]
    paths += [Path(__file__).with_name(n) for n in ('asahi_install_vm.py', 'asahi_install_guest.py',
        'asahi_startup_vm.py', 'asahi_target_vm.py', 'asahi_target_guest.py', 'asahi_encryption_vm.py',
        'asahi_encryption_guest.py', 'asahi_firstboot_vm.py', 'arm_boot.py', 'arm_session.py',
        'fedora_session_vm.py', 'session_vm.py', 'vm.py')]
    receipt = {'status': 'running', 'started_at': time.time(), 'publication': False,
        'image_sha256': args.sha256, 'image_source': args.image_source,
        'fixture_source': args.fixture_source, 'fixture_manifest_sha256': digest(args.fixture / 'manifest.json'),
        'inputs': {str(p.relative_to(ROOT)): digest(p) for p in paths}, 'shutdowns': [],
        'limitations': ['QEMU firmware identity injected, not Apple firmware/m1n1 or physical hardware acceptance.',
            'Protected partitions contain sentinel bytes; this does not test actual macOS recovery.',
            'Known public fixture password: never release either test disk.',
            'Graphical keyboard drives the Linux console; pointer behavior is portable-test coverage only.',
            'No installer-media artifact is built by this observer.']}
    vm = None
    try:
        vm = MaintenanceVM(output / 'installer', maintenance, args.fixture / 'Image', disk, source=source)
        vm.start()
        vm.command('dnf5 install -y --setopt=install_weak_deps=False --setopt=gpgcheck=True gdisk dosfstools cryptsetup btrfs-progs e2fsprogs rsync', timeout=180)
        target_guest(vm, 'initialize', output)
        stage(vm)
        receipt['before'] = inspect(vm, 'reset-plan')
        vm.monitor('set_link', name='hnnet', up=False)
        launch(vm, args.sha256, args.image_source)
        vm.type_probe('cancel-secret')
        vm.keys('esc')
        vm.command('for n in $(seq 1 30); do systemctl is-active --quiet harness-install-acceptance.service || break; sleep .1; done; '
                   'test "$(systemctl show -p ExecMainStatus --value harness-install-acceptance.service)" = 0')
        assert inspect(vm) == receipt['before']
        receipt['cancel_unchanged'] = True
        launch(vm, '0' * 64, args.image_source)
        type_line(vm, PASSWORD)
        type_line(vm, PASSWORD)
        vm.keys('ret')
        vm.frame('02-bad-image', 'Installation stopped', seconds=90, absent=[PASSWORD])
        assert inspect(vm) == receipt['before']
        vm.keys('esc')
        vm.command('for n in $(seq 1 30); do systemctl is-active --quiet harness-install-acceptance.service || break; sleep .1; done')
        receipt['bad_image_unchanged'] = True
        launch(vm, args.sha256, args.image_source)
        type_line(vm, 'wrong')
        type_line(vm, 'mismatch')
        vm.keys('ret')
        vm.frame('03-mismatch', 'Passwords do not match')
        assert inspect(vm) == receipt['before']
        receipt['mismatch_unchanged'] = True
        vm.keys('shift', 'tab')
        vm.keys('ctrl', 'u')
        vm.type_probe(PASSWORD)
        vm.keys('shift', 'tab')
        vm.keys('ctrl', 'u')
        vm.type_probe(PASSWORD)
        vm.frame('04-masked', 'Repeat password', absent=[PASSWORD])
        vm.keys('ret')
        vm.keys('ret')
        vm.frame('05-ready', 'Install Harness', absent=[PASSWORD])
        vm.keys('ret')
        vm.frame('06-progress', 'Checking installation files', seconds=60)
        vm.frame('07-complete', ['Harness is installed', 'Shut down'], seconds=400)
        receipt['after'] = inspect(vm)
        assert receipt['after']['storage']['phase'] == 'copied'
        assert receipt['after']['startup']['phase'] == 'complete'
        assert not receipt['after']['remaining']
        vm.command('unshare --mount --propagation private python3 /var/tmp/harness-install-guest.py reject-mounted')
        receipt['mounted_target_refused'] = True
        log = vm.read_file('/var/log/harness-asahi-install.log')
        assert PASSWORD.encode() not in log
        (vm.folder / 'installer.log').write_bytes(log)
        vm.keys('ret')
        receipt['shutdowns'].append(vm.poweroff(request=False))
        vm.close()
        print('Actual install form passed offline; cancellation, mismatch and invalid image kept the disk unchanged.', flush=True)
        vm = ImageVM(output / 'installed-boot', disk, None)
        vm.start()
        unlock(vm, reject_wrong=True)
        vm.frame('04-workspace', ['opencode', 'Ask anything'], seconds=150, absent=['Set your password', 'panic'])
        vm.authenticate()
        receipt['installed'] = installed(vm)
        receipt['account'] = evidence(vm, vm.folder)
        vm.wait_user('pgrep -u 1000 -x opencode >/dev/null && test "$(hn list-panes -F "#{pane_id}" | wc -l)" -eq 3')
        receipt['shutdowns'].append(vm.poweroff())
        receipt['status'] = 'passed'
        print('The installation produced by the form unlocks into OpenCode and two terminals.', flush=True)
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        if vm:
            try:
                vm.screenshot('failure')
                if vm.shell_ready:
                    logs, _ = vm.command('journalctl -b -u harness-install-acceptance --no-pager; '
                                         'cat /var/log/harness-asahi-install.log', check=False, timeout=20)
                    (vm.folder / 'diagnosis.txt').write_text(logs)
            except Exception as diagnostic:
                receipt['diagnostic_error'] = str(diagnostic)
        raise
    finally:
        try:
            if vm:
                vm.close()
        except BaseException as error:
            receipt.update(status='failed', cleanup_error=str(error))
            raise
        finally:
            receipt.update(finished_at=time.time(), original_source_unchanged=digest(source) == args.sha256)
            if not receipt['original_source_unchanged']:
                receipt.update(status='failed', error='The source image changed.')
            (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
            discard_passed_disks(output, receipt, maintenance, disk)


if __name__ == '__main__':
    main()
