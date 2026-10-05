#!/usr/bin/env python3
"""Check actual initramfs contents with private, test-only Apple DMI fixtures.

Run inside an unshared mount namespace in a disposable installed VM. This proves
module selection and dependency closure, not operation of a physical Mac keyboard.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

CONFIG = Path('/etc/mkinitcpio.conf.d/20-harness-apple-keyboard.conf')
FIXTURE_CONFIG = CONFIG.with_name('00-harness-test.conf')
DMI = Path('/sys/class/dmi/id/product_name')
PXA = ['spi_pxa2xx_pci', 'spi_pxa2xx_platform', 'applespi']
LPSS = ['intel_lpss_pci', 'spi_pxa2xx_platform', 'applespi']
APPLE_MODULES = set(PXA + LPSS)


def run(*args, check=True, timeout=180, cwd=None):
    return subprocess.run(args, text=True, capture_output=True, check=check,
                          timeout=timeout, cwd=cwd)


def normalized(name):
    return name.replace('-', '_')


def image_record(folder, name, required, forbidden):
    """Use the production preset path, then inspect its actual cpio and loaders."""
    started = time.monotonic()
    build = run('mkinitcpio', '-P', check=False)
    (folder / (name + '-build.log')).write_text(build.stdout + build.stderr)
    assert build.returncode == 0, (name, build.returncode, build.stderr)
    image = Path('/boot/initramfs-linux-lts.img')
    listing = run('lsinitcpio', '-l', str(image)).stdout
    (folder / (name + '-contents.txt')).write_text(listing)
    present = {normalized(Path(line.strip()).name.split('.ko')[0])
               for line in listing.splitlines() if '.ko' in line}
    assert set(required) <= present, (name, 'missing', set(required) - present)
    assert not set(forbidden) & present, (name, 'unexpected', set(forbidden) & present)
    extracted = folder / 'extracted'
    extracted.mkdir()
    try:
        run('lsinitcpio', '-x', str(image), cwd=extracted)
        configs = {str(path.relative_to(extracted)): path.read_text()
                   for path in extracted.rglob('modules-load.d/*.conf')}
        loaded = {normalized(line.strip()) for contents in configs.values()
                  for line in contents.splitlines()
                  if line.strip() and not line.lstrip().startswith(('#', ';'))}
        assert set(required) <= loaded, (name, 'not explicitly loaded', set(required) - loaded, configs)
        assert not set(forbidden) & loaded
        dependencies = {}
        for module in required:
            output = run('modprobe', '--show-depends', module).stdout
            closure = {normalized(Path(line.split()[1]).name.split('.ko')[0])
                       for line in output.splitlines() if line.startswith('insmod ')}
            assert closure <= present, (name, module, 'missing dependency', closure - present)
            dependencies[module] = {'modprobe': output, 'included_modules': sorted(closure)}
    finally:
        shutil.rmtree(extracted)
    with image.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    return {'sha256': digest, 'bytes': image.stat().st_size,
            'modules_load': configs, 'dependency_closure': dependencies,
            'apple_modules': sorted(APPLE_MODULES & present),
            'seconds': round(time.monotonic() - started, 3)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    assert os.geteuid() == 0
    assert run('lsblk', '-ndo', 'SERIAL', '/dev/vda').stdout.strip() == 'HN_OS_TEST'
    assert os.readlink('/proc/self/ns/mnt') != os.readlink('/proc/1/ns/mnt'), 'Use unshare --mount'
    assert not CONFIG.exists(), 'Baseline image already contains the candidate'
    assert not FIXTURE_CONFIG.exists()
    folder = args.output.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    original_dmi = DMI.read_text()
    fixture = folder / 'product_name'
    fixture.write_text('MacBookPro14,1\n')
    result = {'status': 'running', 'kernel': run('uname', '-r').stdout.strip(),
              'mkinitcpio': run('mkinitcpio', '--version').stdout.strip(),
              'original_dmi': original_dmi.strip(), 'selection': {}, 'images': {},
              'scope': 'Native mkinitcpio with private DMI fixtures; no physical Apple input claim'}
    run('mount', '--bind', str(fixture), str(DMI))
    try:
        CONFIG.parent.mkdir(parents=True, exist_ok=True)
        # Isolate the missing host dependency, even if keyboard autodetection
        # correctly includes applespi on an actual Mac.
        FIXTURE_CONFIG.write_text('MODULES+=(virtio_net applespi)\n')
        result['images']['baseline'] = image_record(folder, 'baseline',
            ['virtio_net', 'applespi'], APPLE_MODULES - {'applespi'})
        FIXTURE_CONFIG.write_text('MODULES+=(virtio_net)\n')
        CONFIG.write_bytes(args.candidate.read_bytes())
        CONFIG.chmod(0o644)
        run('bash', '-n', str(CONFIG))
        expected = {'MacBook8,1': PXA, 'MacBook9,1': LPSS, 'MacBook10,1': LPSS}
        expected.update({f'MacBookPro{family},{variant}': LPSS
                         for family in (13, 14) for variant in (1, 2, 3)})
        expected.update({model: [] for model in ('MacBookAir6,2', 'MacBookAir7,2',
            'MacBookPro12,1', 'MacBookPro15,1', 'MacBookPro16,1', 'MacBookAir8,1',
            'MacBookPro13,4', 'MacBookPro14,10', 'MacBookPro18,1', 'Standard PC', '')})
        for model, modules in expected.items():
            fixture.write_text(model + '\n')
            selected = run('bash', '-c',
                'MODULES=(virtio_net); source "$1"; printf "%s\n" "${MODULES[@]}"',
                'apple-selection', str(CONFIG)).stdout.splitlines()
            assert selected == ['virtio_net'] + modules, (model, selected, modules)
            result['selection'][model or '<empty>'] = selected
        for model, modules in [('MacBook8,1', PXA), ('MacBookPro14,1', LPSS)]:
            fixture.write_text(model + '\n')
            name = model.replace(',', '-')
            result['images'][model] = image_record(folder, name,
                ['virtio_net'] + modules, APPLE_MODULES - set(modules))
        # Leave only the candidate on disk and generate the ordinary PC image
        # that the host will actually boot, without any fixture modules forced.
        FIXTURE_CONFIG.unlink()
        fixture.write_text(original_dmi)
        result['images']['generic'] = image_record(folder, 'generic', [], APPLE_MODULES)
        result['candidate_sha256'] = hashlib.sha256(CONFIG.read_bytes()).hexdigest()
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        raise
    finally:
        FIXTURE_CONFIG.unlink(missing_ok=True)
        run('umount', str(DMI))
        (folder / 'guest.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
