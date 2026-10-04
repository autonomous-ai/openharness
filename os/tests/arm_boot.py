#!/usr/bin/env python3
"""Boot the exact ARM runtime under a verified 16 KiB kernel on a private test disk.

This exports a disposable Ubuntu userspace, not a Harness release image. It does
not partition any host disk, prepare Apple firmware, or claim hardware support.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import struct
import subprocess
import tempfile
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def zboot_payload(data):
    # Linux v7.1 drivers/firmware/efi/libstub/zboot-header.S: offset/size at 8/12,
    # compression at 24, Linux PE magic at 56. The pinned package uses zstd.
    if len(data) < 64 or data[:8] != b'MZ\0\0zimg' or data[56:60] != b'\xcd\x23\x82\x81':
        raise ValueError('Not a Linux EFI zboot image')
    offset, size = struct.unpack_from('<II', data, 8)
    if offset < 64 or size == 0 or offset + size > len(data):
        raise ValueError('Invalid compressed kernel bounds')
    if data[24:32].split(b'\0', 1)[0] != b'zstd':
        raise ValueError('The locked kernel must use zstd')
    return data[offset:offset + size]


def check_arm_image(data):
    # Documentation/arch/arm64/booting.rst: Image flags bits 1..2 encode page size.
    if len(data) < 64 or data[56:60] != b'ARM\x64':
        raise ValueError('Not an ARM64 Linux Image')
    flags = struct.unpack_from('<Q', data, 24)[0]
    if flags & 1 or ((flags >> 1) & 3) != 2:
        raise ValueError('Expected a little-endian 16 KiB ARM64 Image')


def download(item, folder):
    path = folder / item['url'].rsplit('/', 1)[-1]
    with urlopen(item['url'], timeout=60) as response, path.open('xb') as output:
        written = 0
        while chunk := response.read(1024 * 1024):
            written += len(chunk)
            if written > item['bytes']:
                raise ValueError('Oversized input: ' + path.name)
            output.write(chunk)
    if path.stat().st_size != item['bytes'] or digest(path) != item['sha256']:
        raise ValueError('Input checksum mismatch: ' + path.name)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--agent', type=Path, required=True, help='npm prefix containing opencode-ai')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() != 'aarch64' or os.geteuid() == 0:
        parser.error('Use an ordinary user on a native aarch64 Linux test runner.')
    for name in ['docker', 'rpm', 'rpmkeys', 'gpg', 'bsdtar', 'zstd', 'mkfs.ext4',
                 'debugfs', 'qemu-system-aarch64', 'node', 'tmux', 'sudo']:
        if not shutil.which(name):
            parser.error('Missing test tool: ' + name)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    runtime, agent = args.runtime.resolve(), args.agent.resolve()
    lock = json.loads(Path(__file__).with_name('arm-boot.lock.json').read_text())
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=ROOT, text=True).strip():
        parser.error('Commit tracked source changes before running the boot acceptance.')
    info = json.loads((runtime / 'source.json').read_text())
    if info['source_commit'] != source or info['dirty'] or info['architecture'] != 'aarch64':
        parser.error('Use the exact clean ARM runtime from this checkout.')
    if set(info['files']) != {'harness-tui', 'cli.js', 'notify.mjs'}:
        parser.error('The runtime must contain the complete native payload.')
    for name, identity in info['files'].items():
        if (runtime / name).stat().st_size != identity['bytes'] or digest(runtime / name) != identity['sha256']:
            parser.error('Runtime identity mismatch: ' + name)
    work = Path(tempfile.mkdtemp(prefix='harness-arm-boot-', dir=os.environ.get('RUNNER_TEMP')))
    container = 'harness-arm-boot-' + work.name.rsplit('-', 1)[-1]
    process = None
    root = work / 'root'
    root.mkdir()
    log = (output / 'host.log').open('w')
    receipt = {'status': 'running', 'scope': '16 KiB kernel and userspace in QEMU; no board install or drivers',
               'source_commit': source, 'runtime': info, 'locked_inputs': lock,
               'started_at_unix': time.time()}

    def run(argv, timeout=120, capture=False, check=True):
        log.write('$ ' + repr([str(a) for a in argv]) + '\n')
        log.flush()
        result = subprocess.run([str(a) for a in argv], timeout=timeout, check=check,
                                stdout=subprocess.PIPE if capture else log,
                                stderr=subprocess.STDOUT if capture else log, text=True)
        if capture:
            log.write(result.stdout)
            log.flush()
            return result.stdout
        return result

    try:
        print('Verifying signed kernel inputs', flush=True)
        inputs = work / 'inputs'
        inputs.mkdir()
        with ThreadPoolExecutor(max_workers=3) as pool:
            paths = list(pool.map(lambda item: download(item, inputs),
                                  [*lock['kernel_packages'], lock['signing_key']]))
        packages, key = paths[:-1], paths[-1]
        gpg_home, rpmdb = work / 'gpg', work / 'rpmdb'
        gpg_home.mkdir(mode=0o700)
        rpmdb.mkdir()
        keys = run(['gpg', '--homedir', gpg_home, '--with-colons', '--show-keys', '--fingerprint', key], capture=True)
        fingerprints = [line.split(':')[9] for line in keys.splitlines() if line.startswith('fpr:')]
        if fingerprints != [lock['signing_key']['fingerprint']]:
            raise ValueError('Unexpected kernel signing key')
        run(['rpm', '--dbpath', rpmdb, '--initdb'])
        run(['rpm', '--dbpath', rpmdb, '--import', key])
        for package in packages:
            signatures = run(['rpmkeys', '--dbpath', rpmdb, '--checksig', '--verbose', package], capture=True)
            if not re.search(r'signature, key ID [0-9a-f]+: OK', signatures, re.I) or 'NOKEY' in signatures or 'NOT OK' in signatures:
                raise ValueError('Missing verified RPM signature')
        kernel = work / 'kernel'
        kernel.mkdir()
        for package in packages:
            run(['bsdtar', '--no-same-owner', '-xpf', package, '-C', kernel])
        module_dir = kernel / 'lib/modules' / lock['kernel_release']
        config = (module_dir / 'config').read_text()
        for required in ['ARM64_16K_PAGES', 'VIRTIO_BLK', 'VIRTIO_PCI', 'EXT4_FS',
                         'DEVTMPFS_MOUNT', 'SERIAL_AMBA_PL011', 'PCI_HOST_GENERIC']:
            if f'CONFIG_{required}=y\n' not in config:
                raise ValueError('Missing built-in boot requirement: ' + required)
        compressed = work / 'Image.zst'
        compressed.write_bytes(zboot_payload((module_dir / 'vmlinuz').read_bytes()))
        image = work / 'Image'
        run(['zstd', '-d', '--force', compressed, '-o', image])
        check_arm_image(image.read_bytes()[:64])
        shutil.copy2(module_dir / 'config', output / 'kernel.config')
        receipt['raw_kernel'] = {'sha256': digest(image), 'bytes': image.stat().st_size}
        print('Preparing the disposable userspace', flush=True)
        shutil.move(kernel / 'lib/modules', inputs / 'modules')
        (inputs / 'kernel-release').write_text(lock['kernel_release'] + '\n')
        (inputs / 'source-commit').write_text(source + '\n')
        shutil.copy2(shutil.which('node'), inputs / 'node')
        shutil.copy2(shutil.which('tmux'), inputs / 'tmux')
        payload = inputs / 'payload'
        shutil.copytree(runtime, payload / 'runtime')
        for relative in ['os/tests/runtime_native.py', 'os/tools/build-package.py',
                         'os/root/usr/share/harness-os/tmux.conf']:
            destination = payload / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, destination)
        shutil.copytree(agent, inputs / 'agent', symlinks=True)
        shutil.copy2(Path(__file__).with_name('arm_boot_guest.sh'), inputs / 'guest-init')
        shutil.copy2(Path(__file__).with_name('arm_boot_root.sh'), inputs / 'provision')
        receipt['fixture_files'] = {name: digest(inputs / name) for name in
                                    ['node', 'tmux', 'guest-init', 'provision', 'agent/package-lock.json']}
        run(['docker', 'run', '--name', container, '--platform', 'linux/arm64',
             '--mount', f'type=bind,source={inputs},target=/inputs,readonly',
             lock['root_image'], 'bash', '/inputs/provision'], timeout=1200)
        export = work / 'root.tar'
        run(['docker', 'export', '--output', export, container], timeout=180)
        run(['sudo', 'bsdtar', '-xpf', export, '-C', root], timeout=180)
        export.unlink()
        disk = work / 'guest.raw'
        with disk.open('xb') as handle:
            handle.truncate(8 * 1024 ** 3)
        run(['sudo', 'mkfs.ext4', '-F', '-q', '-d', root, disk], timeout=180)
        receipt['disk'] = {'virtual_bytes': disk.stat().st_size, 'allocated_bytes': disk.stat().st_blocks * 512}
        accelerator = 'kvm' if os.access('/dev/kvm', os.R_OK | os.W_OK) else 'tcg'
        # Keep the TCG instruction set stable across emulator versions.
        cpu = 'host' if accelerator == 'kvm' else 'cortex-a76'
        receipt['accelerator'] = accelerator
        receipt['cpu'] = cpu
        receipt['qemu_version'] = run(['qemu-system-aarch64', '--version'], capture=True).strip()
        print(f'Booting the 16 KiB kernel with {accelerator}', flush=True)
        serial = output / 'serial.log'
        boot_started = time.monotonic()
        with serial.open('wb') as handle:
            process = subprocess.Popen(['qemu-system-aarch64', '-machine', 'virt', '-accel', accelerator,
                '-cpu', cpu, '-smp', '2', '-m', '4096', '-nodefaults', '-display', 'none',
                '-serial', 'stdio', '-monitor', 'none', '-no-reboot', '-kernel', str(image),
                '-append', 'root=/dev/vda rw console=ttyAMA0 earlycon init=/sbin/harness-test-init net.ifnames=0 panic=1',
                '-drive', f'file={disk},format=raw,if=none,id=root', '-device', 'virtio-blk-pci,drive=root',
                '-netdev', 'user,id=net', '-device', 'virtio-net-pci,netdev=net,romfile='],
                stdin=subprocess.DEVNULL, stdout=handle, stderr=subprocess.STDOUT)
            while process.poll() is None:
                elapsed = time.monotonic() - boot_started
                if elapsed > 120 and 'HARNESS_ARM_KERNEL=' not in serial.read_text(errors='replace'):
                    raise TimeoutError('Guest did not reach the kernel/page-size assertion within 120 seconds; see serial.log')
                if elapsed > 1200:
                    raise TimeoutError('Guest runtime acceptance exceeded 1200 seconds; see serial.log')
                time.sleep(1)
        receipt['vm_elapsed_seconds'] = time.monotonic() - boot_started
        receipt['qemu_exit'] = process.returncode
        run(['debugfs', '-R', f'rdump /results {output}', disk], timeout=90)
        if process.returncode != 0:
            raise ValueError('QEMU did not shut down successfully; see serial.log')
        guest = output / 'results'
        boot = json.loads((guest / 'boot.json').read_text())
        native = json.loads((guest / 'native-runtime/receipt.json').read_text())
        if boot['page_size'] != 16384 or native['page_size'] != 16384 or native['status'] != 'passed':
            raise ValueError('The 16 KiB guest runtime acceptance did not pass')
        if native['runtime'] != info or native['kernel'] != lock['kernel_release']:
            raise ValueError('The guest did not run the expected runtime/kernel')
        if not re.search(r'^HARNESS_ARM_BOOT_EXIT=0\r?$', serial.read_text(), re.M):
            raise ValueError('The guest did not report successful completion')
        receipt.update(status='passed', boot=boot, native_receipt_sha256=digest(guest / 'native-runtime/receipt.json'))
        print('16 KiB kernel, real panes, default agent and surviving work passed', flush=True)
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        raise
    finally:
        cleanup_errors = []
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        # Recover guest diagnostics after a failed or timed-out boot as well.
        disk = work / 'guest.raw'
        if disk.exists() and not (output / 'results').exists():
            try:
                run(['debugfs', '-R', f'rdump /results {output}', disk], timeout=90, check=False)
            except (OSError, subprocess.SubprocessError) as error:
                cleanup_errors.append('Guest evidence: ' + str(error))
        try:
            run(['docker', 'rm', '--force', container], check=False)
            run(['sudo', 'rm', '-rf', '--', root], timeout=90)
            shutil.rmtree(work)
        except (OSError, subprocess.SubprocessError) as error:
            cleanup_errors.append('Fixture cleanup: ' + str(error))
        receipt['finished_at_unix'] = time.time()
        if cleanup_errors:
            receipt.update(status='failed', cleanup_errors=cleanup_errors)
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        log.close()
        if cleanup_errors:
            raise RuntimeError('; '.join(cleanup_errors))


if __name__ == '__main__':
    main()
