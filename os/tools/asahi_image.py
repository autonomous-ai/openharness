#!/usr/bin/env python3
"""Prepare a private Asahi disk-image recipe from declared upstream/RPM inputs.

This does not partition a computer, publish an installer, or build shared clients.
Fedora/Asahi owns boot, firmware, kernel and filesystems. Harness owns the first
account screen. Encryption and base update/recovery remain separate work.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET

from fedora_payload import package_identity


ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / 'os/platforms/apple-silicon/source.lock.json'
PLATFORM_PACKAGES = (
    'greetd', 'chromium', 'mesa-dri-drivers', 'mesa-vulkan-drivers',
    'asahi-audio', 'speakersafetyd',
)
FIRST_BOOT_FILES = {
    'usr/lib/harness-os/firstboot.py': ('firstboot.py', 0o755),
    'usr/lib/systemd/system/harness-firstboot.service': ('harness-firstboot.service', 0o644),
    'usr/lib/systemd/system-preset/01-harness-firstboot.preset': ('01-harness-firstboot.preset', 0o644),
}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(*args):
    return subprocess.check_output(list(map(str, args)), text=True).strip()


def read_lock(path=LOCK):
    lock = json.loads(path.read_text())
    upstream = lock.get('upstream', {})
    if (lock.get('schema') != 1 or lock.get('fedora_release') != '44' or
            upstream.get('repository') != 'https://forge.fedoraproject.org/asahi/kiwi-descriptions.git' or
            upstream.get('branch') != 'f44' or
            any(not re.fullmatch(r'[a-f0-9]{40}', str(upstream.get(key))) for key in ('commit', 'tree')) or
            not re.fullmatch(r'registry\.fedoraproject\.org/fedora-minimal@sha256:[a-f0-9]{64}',
                             str(lock.get('builder_image')))):
        raise ValueError('Use the reviewed Fedora Asahi source and native builder lock.')
    return lock


def upstream_identity(folder, lock):
    def git(*args):
        return run('git', '-c', f'safe.directory={folder}', '-C', folder, *args)
    if (git('rev-parse', 'HEAD') != lock['upstream']['commit'] or
            git('rev-parse', 'HEAD^{tree}') != lock['upstream']['tree'] or
            git('status', '--porcelain', '--untracked-files=normal')):
        raise ValueError('Upstream checkout must be clean and match the pinned commit and tree.')
    return git('ls-files', '-z').split('\0')


def requirements(text):
    """Keep RPM dependency expressions as data, including file provides."""
    result = []
    for expression in text.splitlines():
        if expression.startswith('rpmlib('):
            continue
        if not re.fullmatch(r'[A-Za-z0-9_/][A-Za-z0-9_./+():-]*(?:\s+[<=>]+\s+[A-Za-z0-9_.+:~^-]+)?', expression):
            raise ValueError('Unreviewed session RPM requirement: ' + expression)
        result.append(expression)
    if not result or not {'python3', 'foot', 'labwc', 'NetworkManager'} <= set(result):
        raise ValueError('The declared package is missing the Harness session dependencies.')
    return sorted(set(result))


def extend_recipe(destination, dependencies, image_identity):
    """Extend Minimal without rewriting its partition or platform definitions."""
    config = destination / 'config.xml'
    tree = ET.parse(config)
    root = tree.getroot()
    if (root.get('name') != 'Fedora-Asahi-Remix' or
            root.findtext('preferences/release-version') != image_identity['base']['fedora_release'] or
            root.findtext('preferences/rpm-check-signatures') != 'true'):
        raise ValueError('The upstream image contract changed; review it before building.')
    root.set('name', 'Harness-Asahi')
    root.set('displayname', 'Harness')
    root.find('description/specification').text = 'Private Harness image using Fedora Asahi Remix Minimal'
    ET.SubElement(root, 'include', {'from': 'this://./platforms/harness.xml'})
    ET.indent(tree, space='  ')
    tree.write(config, encoding='utf-8', xml_declaration=True)
    profile = ET.Element('image')
    profiles = ET.SubElement(profile, 'profiles')
    selected = ET.SubElement(profiles, 'profile', {'name': 'Harness', 'description': 'Harness terminal and agents'})
    ET.SubElement(selected, 'requires', {'profile': 'Minimal'})
    packages = ET.SubElement(profile, 'packages', {'type': 'image', 'profiles': 'Harness'})
    for name in sorted(set(dependencies) | set(PLATFORM_PACKAGES)):
        ET.SubElement(packages, 'package', {'name': name})
    ET.indent(profile, space='  ')
    ET.ElementTree(profile).write(destination / 'platforms/harness.xml', encoding='utf-8', xml_declaration=True)
    script = destination / 'config.sh'
    text = script.read_text()
    if text.count('\nexit 0\n') != 1 or 'update-m1n1 /boot/efi/m1n1/boot.bin' not in text:
        raise ValueError('The upstream image configuration hook changed.')
    script.write_text(text.replace('\nexit 0\n',
        '\n# Install the separately verified local Harness RPM after signed platform dependencies.\n'
        'HARNESS_ASAHI_IMAGE_BUILD=1 python3 /var/tmp/harness-image-input/configure.py\n\nexit 0\n'))
    identity = destination / 'root/var/tmp/harness-image-input/image.json'
    identity.parent.mkdir(parents=True)
    identity.write_text(json.dumps(image_identity, indent=2) + '\n')


def prepare(upstream, package, package_source, output, source=ROOT):
    lock = read_lock(source / 'os/platforms/apple-silicon/source.lock.json')
    entries = upstream_identity(upstream, lock)
    metadata = package_identity(package, package_source)
    artifact = package / metadata['package']['name']
    dependencies = requirements(run('rpm', '-qp', '--requires', artifact))
    source_commit = run('git', '-c', f'safe.directory={source}', '-C', source, 'rev-parse', 'HEAD')
    if run('git', '-c', f'safe.directory={source}', '-C', source, 'status', '--porcelain', '--untracked-files=normal'):
        raise ValueError('Commit the image source before preparing a build.')
    identity = {
        'schema': 1, 'kind': 'harness-asahi-image-construction', 'published': False,
        'source_commit': source_commit, 'base': lock, 'architecture': 'aarch64',
        'profile': 'Harness', 'session_package': metadata,
        'release_ready': False,
        'first_boot': {'files': {name: {'sha256': digest(source / 'os/platforms/apple-silicon' / local),
                                      'mode': mode}
                                 for name, (local, mode) in FIRST_BOOT_FILES.items()}},
        'pending': ['Disk encryption',
                    'Fedora base updates and recovery', 'Physical Apple hardware acceptance'],
    }
    output.mkdir(parents=True, exist_ok=False)
    description = output / 'description'
    description.mkdir()
    for name in entries:
        if not name:
            continue
        relative = Path(name)
        origin = upstream / relative
        if relative.is_absolute() or '..' in relative.parts or not origin.is_file():
            raise ValueError('Unexpected upstream source entry: ' + name)
        target = description / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if origin.is_symlink():
            link = origin.readlink()
            if link.is_absolute() or '..' in link.parts or not origin.resolve().is_relative_to(upstream.resolve()):
                raise ValueError('Upstream link leaves the description: ' + name)
            target.symlink_to(link)
        else:
            shutil.copy2(origin, target)
    extend_recipe(description, dependencies, identity)
    for name, (local, mode) in FIRST_BOOT_FILES.items():
        target = description / 'root' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / 'os/platforms/apple-silicon' / local, target)
        target.chmod(mode)
    inputs = description / 'root/var/tmp/harness-image-input'
    shutil.copyfile(artifact, inputs / artifact.name)
    shutil.copyfile(source / 'os/platforms/apple-silicon/configure.py', inputs / 'configure.py')
    (output / 'image-inputs.json').write_text(json.dumps(identity, indent=2) + '\n')
    (output / 'recipe-files.json').write_text(json.dumps({
        str(path.relative_to(description)): ({'symlink': str(path.readlink())} if path.is_symlink()
                                           else {'sha256': digest(path)})
        for path in sorted(description.rglob('*')) if path.is_file()
    }, indent=2) + '\n')
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--upstream', required=True, type=Path)
    parser.add_argument('--package', required=True, type=Path)
    parser.add_argument('--package-source', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    identity = prepare(args.upstream.resolve(), args.package.resolve(), args.package_source, args.output.resolve())
    print(json.dumps({'source_commit': identity['source_commit'], 'profile': identity['profile'],
                      'release_ready': False}, indent=2))


if __name__ == '__main__':
    main()
