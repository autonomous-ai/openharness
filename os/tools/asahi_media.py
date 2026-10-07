#!/usr/bin/env python3
"""Prepare private ARM UEFI media around an already verified Harness image.

Only the installer userspace is built. The installed system and every shared
client remain the exact previously tested image, supplied as an offline payload.
"""
import argparse
from contextlib import contextmanager
import json
from pathlib import Path
import re
import shutil
import stat
import tempfile
import xml.etree.ElementTree as ET

from asahi_image import ROOT, digest, read_lock, run, upstream_identity

INSTALLER_FILES = ('media.py', 'install.py', 'target.py', 'storage.py', 'startup.py')
POLICY_DIRS = ('etc/selinux/targeted', 'var/lib/selinux/targeted')
PACKAGES = (
    'fedora-release', 'systemd', 'systemd-udev', 'dbus', 'bash', 'python3',
    'util-linux', 'cryptsetup', 'btrfs-progs', 'e2fsprogs', 'dosfstools', 'gdisk',
    'rsync', 'policycoreutils', 'selinux-policy-targeted', 'kbd', 'ncurses-base',
    'glibc-minimal-langpack', 'shadow-utils', 'dracut-kiwi-live', 'grub2-efi-aa64-cdboot',
    'asahi-platform-metapackage-core', 'asahi-repos', 'tiny-dfr',
)


def payload_identity(image, receipt, producer, source_commit):
    if (not re.fullmatch('[a-f0-9]{40}', source_commit) or
            producer.get('head_sha') != source_commit or
            producer.get('path') != '.github/workflows/os-asahi-image.yml' or
            producer.get('repository', {}).get('full_name') != 'autonomous-ai/openharness' or
            producer.get('status') != 'completed' or producer.get('conclusion') != 'success' or
            receipt.get('status') != 'passed'):
        raise ValueError('Use a successful, inspected private Asahi image producer.')
    original = receipt.get('image', {})
    if (original.get('kind') != 'harness-asahi-image-construction' or
            original.get('source_commit') != source_commit or original.get('profile') != 'Harness' or
            original.get('published') is not False or original.get('release_ready') is not False):
        raise ValueError('The source image provenance has changed.')
    artifact = receipt.get('artifact', {})
    info = image.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_size != artifact.get('bytes') or
            not re.fullmatch('[a-f0-9]{64}', str(artifact.get('sha256'))) or
            digest(image) != artifact['sha256']):
        raise ValueError('The offline payload differs from its verified image.')
    return {'source_commit': source_commit, 'producer_run_id': producer['id'],
            'sha256': artifact['sha256'], 'bytes': info.st_size}


@contextmanager
def image_root(image):
    """Read the already verified payload without ever replaying its filesystem."""
    folder = Path(tempfile.mkdtemp(prefix='harness-media-policy-'))
    loop = None
    mounted = False
    try:
        loop = run('losetup', '--find', '--show', '--read-only', '--partscan',
                   '--sector-size', '4096', image)
        if not re.fullmatch('/dev/loop[0-9]+', loop):
            raise ValueError('Unexpected policy source device.')
        run('mount', '-t', 'btrfs', '-o', 'ro,rescue=nologreplay,subvol=root', loop + 'p3', folder)
        mounted = True
        yield folder
    finally:
        if mounted:
            run('umount', folder)
        if loop is not None and re.fullmatch('/dev/loop[0-9]+', loop):
            run('losetup', '--detach', loop)
        # A failed unmount must never become a recursive source-image deletion.
        folder.rmdir()


def policy_inventory(root, owner_uid=0):
    files = {}
    for prefix in POLICY_DIRS:
        base = root / prefix
        for part in [base, *base.parents]:
            if part == root:
                break
            if part.is_symlink():
                raise ValueError('The SELinux policy path was redirected.')
        for path in [base, *sorted(base.rglob('*'))]:
            info = path.lstat()
            if (info.st_uid != owner_uid or info.st_mode & 0o022 or
                    not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode))):
                raise ValueError('The SELinux policy has an unexpected type, owner or mode.')
            if stat.S_ISREG(info.st_mode):
                files[str(path.relative_to(root))] = {'sha256': digest(path), 'bytes': info.st_size,
                                                     'mode': stat.S_IMODE(info.st_mode)}
    binaries = [name for name in files if re.fullmatch(r'etc/selinux/targeted/policy/policy\.\d+', name)]
    required = {'etc/selinux/targeted/contexts/files/file_contexts',
                'var/lib/selinux/targeted/active/policy.kern'}
    if len(binaries) != 1 or not required <= files.keys():
        raise ValueError('Use a complete installed SELinux policy and module store.')
    return files


def stage_policy(root, destination, owner_uid=0):
    # With a smaller live policy, source labels unknown to its kernel appear as
    # unlabeled_t to rsync. Carry the installed policy and its module store so
    # the live kernel can preserve every source type from the start.
    files = policy_inventory(root, owner_uid)
    for prefix in POLICY_DIRS:
        shutil.copytree(root / prefix, destination / prefix, dirs_exist_ok=True)
    if policy_inventory(destination, owner_uid) != files:
        raise ValueError('The staged SELinux policy differs from the verified image.')
    return files


def live_recipe(description):
    """Retain pinned repositories/BootCore; give the installer its own live root."""
    path = description / 'config.xml'
    tree = ET.parse(path)
    root = tree.getroot()
    if (root.get('name') != 'Fedora-Asahi-Remix' or
            root.findtext('preferences/release-version') != '44' or
            root.findtext('preferences/rpm-check-signatures') != 'true'):
        raise ValueError('Review the changed upstream image contract.')
    root.set('name', 'Harness-Asahi-Installer')
    root.set('displayname', 'Harness')
    root.find('description/specification').text = 'Private Harness offline installation media'
    # C.UTF-8 is supplied by glibc-minimal-langpack and supports the terminal
    # wordmark without pulling every language into the installation environment.
    locale = root.find('preferences/locale')
    if locale is None:
        locale = ET.SubElement(root.find('preferences'), 'locale')
    # KIWI's schema takes "C" and setup_locale appends the UTF-8 suffix.
    locale.text = 'C'
    keep = {'this://./repositories/core.xml', 'this://./repositories/asahi.xml', 'this://./components/boot.xml'}
    for node in list(root.findall('include')):
        if node.get('from') not in keep:
            root.remove(node)
    if {n.get('from') for n in root.findall('include')} != keep:
        raise ValueError('The upstream repository or BootCore includes changed.')
    profiles = ET.SubElement(root, 'profiles')
    selected = ET.SubElement(profiles, 'profile', {'name': 'HarnessInstall', 'description': 'Install Harness'})
    ET.SubElement(selected, 'requires', {'profile': 'BootCore'})
    prefs = ET.SubElement(root, 'preferences', {'profiles': 'HarnessInstall'})
    live = ET.SubElement(prefs, 'type', {'image': 'iso', 'flags': 'overlay', 'filesystem': 'squashfs',
        'squashfscompression': 'zstd',
        'firmware': 'uefi', 'hybridpersistent': 'false', 'volid': 'HARNESS_INSTALL',
        'kernelcmdline': 'console=tty0 quiet systemd.show_status=false rd.udev.log_level=3 systemd.unit=multi-user.target'})
    ET.SubElement(live, 'bootloader', {'name': 'grub2', 'console': 'none', 'timeout': '0'})
    packages = ET.SubElement(root, 'packages', {'type': 'image', 'profiles': 'HarnessInstall'})
    for name in PACKAGES:
        ET.SubElement(packages, 'package', {'name': name})
    ET.SubElement(packages, 'ignore', {'name': 'dracut-config-rescue'})
    ET.indent(tree, space='  ')
    tree.write(path, encoding='utf-8', xml_declaration=True)


def prepare(upstream, image, receipt_path, producer_path, image_source, output, source=ROOT):
    lock = read_lock(source / 'os/platforms/apple-silicon/source.lock.json')
    entries = upstream_identity(upstream, lock)
    producer, receipt = json.loads(producer_path.read_text()), json.loads(receipt_path.read_text())
    payload = payload_identity(image, receipt, producer, image_source)
    commit = run('git', '-c', f'safe.directory={source}', '-C', source, 'rev-parse', 'HEAD')
    if run('git', '-c', f'safe.directory={source}', '-C', source, 'status', '--porcelain', '--untracked-files=normal'):
        raise ValueError('Commit the media source before building.')
    identity = {'schema': 1, 'kind': 'harness-asahi-installer-media', 'source_commit': commit,
                'architecture': 'aarch64', 'base': lock, 'published': False, 'release_ready': False,
                'payload': payload, 'installer': {name: digest(source / 'os/platforms/apple-silicon' / name)
                                                for name in INSTALLER_FILES}}
    output.mkdir(parents=True, exist_ok=False)
    description = output / 'description'
    description.mkdir()
    for name in filter(None, entries):
        origin, target = upstream / name, description / name
        if Path(name).is_absolute() or '..' in Path(name).parts or not origin.is_file():
            raise ValueError('Unexpected upstream file: ' + name)
        target.parent.mkdir(parents=True, exist_ok=True)
        if origin.is_symlink():
            link = origin.readlink()
            if link.is_absolute() or '..' in link.parts:
                raise ValueError('Unreviewed upstream link: ' + name)
            target.symlink_to(link)
        else:
            shutil.copy2(origin, target)
    live_recipe(description)
    with image_root(image) as mounted:
        identity['selinux'] = stage_policy(mounted, description / 'root/usr/share/harness-installer/policy')
    platform = source / 'os/platforms/apple-silicon'
    # Upstream config.sh configures an installed OS, including boot.bin. Its
    # bootstrap guard stays; this live-specific hook never generates that file.
    shutil.copyfile(platform / 'configure-media.sh', description / 'config.sh')
    (description / 'config.sh').chmod(0o755)
    data = description / 'root/usr/share/harness-installer'
    data.mkdir(parents=True, exist_ok=True)
    (data / 'media.json').write_text(json.dumps(identity, indent=2) + '\n')
    run('cp', '--sparse=always', '--reflink=auto', image, data / 'payload.raw')
    (data / 'payload.raw').chmod(0o444)
    for name in INSTALLER_FILES:
        dest = description / 'root/usr/lib/harness-installer' / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(platform / name, dest)
        dest.chmod(0o644)
    unit = description / 'root/usr/lib/systemd/system/harness-installer.service'
    unit.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(platform / unit.name, unit)
    # PID 1 reapplies vendor presets when the live overlay gets its first
    # machine identity. Explicit enablement alone is undone by Fedora's default.
    preset = description / 'root/usr/lib/systemd/system-preset/00-harness-installer.preset'
    preset.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(platform / preset.name, preset)
    (output / 'media-inputs.json').write_text(json.dumps(identity, indent=2) + '\n')
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('upstream', 'image', 'receipt', 'producer', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--image-source', required=True)
    args = parser.parse_args()
    identity = prepare(args.upstream.resolve(), args.image, args.receipt, args.producer,
                       args.image_source, args.output.resolve())
    print(json.dumps(identity, indent=2))


if __name__ == '__main__':
    main()
