#!/usr/bin/env python3
"""Prepare the pinned upstream ARM agent without npm or install-time scripts."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import struct
import tarfile
import tempfile
import urllib.request


ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / 'os/packaging/fedora/opencode.lock.json'


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def read_lock(path=LOCK):
    info = json.loads(path.read_text())
    if (info.get('schema'), info.get('name'), info.get('architecture'), info.get('license')) != (
            1, 'OpenCode', 'aarch64', 'MIT') or not re.fullmatch(r'\d+\.\d+\.\d+', str(info.get('version'))):
        raise ValueError('Use a versioned OpenCode ARM lock.')
    if set(info.get('archives', {})) != {'binary', 'license'} or set(info.get('files', {})) != {'opencode', 'LICENSE'}:
        raise ValueError('Agent lock must include the binary and its license.')
    for key, package in [('binary', 'opencode-linux-arm64'), ('license', 'opencode-ai')]:
        entry = info['archives'][key]
        url = f'https://registry.npmjs.org/{package}/-/{package}-{info["version"]}.tgz'
        if entry.get('package') != package or entry.get('url') != url:
            raise ValueError('Use the pinned upstream npm package URL.')
    for entry in [*info['archives'].values(), *info['files'].values()]:
        if (type(entry.get('bytes')) is not int or not 0 < entry['bytes'] <= 300 * 1024**2 or
                not re.fullmatch(r'[a-f0-9]{64}', str(entry.get('sha256')))):
            raise ValueError('Every agent input needs a bounded size and SHA-256.')
    for name, archive, member in [('opencode', 'binary', 'package/bin/opencode'), ('LICENSE', 'license', 'package/LICENSE')]:
        if (info['files'][name].get('archive'), info['files'][name].get('member')) != (archive, member):
            raise ValueError('Unexpected upstream agent member.')
    return info


def verify(path, entry):
    if (path.is_symlink() or not path.is_file() or path.stat().st_size != entry['bytes'] or
            digest(path) != entry['sha256']):
        raise ValueError('Agent checksum mismatch: ' + str(path))


def check_elf(path):
    with path.open('rb') as handle:
        header = handle.read(64)
        if (len(header) != 64 or header[:7] != b'\x7fELF\x02\x01\x01' or
                struct.unpack_from('<H', header, 16)[0] not in (2, 3) or
                struct.unpack_from('<H', header, 18)[0] != 183):
            raise ValueError('OpenCode must be a little-endian ARM64 ELF executable.')
        offset = struct.unpack_from('<Q', header, 32)[0]
        size, count = struct.unpack_from('<HH', header, 54)
        if size != 56 or not 0 < count <= 256 or offset + size * count > path.stat().st_size:
            raise ValueError('Invalid agent ELF program headers.')
        handle.seek(offset)
        entries = [struct.unpack('<IIQQQQQQ', handle.read(size)) for _ in range(count)]
        loads = [entry for entry in entries if entry[0] == 1]
        if not loads or any(entry[7] < 16384 or entry[7] & (entry[7] - 1) or
                            entry[2] % 16384 != entry[3] % 16384 for entry in loads):
            raise ValueError('OpenCode must support 16 KiB ARM pages.')


def archive_members(archive):
    members = {}
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if (not member.isfile() or path.is_absolute() or '..' in path.parts or
                str(path) != member.name or not member.name.startswith('package/') or member.name in members):
            raise ValueError('Unsafe or duplicate agent archive member: ' + member.name)
        members[member.name] = member
    return members


def prepare(lock, archives, output):
    if output.exists() or output.is_symlink():
        raise ValueError('Agent output must be a new directory.')
    archives.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Do not expose a partly prepared payload after a download or checksum failure.
    with tempfile.TemporaryDirectory(prefix='.opencode-', dir=output.parent) as temp:
        payload = Path(temp) / 'payload'
        payload.mkdir()
        for key, entry in lock['archives'].items():
            path = archives / (entry['package'] + '-' + lock['version'] + '.tgz')
            if not path.exists() and not path.is_symlink():
                partial = Path(temp) / (key + '.download')
                with urllib.request.urlopen(entry['url'], timeout=30) as response, partial.open('xb') as handle:
                    remaining = entry['bytes'] + 1
                    while remaining:
                        chunk = response.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        handle.write(chunk)
                        remaining -= len(chunk)
                verify(partial, entry)
                partial.replace(path)
            verify(path, entry)
            with tarfile.open(path, 'r:gz') as archive:
                members = archive_members(archive)
                metadata = members.get('package/package.json')
                if metadata is None or metadata.size > 65536:
                    raise ValueError('Missing agent package metadata.')
                package = json.load(archive.extractfile(metadata))
                if (package.get('name'), package.get('version')) != (entry['package'], lock['version']):
                    raise ValueError('Agent package metadata does not match its lock.')
                if key == 'binary' and (package.get('os'), package.get('cpu')) != (['linux'], ['arm64']):
                    raise ValueError('Unexpected agent platform metadata.')
                if key == 'license' and (package.get('license') != 'MIT' or
                        package.get('optionalDependencies', {}).get('opencode-linux-arm64') != lock['version']):
                    raise ValueError('Agent license or binary dependency does not match.')
                for name, file in lock['files'].items():
                    if file['archive'] != key:
                        continue
                    member = members.get(file['member'])
                    if member is None or member.size != file['bytes']:
                        raise ValueError('Missing or wrong-size agent payload: ' + name)
                    with archive.extractfile(member) as src, (payload / name).open('xb') as dest:
                        shutil.copyfileobj(src, dest)
                    verify(payload / name, file)
                    (payload / name).chmod(0o755 if name == 'opencode' else 0o644)
        check_elf(payload / 'opencode')
        (payload / 'manifest.json').write_text(json.dumps(lock, indent=2) + '\n')
        payload.rename(output)


def identity(folder, lock):
    manifest = folder / 'manifest.json'
    if manifest.is_symlink() or not manifest.is_file() or json.loads(manifest.read_text()) != lock:
        raise ValueError('Agent provenance does not match the reviewed lock.')
    for name, entry in lock['files'].items():
        verify(folder / name, entry)
    check_elf(folder / 'opencode')
    return lock


def stage(folder, destination, lock):
    identity(folder, lock)
    for name, target in [('opencode', 'usr/lib/harness-opencode/opencode'),
                         ('LICENSE', 'usr/share/licenses/harness-opencode/LICENSE'),
                         ('manifest.json', 'usr/share/harness-os/opencode.json')]:
        path = destination / target
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(folder / name, path)
        path.chmod(0o755 if name == 'opencode' else 0o644)
    link = destination / 'usr/bin/opencode'
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to('../lib/harness-opencode/opencode')
    return lock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archives', type=Path, required=True, help='Reusable verified archive cache.')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    lock = read_lock()
    prepare(lock, args.archives.resolve(), args.output.absolute())
    print(json.dumps({'version': lock['version'], 'architecture': lock['architecture'],
                      'binary_sha256': lock['files']['opencode']['sha256']}))


if __name__ == '__main__':
    main()
