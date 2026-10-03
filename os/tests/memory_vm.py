#!/usr/bin/env python3
"""Native 1 GiB installed-OS A/B measurement; never changes the published image."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import time
from vm import VM, check_graphical_keyboard


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    args = parser.parse_args()
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        parser.error('Native x86 KVM is required')
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    with iso.open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha256').hexdigest() == manifest['iso']['sha256']
    folder = Path('os/test-results/memory').resolve()
    folder.mkdir(parents=True, exist_ok=False)
    vm = VM(folder, iso, 'uefi', 1024)
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123', encrypt=True, serial_console=True)
    result = {'status': 'running', 'started_at': time.time(), 'memory_mib': 1024,
              'image_source_commit': manifest['source_commit'], 'iso_sha256': manifest['iso']['sha256'],
              'test_source_commit': subprocess.check_output(['git','rev-parse','HEAD'], text=True).strip()}
    try:
        vm.start(live=True)
        vm.wait(r'root@[^\r\n]*[#] ', timeout=180)
        vm.shell_ready = True
        vm.command('stty -echo')
        encoded = base64.b64encode(json.dumps(config).encode()).decode()
        vm.command('printf %s ' + encoded + ' | base64 -d > /tmp/install-config.json')
        vm.command('nmcli networking off')
        output, _ = vm.command('harness install --config /tmp/install-config.json --yes-erase-disk', timeout=360)
        (folder / 'install.log').write_text(output)
        vm.command('sync')
        vm.stop()
        vm.start(live=False)
        vm.login_installed(config)
        script = base64.b64encode(Path(__file__).with_name('memory_guest.py').read_bytes()).decode()
        vm.command(': > /tmp/memory-guest.b64')
        for start in range(0, len(script), 2000):
            vm.command('printf %s ' + script[start:start+2000] + ' >> /tmp/memory-guest.b64')
        vm.command('base64 -d /tmp/memory-guest.b64 > /home/me/memory-guest.py')
        output, status = vm.command('python3 /home/me/memory-guest.py', timeout=720, check=False)
        (folder / 'benchmark.log').write_text(output)
        assert status == 0, 'Memory assessment failed; see benchmark.log'
        marker = 'HN_MEMORY_RESULT='
        result['guest'] = json.loads(next(line.split(marker,1)[1] for line in output.splitlines() if marker in line))
        assert result['guest']['status'] == 'passed' and result['guest']['default_restored']
        result['restored_keyboard'] = check_graphical_keyboard(vm, 'memory-restored')
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        try:
            vm.screenshot('failure')
        except Exception:
            pass
        raise
    finally:
        result['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result, indent=2)+'\n')
        vm.stop()


if __name__ == '__main__':
    main()
