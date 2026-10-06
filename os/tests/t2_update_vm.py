#!/usr/bin/env python3
"""Actual T2 kernel upgrade, rollback and recovery; no physical Mac claim."""
import argparse
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tarfile
import threading
import time

from footprint_vm import copy_file
from hardware_update_vm import graceful_stop
from session_vm import screen_text
from session_update_vm import required as session_tools_required
from t2_install_vm import guest_result
from test_t2_firmware import firmware, source_fixture
from vm import VM, check_graphical_keyboard


def identity(path):
    with path.open('rb') as stream:
        return {'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}


def baseline_package(candidate, target, pin):
    """An explicit private prior-version fixture, retaining the exact new updater."""
    with tarfile.open(candidate, 'r:gz') as original, tarfile.open(target, 'w:gz') as output:
        for entry in original:
            data = original.extractfile(entry).read() if entry.isfile() else None
            if entry.name == '.PKGINFO':
                data = re.sub(rb'(?m)^pkgver = .+$', b'pkgver = 0.1.0pre15.r1-1', data)
            elif entry.name == 'usr/share/harness-os/apple-t2/kernel.json':
                data = (json.dumps(pin, indent=2) + '\n').encode()
            if data is not None:
                entry.size = len(data)
            output.addfile(entry, io.BytesIO(data) if data is not None else None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', required=True, type=Path)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--kernels', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    assert os.access('/dev/kvm', os.R_OK | os.W_OK), 'Native KVM is required'
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    assert not subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()
    iso, folder = args.iso.resolve(), args.output.absolute()
    image = json.loads(iso.with_name('manifest.json').read_text())
    assert image['platform'] == 'apple-t2'
    assert image['source_commit'] == '59a0b7f75e31e0c3ed13af2105895db8d4665018'
    assert identity(iso) == {'bytes': 1536999424, 'sha256': '375d333e13fcbac3724b807f030980c3a4121dbcc4c82659ead52709bb682afa'}
    manifest = json.loads((args.bundle / 'package-manifest.json').read_text())
    assert manifest['source_commit'] == source
    expected = {'harness-tui': 'bd221059a24d7f7ca8ce69bb3b6d69c2fb66cb655aae6658627c278a548a8fa8',
                'cli.mjs': '23b46a7c498fd1ef8ff5936aeb431f1de08b959b957141fa732d2cede870d147',
                'notify.mjs': '5690159e964f9ce022bdb2a5e4bc9d853e595e822f254478df241e1386dde68e'}
    assert {name: value['sha256'] for name, value in manifest['runtime']['files'].items()} == expected
    before = json.loads(Path(__file__).with_name('t2-kernel-before.json').read_text())
    after = json.loads((Path(__file__).parents[1] / 'platforms/apple-t2/kernel.json').read_text())
    folder.mkdir(parents=True, exist_ok=False)
    served = folder / 'served'
    shutil.copytree(args.bundle, served)
    for pin in (before, after):
        package = pin['package']
        original = args.kernels / package['filename']
        assert identity(original) == {key: package[key] for key in ['bytes', 'sha256']}
        shutil.copyfile(original, served / package['filename'])
    (served / 'before.json').write_text(json.dumps(before))
    (served / 'after.json').write_text(json.dumps(after))
    baseline = served / 'harness-os-0.1.0pre15.r1-1-x86_64.pkg.tar.gz'
    baseline_package(served / manifest['package']['name'], baseline, before)
    for name in ['t2_update_guest.py', 't2_install_guest.py']:
        shutil.copyfile(Path(__file__).with_name(name), served / name)
    source_fixture(folder / 'synthetic-firmware')
    firmware.prepare(folder / 'synthetic-firmware', served / 'harness-apple-firmware.tar', 'MacBookAir9,1')
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(served)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    record = {'status': 'running', 'started_at': time.time(), 'source_commit': source,
              'image': image['iso'], 'image_source': image['source_commit'], 'candidate': manifest,
              'before': before, 'after': after, 'baseline_package': identity(baseline), 'checks': [],
              'limits': ['Synthetic DMI and invented firmware; no physical T2 hardware is emulated.',
                         'Prior-version fixture changes only candidate .PKGINFO version and kernel pin.',
                         'Shared runtime is byte-identical public preview14; no shared product release.',
                         'Historical ISO installs the baseline; this does not validate a new ISO.']}
    vm = VM(folder, iso, 'uefi', 2048, cpu='Haswell-noTSX', apple_model='MacBookAir9,1')
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123', encrypt=True, serial_console=True)
    guest = '/home/me/t2-update'

    def installed(label, pin):
        vm.start(live=False)
        vm.monitor('set_link', name='hnnet', up=False)
        vm.login_installed(config)
        vm.command('printf %s ' + shlex.quote(config['password'] + '\n') + ' | sudo -S -v')
        vm.command('systemctl --user stop harness-update.timer harness-update.service')
        vm.command('test "$(uname -r)" = ' + shlex.quote(pin['kernel_release']))
        record[label + '_boot_id'] = vm.read_file('/proc/sys/kernel/random/boot_id').decode().strip()
        for _ in range(60):
            text = screen_text(vm, label + '-workspace')
            if 'me@harness' in re.sub(r'\s+', '', text):
                break
            if 'connect to wi-fi' in text:
                vm.keys('meta_l', 't')
                break
            time.sleep(.5)
        else:
            raise TimeoutError('Offline workspace never rendered')
        record[label + '_keyboard'] = check_graphical_keyboard(vm, label)

    def probe(action, timeout=360):
        output, _ = vm.command('sudo -n python3 ' + guest + '/t2_update_guest.py ' + action + ' ' + guest, timeout=timeout)
        (folder / (action + '.log')).write_text(output)
        result = guest_result(output)
        record[action] = result
        return result

    try:
        vm.start(live=True)
        vm.monitor('set_link', name='hnnet', up=False)
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo; nmcli networking off; mkdir -p /var/lib/harness-os')
        copy_file(vm, (served / 'harness-apple-firmware.tar').read_bytes(), '/var/lib/harness-os/apple-firmware.tar')
        copy_file(vm, json.dumps(config).encode(), '/tmp/install.json')
        output, _ = vm.command('harness install --config /tmp/install.json --yes-erase-disk', timeout=420)
        (folder / 'install.log').write_text(output)
        graceful_stop(vm, False)
        installed('image', after)
        vm.monitor('set_link', name='hnnet', up=True)
        vm.command('sudo -n nmcli networking on')
        vm.command('nm-online --quiet --timeout=30', timeout=40)
        vm.command('mkdir -p ' + guest)
        url = f'http://10.0.2.2:{server.server_port}'
        for file in served.iterdir():
            if file.is_file():
                vm.command('curl -fsS --retry 3 --max-time 90 ' + shlex.quote(url + '/' + file.name) +
                           ' -o ' + shlex.quote(guest + '/' + file.name), timeout=100)
        if session_tools_required(args.bundle):
            # A newer package may add session dependencies absent from the
            # historical image. Cache them online without changing that image;
            # the actual baseline/kernel transactions below stay offline.
            output, _ = vm.command('sudo -n pacman --noconfirm -U --downloadonly '
                                   + shlex.quote(guest + '/' + before['package']['filename']) + ' '
                                   + shlex.quote(guest + '/' + baseline.name), timeout=180)
            (folder / 'session-dependency-download.log').write_text(output)
            vm.command('test "$(pacman -Q harness-os)" = ' + shlex.quote('harness-os ' + image['package_version']))
            record['checks'].append('New session dependencies are verified and cached before disconnecting; baseline package remains unchanged until the offline transaction')
        vm.command('sudo -n nmcli networking off')
        vm.monitor('set_link', name='hnnet', up=False)
        probe('baseline')
        graceful_stop(vm, True)
        installed('before', before)
        first = probe('exercise', 480)
        graceful_stop(vm, True)
        installed('updated', after)
        probe('rollback')
        graceful_stop(vm, True)
        installed('rolled-back', before)
        restore = probe('reapply')
        graceful_stop(vm, True)
        vm.start(live=True)
        vm.monitor('set_link', name='hnnet', up=False)
        vm.wait(r'root@[^\r\n]*[#] ')
        vm.shell_ready = True
        vm.command('stty -echo; nmcli networking off')
        vm.command('printf %s ' + shlex.quote(config['password']) + ' | cryptsetup open --key-file=- /dev/vda3 hn-recovery')
        output, _ = vm.command('hn-os recover /dev/mapper/hn-recovery ' + shlex.quote(restore['checkpoint']), timeout=180)
        (folder / 'offline-recovery.log').write_text(output)
        vm.command('cryptsetup close hn-recovery')
        graceful_stop(vm, False)
        installed('recovered', before)
        recovered = probe('verify-recovered')
        assert recovered['boot_sha256'] == restore['before_boot_sha256']
        assert recovered['firmware_sha256'] == first['firmware_sha256']
        assert len({record[x + '_boot_id'] for x in ['before', 'updated', 'rolled-back', 'recovered']}) == 4
        record['checks'] = ['Offline encrypted installation from the historical T2 ISO.',
            'Actual 7.2.7 kernel baseline cold-boots and accepts graphical input.',
            'Corrupt candidate and a failed package transaction retain original recovery and running work.',
            'The release updater stages both real kernels, upgrades 7.2.7 to 7.2.8 and cold-boots through unlock.',
            'Installed updater rolls back completely offline to 7.2.7 and cold-boots through unlock.',
            'Offline USB recovery restores exact old boot hashes and private firmware while newer project work survives.']
        graceful_stop(vm, True)
        record['status'] = 'passed'
    except BaseException as error:
        record.update(status='failed', error=repr(error))
        if vm.process and vm.process.poll() is None:
            vm.screenshot('failure')
        raise
    finally:
        record['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(record, indent=2) + '\n')
        vm.stop()
        server.shutdown()
        server.server_close()
        shutil.rmtree(served)


if __name__ == '__main__':
    main()
