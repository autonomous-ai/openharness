"""The Fedora session payload, shared by RPM packaging and private VM checks.

This is one component of a future Harness OS image. Platform packages, boot and
base-system recovery belong to Fedora/Asahi. Login setup is a separate opt-in.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import xml.etree.ElementTree as ET

import opencode_payload


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def runtime_identity(runtime, commit):
    record = runtime / 'source.json'
    if record.is_symlink() or not record.is_file() or not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('Use a regular runtime identity and its full source commit.')
    info = json.loads(record.read_text())
    if (info.get('dirty') is not False or info.get('source_commit') != commit or
            info.get('architecture') != 'aarch64' or info.get('target') != 'aarch64-unknown-linux-musl'):
        raise ValueError('Use the clean native ARM runtime from the declared source commit.')
    if set(info.get('files', {})) != {'harness-tui', 'cli.js', 'notify.mjs'}:
        raise ValueError('Runtime is incomplete.')
    for name, identity in info['files'].items():
        path = runtime / name
        if (not isinstance(identity, dict) or type(identity.get('bytes')) is not int or identity['bytes'] <= 0 or
                not re.fullmatch(r'[a-f0-9]{64}', str(identity.get('sha256'))) or
                path.is_symlink() or not path.is_file() or path.stat().st_size != identity['bytes'] or
                digest(path) != identity['sha256']):
            raise ValueError('Runtime checksum mismatch: ' + name)
    with (runtime / 'harness-tui').open('rb') as handle:
        header = handle.read(64)
    if (len(header) < 64 or header[:7] != b'\x7fELF\x02\x01\x01' or
            int.from_bytes(header[16:18], 'little') not in (2, 3) or
            int.from_bytes(header[18:20], 'little') != 183 or
            int.from_bytes(header[20:24], 'little') != 1):
        raise ValueError('The terminal must be a little-endian ARM64 ELF executable.')
    return info


def stage(source, runtime, destination, commit, runtime_commit, agent=None):
    info = runtime_identity(runtime, runtime_commit)
    # An allowlist keeps PC hooks and private fixture provisioning out of RPMs.
    paths = [
        'usr/bin/hn', 'usr/bin/harness', 'usr/bin/hn-browser',
        'usr/share/harness-os/foot.ini', 'usr/share/harness-os/tmux.conf',
        'usr/share/harness-os/lock/layout.ui', 'usr/share/harness-os/lock/style.css',
        *['usr/share/harness-os/labwc/' + name for name in ['autostart', 'shutdown', 'rc.xml']],
        *['usr/lib/harness-os/' + name for name in
          ['session', 'session-settings.py', 'runtime-path', 'wait-runtime', 'virtio-2d', 'open-wifi', 'open-updates', 'screen-action', 'screenshot', 'lock', 'files']],
        *['usr/lib/systemd/user/' + name for name in
          ['harness-os.target', 'hn-screen.service', 'harness-daemon.service', 'harness-idle.service',
           'harness-update.service', 'harness-update.timer']],
    ]
    for name in paths:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / 'os/root' / name, target)
    for local, name in [
        *[('os/' + name + '.py', 'usr/lib/harness-os/' + name + '.py') for name in
          ['onboarding', 'network', 'projects', 'hardware', 'live_update', 'fedora_session']],
        ('os/tools/hn-os', 'usr/bin/hn-os'),
        ('tui/README.md', 'usr/share/harness-os/guide/tui.md'),
        ('docs/naming-system.md', 'usr/share/harness-os/guide/naming.md'),
        ('os/packaging/fedora/guide.md', 'usr/share/harness-os/guide.md'),
        ('os/packaging/fedora/AGENTS.md', 'usr/share/harness-os/AGENTS.md'),
        ('LICENSE', 'usr/share/licenses/harness-os/LICENSE'),
    ]:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / local, target)
    library = destination / 'usr/lib/harness'
    library.mkdir(parents=True)
    for local, target in [('harness-tui', 'harness-tui'), ('cli.js', 'cli.mjs'), ('notify.mjs', 'notify.mjs')]:
        shutil.copyfile(runtime / local, library / target)
    (library / 'hn').symlink_to('harness-tui')
    (destination / 'usr/bin/harness-session').symlink_to('../lib/harness-os/session')
    (destination / 'usr/bin/harness-session-setup').symlink_to('../lib/harness-os/fedora_session.py')
    info.update(system_profile='fedora', package_source_commit=commit,
                files={p.name: {'bytes': p.stat().st_size, 'sha256': digest(p)}
                       for p in library.iterdir() if not p.is_symlink()})
    (destination / 'usr/share/harness-os/runtime.json').write_text(json.dumps(info, indent=2) + '\n')
    (destination / 'usr/share/harness-os/guide/source.json').write_text(json.dumps({
        'package_source_commit': commit, 'runtime_source_commit': runtime_commit,
        'tui_reference': 'tui/README.md', 'tui_reference_source_commit': commit,
    }, indent=2) + '\n')
    target = destination / 'usr/lib/systemd/user/harness-os.target'
    target.write_text(target.read_text().replace(' harness-install.service', '').replace(' harness-gpu-check.timer', ''))
    config = destination / 'usr/share/harness-os/labwc/rc.xml'
    tree = ET.parse(config)
    keyboard = tree.getroot().find('keyboard')
    for binding in list(keyboard.findall('keybind')):
        if binding.get('key') == 'W-i':
            keyboard.remove(binding)
    for action in tree.findall('.//action'):
        if action.get('name') == 'NextWindowImmediate':
            action.set('name', 'NextWindow')  # Fedora labwc's supported action.
    tree.write(config, encoding='unicode')
    browser = destination / 'usr/bin/hn-browser'
    browser.write_text(browser.read_text().replace('/usr/bin/chromium ', '/usr/bin/chromium-browser '))
    # The experimental Fedora/Asahi session still uses its distribution's
    # compositor; the pinned PC executable is an x86-64 Arch payload.
    session = destination / 'usr/lib/harness-os/session'
    session.write_text(session.read_text().replace('/usr/lib/harness-os/labwc -C', 'labwc -C'))
    for path in destination.rglob('*'):
        if not path.is_symlink():
            path.chmod(0o755 if path.is_dir() else 0o644)
    for directory in ['usr/bin', 'usr/lib/harness-os']:
        for path in (destination / directory).iterdir():
            if not path.is_symlink():
                path.chmod(0o755)
    for name in ['autostart', 'shutdown']:
        (destination / 'usr/share/harness-os/labwc' / name).chmod(0o755)
    (library / 'harness-tui').chmod(0o755)
    bundled = (opencode_payload.stage(agent, destination,
               opencode_payload.read_lock(source / 'os/packaging/fedora/opencode.lock.json')) if agent else None)
    return {'runtime': info, 'agent': bundled, 'files': {str(p.relative_to(destination)): digest(p)
                                     for p in sorted(destination.rglob('*')) if p.is_file() and not p.is_symlink()},
            'symlinks': {str(p.relative_to(destination)): str(p.readlink())
                         for p in sorted(destination.rglob('*')) if p.is_symlink()}}


def package_identity(folder, source=None):
    """Check an immutable local package before a private fixture installs it."""
    record = folder / 'package-manifest.json'
    if record.is_symlink() or not record.is_file():
        raise ValueError('Use a regular Fedora package manifest.')
    info = json.loads(record.read_text())
    if (info.get('schema') != 1 or info.get('kind') != 'harness-os-fedora-session' or
            info.get('architecture') != 'aarch64' or info.get('published') is not False or
            not re.fullmatch(r'[a-f0-9]{40}', str(info.get('package_source_commit'))) or
            (source and info['package_source_commit'] != source)):
        raise ValueError('Use an exact-source unpublished Fedora ARM session package.')
    entry = info.get('package', {})
    name = entry.get('name', '')
    if not re.fullmatch(r'harness-os-session-[A-Za-z0-9.~+-]+\.aarch64\.rpm', name):
        raise ValueError('Invalid Fedora package name.')
    artifact = folder / name
    if (type(entry.get('bytes')) is not int or entry['bytes'] <= 0 or
            not re.fullmatch(r'[a-f0-9]{64}', str(entry.get('sha256'))) or
            artifact.is_symlink() or not artifact.is_file() or
            artifact.stat().st_size != entry['bytes'] or digest(artifact) != entry['sha256']):
        raise ValueError('Fedora package checksum mismatch.')
    if (info.get('runtime_source_commit') != info.get('runtime', {}).get('source_commit') or
            not re.fullmatch(r'[a-f0-9]{40}', str(info.get('runtime_source_commit'))) or
            info['runtime'].get('system_profile') != 'fedora'):
        raise ValueError('Missing Fedora runtime provenance.')
    return info
