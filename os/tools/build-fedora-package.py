#!/usr/bin/env python3
"""Build an unpublished native Fedora session RPM from declared runtime bytes."""
import argparse
import gzip
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile

from fedora_payload import digest, runtime_identity, stage


def command(*args, **kwargs):
    return subprocess.check_output([str(arg) for arg in args], text=True, **kwargs).strip()


def git(source, *args):
    return command('git', '-c', f'safe.directory={source}', '-C', source, *args)


def archive_payload(root, output, timestamp):
    with output.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=timestamp) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', dereference=False) as archive:
            for path in sorted(root.rglob('*')):
                info = archive.gettarinfo(str(path), str(path.relative_to(root)))
                info.uid = info.gid = 0
                info.uname = info.gname = 'root'
                info.mtime = timestamp
                if info.isfile():
                    with path.open('rb') as handle:
                        archive.addfile(info, handle)
                else:
                    archive.addfile(info)


def file_list(root):
    # Own our directories and payload, never Fedora's shared /usr directories.
    lines = []
    for path in sorted(root.rglob('*')):
        name = '/' + str(path.relative_to(root))
        if path.is_dir() and not path.is_symlink():
            if name in ['/usr/lib/harness', '/usr/lib/harness-os', '/usr/lib/harness-opencode',
                        '/usr/share/licenses/harness-os', '/usr/share/licenses/harness-opencode',
                        '/usr/share/licenses/harness-os-connections'] or name.startswith(('/usr/share/harness-os', '/usr/lib/harness-os/connections')):
                lines.append('%dir ' + name)
        else:
            lines.append(('%license ' if name.startswith('/usr/share/licenses/') else '') + name)
    return '\n'.join(lines) + '\n'



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--runtime-source', required=True, help='Full producer SHA of the explicitly selected native runtime.')
    parser.add_argument('--agent', type=Path, required=True, help='Verified pinned OpenCode payload; no npm scripts run during packaging.')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--release', default='1', help='Positive RPM package release, also used for private lifecycle tests.')
    args = parser.parse_args()
    if (platform.system(), platform.machine()) != ('Linux', 'aarch64'):
        parser.error('Build in native Fedora aarch64, without CPU emulation.')
    release_info = platform.freedesktop_os_release()
    if release_info.get('ID') != 'fedora':
        parser.error('Build with Fedora rpm-build in the declared Fedora container.')
    if not re.fullmatch(r'[1-9][0-9]{0,5}', args.release):
        parser.error('--release must be a positive integer.')
    source = Path(__file__).resolve().parents[2]
    if git(source, 'status', '--porcelain', '--untracked-files=normal'):
        parser.error('Commit source changes before packaging.')
    commit = git(source, 'rev-parse', 'HEAD')
    timestamp = int(git(source, 'log', '-1', '--format=%ct'))
    runtime = args.runtime.resolve()
    original_runtime = runtime_identity(runtime, args.runtime_source)
    # The development version identifies this component, not a released ARM OS.
    version = f'0.1.0~dev.{timestamp}.g{commit[:10]}'
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    toolchain = {'rpm': command('rpm', '--version'), 'rpmbuild': command('rpmbuild', '--version'),
                 'python': platform.python_version(), 'os_release': release_info,
                 'buildhost': 'harness-os', 'source_date_epoch': timestamp}
    with tempfile.TemporaryDirectory(prefix='harness-fedora-rpm-') as temporary:
        top = Path(temporary)
        for name in ['SOURCES', 'SPECS', 'BUILD', 'RPMS', 'SRPMS', 'BUILDROOT']:
            (top / name).mkdir()
        payload = top / 'payload'
        identity = stage(source, runtime, payload, commit, args.runtime_source, args.agent.resolve())
        archive_payload(payload, top / 'SOURCES/payload.tar.gz', timestamp)
        (top / 'SOURCES/files.list').write_text(file_list(payload))
        spec = top / 'SPECS/harness-os-session.spec'
        shutil.copyfile(source / 'os/packaging/fedora/harness-os-session.spec', spec)
        subprocess.run(['rpmbuild', '-bb', str(spec), '--define', f'_topdir {top}',
                        '--define', f'harness_version {version}', '--define', f'harness_release {args.release}',
                        '--define', '_buildhost harness-os', '--define', '_binary_payload w9.gzdio',
                        '--define', 'use_source_date_epoch_as_buildtime 1',
                        '--define', 'build_mtime_policy clamp_to_source_date_epoch'],
                       env=dict(os.environ, SOURCE_DATE_EPOCH=str(timestamp), LC_ALL='C', TZ='UTC'), check=True)
        artifacts = list((top / 'RPMS').rglob('*.rpm'))
        if len(artifacts) != 1:
            raise ValueError('Expected exactly one session RPM.')
        package = output / artifacts[0].name
        shutil.copyfile(artifacts[0], package)
    manifest = {'schema': 1, 'kind': 'harness-os-fedora-session', 'architecture': 'aarch64',
                'published': False, 'package_source_commit': commit, 'runtime_source_commit': args.runtime_source,
                'runtime_source_identity': original_runtime, 'runtime_identity_sha256': digest(runtime / 'source.json'),
                **identity, 'toolchain': toolchain,
                'external_components': {
                    'default_agent': {'owner': 'harness-os-session', 'included': True,
                                      'name': 'OpenCode', 'version': identity['agent']['version']},
                    'browser': {'owner': 'image', 'included': False, 'optional': True, 'package': 'chromium'},
                    'platform': {'owner': 'Fedora/Asahi', 'included': False}},
                'package': {'name': package.name, 'version': version, 'release': args.release,
                            'bytes': package.stat().st_size, 'sha256': digest(package)}}
    record = output / 'package-manifest.json'
    record.write_text(json.dumps(manifest, indent=2) + '\n')
    (output / 'SHA256SUMS').write_text(''.join(f'{digest(path)}  {path.name}\n' for path in [package, record]))
    print(json.dumps(manifest['package'], indent=2))


if __name__ == '__main__':
    main()
