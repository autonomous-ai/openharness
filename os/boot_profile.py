"""The boot files and early input stack belonging to an installed platform."""
import importlib.util
import json
from pathlib import Path
import tarfile


PROFILES = {
    'pc': {'kernel': 'linux-lts', 'modules': [], 'parameters': []},
    'apple-t2': {'kernel': 'linux-t2', 'modules': ['t2bce_dma', 't2bce_core', 't2bce_vhci'],
                 'parameters': ['intel_iommu=on', 'iommu=pt', 'pm_async=off']},
}


def profile(identity):
    if not isinstance(identity, str) or identity not in PROFILES:
        raise ValueError('Unknown Harness boot platform.')
    return dict(PROFILES[identity], id=identity)


def selected(root=Path('/')):
    path = root / 'etc/harness-platform.json'
    if path.is_symlink():
        raise ValueError('The boot platform record must be a regular file.')
    if not path.exists():
        return profile('pc')  # Published PC images predate explicit profiles.
    if not path.is_file():
        raise ValueError('The boot platform record must be a regular file.')
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or set(value) != {'schema', 'id'} or type(value['schema']) is not int or value['schema'] != 1:
        raise ValueError('Invalid Harness boot platform record.')
    return profile(value['id'])


def boot_files(identity):
    kernel = profile(identity)['kernel']
    return {'vmlinuz-' + kernel, 'initramfs-' + kernel + '.img', 'grub/grub.cfg'}


def validate_update(package, root=Path('/')):
    if selected(root)['id'] != 'apple-t2':
        return
    # The initial T2 image has one verified kernel. A general PC package must
    # not remove its helpers or silently advance the required T2 kernel. A
    # future kernel change needs its own staged, verified package transaction.
    pin = 'usr/share/harness-os/apple-t2/kernel.json'
    required = {'usr/lib/harness-os/' + name + '.py' for name in
                ['boot_profile', 't2_install', 't2_firmware', 'firmware_names']}
    with tarfile.open(package, 'r:gz') as archive:
        files = {entry.name: entry for entry in archive}
        if any(name not in files or not files[name].isfile() for name in required | {pin}):
            raise ValueError('This update does not include the T2 platform. Nothing updated.')
        if files[pin].size > 65536:
            raise ValueError('Invalid T2 kernel requirements in the update.')
        requested = json.loads(archive.extractfile(files[pin]).read())
    if requested != json.loads((root / pin).read_text()):
        raise ValueError('This update needs a different T2 kernel; a verified T2 kernel update is required. Nothing updated.')


def restore_firmware(root=Path('/')):
    if selected(root)['id'] == 'apple-t2':
        helper = module('t2_install')
        helper.restore(root, helper.retained(root))


def module(name):
    paths = {'t2_install': 't2_install.py', 't2_firmware': 'tools/prepare-t2-firmware.py'}
    if name not in paths:
        raise ValueError('Unknown platform helper.')
    path = Path(__file__).with_name(name + '.py')
    if not path.is_file():
        path = Path(__file__).parent / paths[name]
    spec = importlib.util.spec_from_file_location('harness_' + name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
