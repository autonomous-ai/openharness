#!/usr/bin/env python3
"""Verify public full-update retry evidence inside the disposable x86 test VM."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


def read(path):
    return json.loads(path.read_text())


def verify(root, before):
    failed = before['failed_update']
    checkpoint = failed['checkpoint']
    assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', checkpoint), 'Unsafe checkpoint identity'
    assert failed['exit_status'] not in (None, 0), 'The fixture did not record a failed full update'
    state = root / 'var/lib/harness-os'
    assert read(state / 'install.json')['root_uuid'] == before['root_uuid'], 'Installation identity changed'
    completed = read(state / 'update.json')
    assert completed['exit_status'] == 0, 'The public full-update retry did not finish'
    assert completed['checkpoint'] == checkpoint, 'Retry replaced the original checkpoint'
    assert completed['snapshot'] == failed['snapshot'], 'This row must retry the same dated snapshot'
    saved = root / '.snapshots' / checkpoint
    metadata = read(saved / 'checkpoint.json')
    assert metadata['root_uuid'] == before['root_uuid'] and metadata['reason'] == 'before-update'
    assert hashlib.sha256((saved / 'checkpoint.json').read_bytes()).hexdigest() == before['checkpoint_sha256']
    probe = Path('usr/share/hn-os-update-probe/value')
    assert (root / probe).read_bytes() == b'2\n', 'The real package transaction did not install v2'
    assert (saved / 'root' / probe).read_bytes() == b'1\n', 'The original package recovery point changed'
    pointer = read(state / 'runtime-updates/latest.json')['id']
    assert re.fullmatch(r'[0-9TZ-]+-[a-f0-9]{8}', pointer), 'Unsafe runtime receipt identity'
    runtime = read(state / 'runtime-updates' / pointer / 'receipt.json')
    assert runtime['status'] == 'applied' and runtime['root_uuid'] == before['root_uuid']
    assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', runtime['checkpoint']), 'Unsafe package checkpoint identity'
    assert runtime['checkpoint'] != checkpoint, 'Harness package needs its own later checkpoint'
    later = read(root / '.snapshots' / runtime['checkpoint'] / 'checkpoint.json')
    assert later['root_uuid'] == before['root_uuid'] and later['reason'] == 'before-harness-update'
    assert sum(path.is_dir() for path in (root / '.snapshots').iterdir()) == before['snapshots_before'] + 2, \
        'Retry created another Arch checkpoint'
    return {'status': 'passed', 'coverage': 'public retry and original checkpoint preservation',
            'root_uuid': before['root_uuid'], 'failed_update': failed, 'completed_update': completed,
            'checkpoint_sha256': before['checkpoint_sha256'], 'runtime_update': runtime}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('work', type=Path)
    args = parser.parse_args()
    assert subprocess.check_output(['lsblk', '-dn', '-o', 'SERIAL', '/dev/vda'], text=True).strip() == 'HN_OS_TEST'
    assert re.fullmatch(r'/tmp/hn-os-update-check\.[A-Za-z0-9]+', str(args.work)) and not args.work.is_symlink()
    result = verify(Path('/'), read(args.work / 'retry-before.json'))
    result['probe_package'] = subprocess.check_output(['pacman', '-Q', 'hn-os-update-probe'], text=True).strip()
    assert result['probe_package'] == 'hn-os-update-probe 2-1'
    result['pacman_version'] = subprocess.check_output(['pacman', '--version'], text=True).strip()
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
