#!/usr/bin/env python3
"""Build real, unpublished native runtimes for the private VM update feed."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib

ROOT = Path(__file__).resolve().parents[2]
VERSION = '999.0.1'
BASE_URL = 'http://127.0.0.1:19447/'
FILES = {'harness-tui', 'cli.js', 'notify.mjs'}
TARGETS = {'x86_64': ('linux-x64', 'x64', 62), 'aarch64': ('linux-arm64', 'arm64', 183)}


def command(*args, cwd=ROOT, **kwargs):
    return subprocess.check_output([str(arg) for arg in args], cwd=cwd, text=True,
                                   timeout=30, **kwargs).strip()


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def clean_source(source):
    commit = command('git', 'rev-parse', 'HEAD', cwd=source)
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or command('git', 'status', '--porcelain', '--untracked-files=normal', cwd=source):
        raise ValueError('Commit source changes before building a traceable update fixture.')
    return commit


def verify_elf(path, architecture):
    with path.open('rb') as handle:
        header = handle.read(64)
    if (len(header) != 64 or header[:7] != b'\x7fELF\x02\x01\x01' or
            int.from_bytes(header[16:18], 'little') not in (2, 3) or
            int.from_bytes(header[18:20], 'little') != TARGETS[architecture][2] or
            int.from_bytes(header[20:24], 'little') != 1):
        raise ValueError('The fixture requires a matching native Linux ELF executable.')


def validate_runtime(runtime, commit, architecture, versions, baselines):
    if {path.name for path in runtime.iterdir()} != FILES | {'source.json'}:
        raise ValueError('Use the complete, unmodified baseline runtime directory.')
    if (runtime / 'source.json').is_symlink():
        raise ValueError('The baseline identity cannot be a symlink.')
    info = json.loads((runtime / 'source.json').read_text())
    if (not isinstance(info, dict) or info.get('source_commit') != commit or info.get('dirty') is not False or
            info.get('architecture') != architecture or info.get('target') != architecture + '-unknown-linux-musl' or
            info.get('versions') != versions or info.get('release_baselines') != baselines or
            not isinstance(info.get('files'), dict) or
            set(info.get('files', {})) != FILES):
        raise ValueError('The baseline runtime must match this exact clean source and native architecture.')
    for name, identity in info['files'].items():
        path = runtime / name
        if (not isinstance(identity, dict) or path.is_symlink() or not path.is_file() or path.stat().st_size != identity.get('bytes') or
                digest(path) != identity.get('sha256')):
            raise ValueError('The baseline runtime failed verification: ' + name)
    verify_elf(runtime / 'harness-tui', architecture)
    return info


def probe_versions(folder, architecture, expected, cli_name):
    verify_elf(folder / 'harness-tui', architecture)
    hn = command(folder / 'harness-tui', '--version', env=dict(os.environ, HN_AS_TMUX='0'))
    match = re.fullmatch(r'hn (\d+\.\d+\.\d+)(?: \(tmux [^\r\n]+\))?', hn)
    versions = {'hn': match[1] if match else None, 'cli': command('node', folder / cli_name, 'version')}
    if versions != expected:
        raise ValueError('The compiled runtime did not report the expected versions.')
    return versions


def copy_tui(source, destination):
    # Compile tracked source only; ignored files cannot quietly enter a fixture.
    paths = subprocess.check_output(['git', '-C', str(source), 'ls-files', '-z', '--', 'tui'], timeout=30)
    for value in paths.split(b'\0'):
        if not value:
            continue
        relative = Path(os.fsdecode(value))
        target = destination / relative.relative_to('tui')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, target, follow_symlinks=False)
    manifest, lock = destination / 'Cargo.toml', destination / 'Cargo.lock'
    for path, pattern in [(manifest, r'(?m)(^version = ")[^"]+'),
                          (lock, r'(name = "harness-tui"\nversion = ")[^"]+')]:
        updated, count = re.subn(pattern, r'\g<1>' + VERSION, path.read_text(), count=1)
        if count != 1:
            raise ValueError('Could not set the private fixture version in ' + path.name)
        path.write_text(updated)


def write_manifests(folder, architecture, current_cli, baseline):
    def ref(name):
        return {'url': BASE_URL + name, 'sha256': digest(folder / name), 'size': (folder / name).stat().st_size}

    documents = {
        'hn.json': {'version': VERSION, 'builds': {TARGETS[architecture][0]: ref('harness-tui')}},
        'cli.json': {'cli': {'version': VERSION, 'cli': ref('cli.mjs'), 'notify': ref('notify.mjs')}},
        'cli-current.json': {'cli': {'version': current_cli, 'cli': ref('cli-current.mjs'), 'notify': ref('notify.mjs')}},
        'cli-ancestor.json': {'cli': {'version': baseline, 'cli': ref('cli.mjs'), 'notify': ref('notify.mjs')}},
        'feeds-ancestor.json': {'cli': BASE_URL + 'cli-ancestor.json'},
        'feeds-hn.json': {'hn': BASE_URL + 'hn.json', 'cli': BASE_URL + 'cli-current.json'},
        'feeds-both.json': {'hn': BASE_URL + 'hn.json', 'cli': BASE_URL + 'cli.json'},
    }
    for name, data in documents.items():
        (folder / name).write_text(json.dumps(data) + '\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, default=ROOT / 'os/work/runtime')
    parser.add_argument('--output', type=Path, default=ROOT / 'os/work/fast-update-fixture')
    args = parser.parse_args(argv)
    architecture = platform.machine()
    if platform.system() != 'Linux' or architecture not in TARGETS or os.geteuid() == 0:
        parser.error('Build as an ordinary user on native x86-64 or ARM64 Linux.')
    output, runtime = args.output.absolute(), args.runtime.resolve(strict=True)
    if output.exists() or output.is_symlink():
        parser.error('Use a fresh output directory; fixtures are immutable.')
    if shutil.disk_usage(ROOT).free < 4 * 1024 ** 3:
        parser.error('The native build requires at least 4 GiB of free space.')
    if command('node', '-p', 'process.arch') != TARGETS[architecture][1]:
        parser.error('Node must match the native Linux build architecture.')
    started = time.time()
    commit = clean_source(ROOT)
    versions = {'hn': tomllib.loads((ROOT / 'tui/Cargo.toml').read_text())['package']['version'],
                'cli': json.loads((ROOT / 'cli/package.json').read_text())['version']}
    baselines = json.loads(command(sys.executable, ROOT / 'os/tools/runtime-baseline.py'))
    baseline = baselines.get('cli', {}).get('version')
    if not isinstance(baseline, str) or not re.fullmatch(r'\d+\.\d+\.\d+', baseline):
        parser.error('The fixture needs a published CLI ancestor; fetch complete history and release tags.')
    info = validate_runtime(runtime, commit, architecture, versions, baselines)
    probe_versions(runtime, architecture, versions, 'cli.js')
    target = architecture + '-unknown-linux-musl'
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.update-fixture-', dir=output.parent) as temporary:
        work = Path(temporary)
        project, stage = work / 'tui', work / 'fixture'
        stage.mkdir()
        copy_tui(ROOT, project)
        subprocess.run(['cargo', 'build', '--locked', '--release', '--target', target,
                        '--manifest-path', str(project / 'Cargo.toml')], check=True, cwd=ROOT, timeout=1200,
                       env=dict(os.environ, CARGO_TARGET_DIR=str(ROOT / 'tui/target')))
        shutil.copy2(ROOT / 'tui/target' / target / 'release/harness-tui', stage / 'harness-tui')
        # The CLI already exposes a separate output directory for real update tests.
        subprocess.run(['node', 'build-bundle.mjs'], cwd=ROOT / 'cli', check=True, timeout=180,
                       env=dict(os.environ, ADAPTER_VERSION=VERSION, BUNDLE_OUT_DIR=str(work / 'cli')))
        shutil.copyfile(work / 'cli/cli.js', stage / 'cli.mjs')
        shutil.copyfile(work / 'cli/notify.mjs', stage / 'notify.mjs')
        shutil.copyfile(runtime / 'cli.js', stage / 'cli-current.mjs')
        compiled = probe_versions(stage, architecture, {'hn': VERSION, 'cli': VERSION}, 'cli.mjs')
        if command('node', stage / 'cli-current.mjs', 'version') != versions['cli']:
            raise ValueError('The original CLI changed while preparing the fixture.')
        if clean_source(ROOT) != commit or validate_runtime(runtime, commit, architecture, versions, baselines) != info:
            raise ValueError('Source or baseline runtime changed during the build.')
        write_manifests(stage, architecture, versions['cli'], baseline)
        receipt = {'status': 'prepared', 'version': VERSION, 'published': False, 'source_commit': commit,
                   'architecture': architecture, 'target': target, 'platform': TARGETS[architecture][0],
                   'versions': compiled, 'runtime': info, 'runtime_identity_sha256': digest(runtime / 'source.json'),
                   'node': command('node', '--version'), 'rust': command('rustc', '--version'),
                   'started_at': started, 'finished_at': time.time(),
                   'files': {path.name: digest(path) for path in sorted(stage.iterdir())}}
        (stage / 'fixture.json').write_text(json.dumps(receipt, indent=2) + '\n')
        stage.rename(output)
    print(f'Private {TARGETS[architecture][0]} fixture: {output}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        raise SystemExit('Harness update fixture: ' + str(error))
