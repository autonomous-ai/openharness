#!/usr/bin/env python3
"""Build a private, pinned labwc lock correction for disposable native VM checks."""
import argparse
import hashlib
import json
import os
from pathlib import Path
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
    recipe = source / 'os/packaging/labwc'
    identity = json.loads((recipe / 'source.json').read_text())
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
    build = output / 'build'
    subprocess.run(['meson', 'setup', str(build), str(upstream), '--prefix=/usr',
                    '--buildtype=release', '--wrap-mode=nodownload',
                    '-Dtest=enabled', '-Dman-pages=disabled'], check=True, timeout=60,
                   env=dict(os.environ, GIT_CEILING_DIRECTORIES=str(upstream.parent)))
    subprocess.run(['meson', 'compile', '-C', str(build), '-j', '2'], check=True, timeout=600)
    subprocess.run(['meson', 'test', '-C', str(build), '--print-errorlogs'], check=True, timeout=120)
    binary = output / 'labwc'
    shutil.copy2(build / 'labwc', binary)
    subprocess.run(['strip', '--strip-unneeded', binary], check=True, timeout=30)
    record = {'scope': 'Private native compositor proof; no installed or published package',
              'source_commit': subprocess.check_output(['git', '-c', 'safe.directory=' + str(source),
                  '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(),
              'upstream': identity,
              'binary': {'name': binary.name, 'bytes': binary.stat().st_size, 'sha256': digest(binary)},
              'packages': subprocess.check_output(['pacman', '-Q'], text=True).splitlines(),
              'compiler': subprocess.check_output(['cc', '--version'], text=True).splitlines()[0]}
    (output / 'manifest.json').write_text(json.dumps(record, indent=2) + '\n')
    shutil.copy2(upstream / 'LICENSE', output / 'LICENSE')
    print(json.dumps(record['binary']))


if __name__ == '__main__':
    main()
