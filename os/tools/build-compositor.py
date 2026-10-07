#!/usr/bin/env python3
"""Build the pinned compositor and retain its complete corresponding source."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import urllib.request


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[2]
    git = ['git', '-c', 'safe.directory=' + str(source), '-C', str(source)]
    if subprocess.check_output([*git, 'status', '--porcelain', '--untracked-files=normal'], text=True).strip():
        raise ValueError('Commit source changes before building a traceable compositor.')
    recipe = source / 'os/packaging/labwc'
    identity = json.loads((recipe / 'source.json').read_text())
    lock = json.loads((source / 'os/lock.json').read_text())
    if lock['arch_snapshot'] != identity['arch_snapshot']:
        raise ValueError('Compositor and OS must use the same reviewed Arch snapshot.')
    patch = recipe / identity['patch']
    assert digest(patch) == identity['patch_sha256']
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    archive = output / 'source.tar.gz'
    with urllib.request.urlopen(identity['url'], timeout=60) as response:
        archive.write_bytes(response.read(identity['bytes'] + 1))
    assert archive.stat().st_size == identity['bytes']
    assert digest(archive) == identity['sha256']
    with tarfile.open(archive) as bundle:
        assert sum(member.size for member in bundle.getmembers()) < 32 * 1024**2
        bundle.extractall(output / 'source', filter='data')
    upstream = output / 'source' / ('labwc-' + identity['commit'])
    subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-i', str(patch)],
                   cwd=upstream, check=True, timeout=30)
    shutil.copy2(source / 'os/tests/lock_presentation_policy.c', upstream / 't/harness-lock-presentation.c')
    with (upstream / 't/meson.build').open('a') as meson:
        meson.write('''
test('harness_lock_presentation', executable('test_harness_lock_presentation',
  sources: 'harness-lock-presentation.c', include_directories: [labwc_inc],
  dependencies: labwc_deps,
  c_args: ['-UNDEBUG', '-ffunction-sections', '-fdata-sections'],
  link_args: ['-Wl,--gc-sections']), is_parallel: false)
''')
    build = output / 'build'
    options = ['--prefix=/usr', '--buildtype=release', '--wrap-mode=nodownload',
               '-Dtest=enabled', '-Dman-pages=disabled', '-Dxwayland=enabled',
               '-Dlabnag=disabled', '-Dsystemd-session=disabled']
    subprocess.run(['meson', 'setup', str(build), str(upstream), *options], check=True, timeout=60,
                   env=dict(os.environ, GIT_CEILING_DIRECTORIES=str(upstream.parent)))
    subprocess.run(['meson', 'compile', '-C', str(build), '-j', '2'], check=True, timeout=600)
    subprocess.run(['meson', 'test', '-C', str(build), '--print-errorlogs'], check=True, timeout=120)
    binary = output / 'labwc'
    shutil.copy2(build / 'labwc', binary)
    subprocess.run(['strip', '--strip-unneeded', binary], check=True, timeout=30)
    # Record actual direct ELF library owners. Pacman will resolve their
    # transitive dependencies; the image need not ship a second compositor.
    needed = set(re.findall(r'\(NEEDED\).*\[(.+)\]', subprocess.check_output(
        ['readelf', '-d', binary], text=True)))
    links = subprocess.check_output(['ldd', binary], text=True)
    libraries = dict(re.findall(r'^\s*(\S+) => (/\S+)', links, re.MULTILINE))
    if not needed or not needed <= libraries.keys():
        raise ValueError('Compositor has an unresolved runtime library.')
    dependencies = sorted({subprocess.check_output(
        ['pacman', '-Qoq', str(Path(libraries[name]).resolve())], text=True).strip()
        for name in needed})
    if not {'glibc', 'wayland', 'wlroots0.20'} <= set(dependencies) or any(
            not re.fullmatch(r'[a-z0-9][a-z0-9@._+-]*', name) for name in dependencies):
        raise ValueError('Unexpected compositor library ownership.')
    correspondence = {
        'source.tar.gz': archive,
        'session-lock-presentation.patch': patch,
        'source.json': recipe / 'source.json',
        'build-compositor.py': Path(__file__),
        'lock_presentation_policy.c': source / 'os/tests/lock_presentation_policy.c',
        'LICENSE': upstream / 'LICENSE',
        'rebuild.sh': recipe / 'rebuild.sh',
    }
    for name, path in correspondence.items():
        if path.resolve() != (output / name).resolve():
            shutil.copy2(path, output / name)
    record = {'schema': 1, 'kind': 'harness-compositor', 'architecture': 'x86_64',
              'scope': 'OS-owned compositor; included in the Harness package and its rollback',
              'source_commit': subprocess.check_output([*git, 'rev-parse', 'HEAD'], text=True).strip(),
              'upstream': identity,
              'binary': {'name': binary.name, 'bytes': binary.stat().st_size, 'sha256': digest(binary)},
              'runtime_dependencies': dependencies, 'build_options': options,
              'corresponding_source': {name: {'bytes': (output / name).stat().st_size,
                                             'sha256': digest(output / name)} for name in correspondence},
              'packages': subprocess.check_output(['pacman', '-Q'], text=True).splitlines(),
              'compiler': subprocess.check_output(['cc', '--version'], text=True).splitlines()[0]}
    (output / 'manifest.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record['binary']))


if __name__ == '__main__':
    main()
