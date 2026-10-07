#!/usr/bin/env python3
"""Read-only observations for an untouched installed-OS update journey."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

HOME = Path('/home/me')
ROOT_STATE = Path('/var/lib/harness-os/runtime-updates')


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def file_record(path):
    info = path.lstat()
    record = {'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid,
              'mtime_ns': info.st_mtime_ns}
    if stat.S_ISLNK(info.st_mode):
        record.update(type='symlink', target=os.readlink(path))
    elif stat.S_ISREG(info.st_mode):
        record.update(type='file', bytes=info.st_size, sha256=digest(path))
    else:
        raise ValueError('Expected an owned file or link: ' + str(path))
    return record


def package_files(root, version):
    text = (root / 'var/lib/pacman/local' / ('harness-os-' + version) / 'files').read_text()
    blocks = {}
    for block in text.strip().split('\n\n'):
        lines = block.splitlines()
        blocks[lines[0]] = lines[1:]
    paths = [path for path in blocks['%FILES%'] if not path.endswith('/')]
    if len(set(paths)) != len(paths) or any(path.startswith('/') or '..' in Path(path).parts for path in paths):
        raise ValueError('Unexpected installed ownership list')
    return {name: file_record(root / name) for name in sorted(paths)}


def system():
    package = subprocess.check_output(['pacman', '-Q', 'harness-os'], text=True).strip().split()
    assert package[0] == 'harness-os' and len(package) == 2
    policy = [Path('/etc/sudoers'), *sorted(Path('/etc/sudoers.d').iterdir())]
    return {'package_version': package[1], 'owned_files': package_files(Path('/'), package[1]),
            'sudo_policy': {str(path): file_record(path) for path in policy if path.is_file()},
            'runtime': json.loads(Path('/usr/share/harness-os/runtime.json').read_text()),
            'lock': json.loads(Path('/usr/share/harness-os/lock.json').read_text()),
            'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}


def process(pid):
    folder = Path('/proc') / str(pid)
    fields = (folder / 'stat').read_text().rsplit(')', 1)[1].split()
    if fields[0] in ('Z', 'X'):
        raise ValueError('Work process is no longer live: ' + str(pid))
    return {'pid': int(pid), 'start': fields[19], 'uid': folder.stat().st_uid,
            'argv': (folder / 'cmdline').read_bytes().rstrip(b'\0').decode().split('\0')}


def project():
    folder = HOME / 'projects/public-update-proof'
    return {str(path.relative_to(folder)): file_record(path) for path in sorted(folder.rglob('*')) if path.is_file()}


def work():
    assert os.getuid() == 1000
    agents = subprocess.check_output(['pgrep', '-u', '1000', '-x', 'opencode'], text=True).split()
    daemon = subprocess.check_output(['systemctl', '--user', 'show', 'harness-daemon.service', '-p', 'MainPID', '--value'], text=True).strip()
    terminal = (HOME / 'projects/session-probe/pid').read_text().strip()
    return {'agents': [process(pid) for pid in sorted(agents)], 'daemon': process(daemon),
            'terminal': process(terminal), 'project': project(),
            'heartbeat': (HOME / 'projects/session-probe/heartbeat').stat().st_mtime_ns,
            'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}


def display():
    pids = subprocess.check_output(['pgrep', '-u', '1000', '-x', 'labwc'], text=True).split()
    if len(pids) != 1:
        raise ValueError('Expected one actual graphical compositor')
    executable = Path('/proc') / pids[0] / 'exe'
    path = str(executable.resolve(strict=True))
    return {'process': process(pids[0]), 'executable': path, 'sha256': digest(executable),
            'owner': subprocess.check_output(['pacman', '-Qqo', path], text=True).strip()}


def checkpoint():
    pointer = json.loads((ROOT_STATE / 'latest.json').read_text())['id']
    if not re.fullmatch(r'[0-9TZ-]+-[a-f0-9]{8}', pointer):
        raise ValueError('Invalid root receipt identity')
    folder = ROOT_STATE / pointer
    receipt = json.loads((folder / 'receipt.json').read_text())
    name = receipt['checkpoint']
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}', name):
        raise ValueError('Invalid checkpoint identity')
    saved = Path('/.snapshots') / name
    metadata = json.loads((saved / 'checkpoint.json').read_text())
    if metadata['root_uuid'] != receipt['root_uuid'] or metadata['name'] != name:
        raise ValueError('Checkpoint and transaction identities differ')
    boot = {}
    for path, expected in metadata['boot_sha256'].items():
        if Path(path).is_absolute() or '..' in Path(path).parts:
            raise ValueError('Invalid saved boot path')
        boot[path] = digest(saved / 'boot' / path)
        if boot[path] != expected:
            raise ValueError('Saved boot file was modified: ' + path)
    backup = digest(folder / 'previous.pkg.tar.gz')
    if backup != receipt['backup_sha256']:
        raise ValueError('Saved package was modified')
    return {'receipt': receipt, 'checkpoint': metadata, 'boot_sha256': boot,
            'backup_sha256': backup, 'previous_files': package_files(saved / 'root', receipt['previous_version'])}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['system', 'work', 'checkpoint', 'project', 'display'])
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = {'system': system, 'work': work, 'checkpoint': checkpoint, 'project': project,
              'display': display}[args.action]()
    args.output.write_text(json.dumps(result, indent=2) + '\n')
