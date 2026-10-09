#!/usr/bin/env python3
"""Build the same small Harness package for an ISO or an installed test machine."""
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile


DEPENDENCIES = ('nodejs-lts-jod', 'tmux', 'foot', 'gtklock', 'grim', 'slurp')


def package_info(version, timestamp, size, compositor_dependencies=()):
    # These are needed on upgrades too; adding a tool to the ISO list alone
    # leaves existing computers with new launchers but no executable to run.
    return (f'pkgname = harness-os\npkgbase = harness-os\nxdata = pkgtype=pkg\npkgver = {version}\n'
            'pkgdesc = Harness session and verified Harness runtime\n'
            'url = https://github.com/autonomous-ai/openharness\n'
            f'builddate = {timestamp}\npackager = OpenHarness\nsize = {size}\n'
            'arch = x86_64\nlicense = MIT\nlicense = GPL-2.0-only\nlicense = Apache-2.0\n'
            + ''.join(f'depend = {name}\n' for name in dict.fromkeys((*DEPENDENCIES, *compositor_dependencies))))


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def git(source, *args):
    return subprocess.check_output(['git', '-c', f'safe.directory={source}', '-C', str(source), *args], text=True).strip()


def validate_runtime(runtime, commit):
    info = json.loads((runtime / 'source.json').read_text())
    if info.get('dirty') is not False or info.get('source_commit') != commit or info.get('target') != 'x86_64-unknown-linux-musl':
        raise ValueError('Runtime must be built from this clean source commit for Linux x86-64.')
    with (runtime / 'harness-tui').open('rb') as handle:
        header = handle.read(20)
    if header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != 62:
        raise ValueError('The terminal binary must be a 64-bit x86 Linux ELF executable.')
    for name in ['cli.js', 'notify.mjs']:
        if not (runtime / name).is_file() or not (runtime / name).stat().st_size:
            raise ValueError('Missing runtime file: ' + name)
    return info


def stage(source, runtime, destination, commit):
    info = validate_runtime(runtime, commit)
    os_source = source / 'os'
    shutil.copytree(os_source / 'root', destination, symlinks=True)
    browser_spec = importlib.util.spec_from_file_location('browser_home_payload', Path(__file__).with_name('browser_home_payload.py'))
    browser_home = importlib.util.module_from_spec(browser_spec)
    browser_spec.loader.exec_module(browser_home)
    browser_home.stage(source, destination)
    special = {
        'LICENSE': 'usr/share/licenses/harness-os/LICENSE',
        'os/installer.py': 'usr/lib/harness-os/install.py',
        'os/onboarding.py': 'usr/lib/harness-os/onboarding.py',
        'os/network.py': 'usr/lib/harness-os/network.py',
        'os/projects.py': 'usr/lib/harness-os/projects.py',
        'os/trial_projects.py': 'usr/lib/harness-os/trial_projects.py',
        'os/system.py': 'usr/lib/harness-os/system.py',
        'os/boot_profile.py': 'usr/lib/harness-os/boot_profile.py',
        'os/t2_install.py': 'usr/lib/harness-os/t2_install.py',
        'os/t2_update.py': 'usr/lib/harness-os/t2_update.py',
        'os/tools/prepare-t2-kernel.py': 'usr/lib/harness-os/t2_kernel.py',
        'os/tools/prepare-t2-firmware.py': 'usr/lib/harness-os/t2_firmware.py',
        'os/platforms/apple-t2/firmware_names.py': 'usr/lib/harness-os/firmware_names.py',
        'os/platforms/apple-t2/kernel.json': 'usr/share/harness-os/apple-t2/kernel.json',
        'os/runtime_update.py': 'usr/lib/harness-os/runtime_update.py',
        'os/live_update.py': 'usr/lib/harness-os/live_update.py',
        'os/release_update.py': 'usr/lib/harness-os/release_update.py',
        'os/hardware.py': 'usr/lib/harness-os/hardware.py',
        'os/gpu_health.py': 'usr/lib/harness-os/gpu_health.py',
        'os/gpu_probe.py': 'usr/lib/harness-os/gpu_probe.py',
        'os/tools/hn-os': 'usr/bin/hn-os',
        'os/lock.json': 'usr/share/harness-os/lock.json',
        'tui/README.md': 'usr/share/harness-os/guide/tui.md',
        'docs/naming-system.md': 'usr/share/harness-os/guide/naming.md',
    }
    for local, target in special.items():
        path = destination / target
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / local, path)
        path.chmod(0o644)
    (destination / 'usr/share/harness-os/guide/source.json').write_text(
        json.dumps({'source_commit': commit, 'tui_reference': 'tui/README.md'}, indent=2) + '\n')
    # The regular skel AGENTS.md points OpenCode to the current packaged guide.
    # Archive symlinks outside their directory are rejected by the updater.
    library = destination / 'usr/lib/harness'
    library.mkdir(parents=True)
    for local, target in [('harness-tui', 'harness-tui'), ('cli.js', 'cli.mjs'), ('notify.mjs', 'notify.mjs')]:
        shutil.copyfile(runtime / local, library / target)
        (library / target).chmod(0o755 if local == 'harness-tui' else 0o644)
    (library / 'hn').symlink_to('harness-tui')
    for directory in ['usr/bin', 'usr/lib/harness-os']:
        for path in (destination / directory).rglob('*'):
            if path.is_file() and not path.is_symlink():
                path.chmod(0o755)
    for name in ['autostart', 'shutdown']:
        (destination / 'usr/share/harness-os/labwc' / name).chmod(0o755)
    (destination / 'usr/share/harness-os/labwc-install/autostart').chmod(0o755)
    for path in (destination / 'etc/sudoers.d').iterdir():
        path.chmod(0o440)
    info.update(mode='source', files={p.name: {'sha256': digest(p), 'bytes': p.stat().st_size}
                                    for p in library.iterdir() if p.is_file() and not p.is_symlink()})
    (destination / 'usr/share/harness-os/runtime.json').write_text(json.dumps(info, indent=2) + '\n')
    return info


def archive_package(root, output, pkginfo, timestamp):
    """Write root-owned package files without requiring root on the build host."""
    (root / '.PKGINFO').write_text(pkginfo)
    partial = output.with_name(output.name + '.partial')
    try:
        # Both container and members use the source time. Gzip's defaults put
        # the build clock and temporary output filename into otherwise equal
        # packages, preventing checksum reuse across native test environments.
        with partial.open('wb') as raw, gzip.GzipFile(
                filename='', mode='wb', fileobj=raw, compresslevel=6, mtime=timestamp) as compressed:
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
        partial.replace(output)
    finally:
        partial.unlink(missing_ok=True)


def bootstrap(source, folder):
    """Ship every helper needed before the first platform-aware OS package."""
    files = {'apply-update.py': 'runtime_update.py', 'boot_profile.py': 'boot_profile.py',
             't2_install.py': 't2_install.py', 't2_firmware.py': 'tools/prepare-t2-firmware.py',
             'firmware_names.py': 'platforms/apple-t2/firmware_names.py',
             't2_update.py': 't2_update.py', 't2_kernel.py': 'tools/prepare-t2-kernel.py'}
    spec = importlib.util.spec_from_file_location('bootstrap_runtime', source / 'os/runtime_update.py')
    updater = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(updater)
    if set(files) != set(updater.BOOTSTRAP_FILES):
        raise ValueError('Incomplete standalone updater helpers.')
    for name, relative in files.items():
        shutil.copyfile(source / 'os' / relative, folder / name)
    return [folder / name for name in files]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--compositor', type=Path, required=True,
                        help='Verified native compositor from this source and Arch snapshot')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--development', action='store_true', help='Include a source revision in the package version')
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[2]
    if git(source, 'status', '--porcelain', '--untracked-files=normal'):
        parser.error('Commit source changes before building a traceable package.')
    commit = git(source, 'rev-parse', 'HEAD')
    spec = importlib.util.spec_from_file_location('harness_compositor', Path(__file__).with_name('compositor_payload.py'))
    compositor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(compositor)
    compositor.validate(source, args.compositor.resolve(), commit)
    timestamp = int(git(source, 'log', '-1', '--format=%ct'))
    lock = json.loads((source / 'os/lock.json').read_text())
    if lock['architecture'] != 'x86_64' or not re.fullmatch(r'\d+\.\d+\.\d+(?:-preview\.\d+)?', lock['version']):
        parser.error('Expected a versioned x86-64 OS release or numbered preview.')
    version = lock['version'].replace('-preview.', 'pre')
    if args.development:
        # Shallow CI checkouts all have a revision count of one. Use the source
        # commit time so independent packages do not sort by random Git hashes.
        version += '.r' + str(timestamp) + '.g' + commit[:10]
    version += '-1'
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    package = folder / f'harness-os-{version}-x86_64.pkg.tar.gz'
    if package.exists() or (folder / 'package-manifest.json').exists():
        parser.error('Use a fresh output directory; package artifacts are immutable.')
    with tempfile.TemporaryDirectory(prefix='harness-package-') as temp:
        root = Path(temp) / 'root'
        runtime = stage(source, args.runtime.resolve(), root, commit)
        display = compositor.stage(source, args.compositor.resolve(), root, commit)
        size = sum(p.stat().st_size for p in root.rglob('*') if p.is_file() and not p.is_symlink())
        pkginfo = package_info(version, timestamp, size, display['runtime_dependencies'])
        archive_package(root, package, pkginfo, timestamp)
    manifest = {'schema': 1, 'kind': 'harness-os-package', 'development': args.development,
                'source_commit': commit, 'architecture': lock['architecture'],
                'requires_os_version': lock['version'], 'arch_snapshot': lock['arch_snapshot'],
                'runtime': runtime, 'compositor': display,
                'package': {'name': package.name, 'version': version, 'bytes': package.stat().st_size, 'sha256': digest(package)}}
    if lock.get('upgrades_from'):
        manifest['upgrades_from'] = lock['upgrades_from']
    (folder / 'package-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (folder / (package.name + '.sha256')).write_text(f'{manifest["package"]["sha256"]}  {package.name}\n')
    # A preview 4 installation can bootstrap the updater from this same bundle.
    standalone = bootstrap(source, folder)
    (folder / 'SHA256SUMS').write_text(''.join(f'{digest(path)}  {path.name}\n' for path in
                                            [package, folder / 'package-manifest.json', *standalone]))
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
