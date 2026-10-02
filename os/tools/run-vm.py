#!/usr/bin/env python3
"""Try the real installer and installed OS in a persistent, isolated QEMU window."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, help='ISO with its manifest.json beside it')
    parser.add_argument('--installed', action='store_true', help='Boot the virtual disk without the ISO')
    parser.add_argument('--directory', type=Path, default=root / 'work' / 'interactive-vm')
    parser.add_argument('--memory', type=int, default=2048, help='Guest RAM in MiB')
    parser.add_argument('--firmware', choices=['uefi', 'bios'], default='uefi')
    parser.add_argument('--headless', action='store_true', help='Use QMP/serial sockets without opening a window')
    args = parser.parse_args()
    if args.memory < 1024:
        parser.error('Use at least 1024 MiB for this development image.')
    qemu = shutil.which('qemu-system-x86_64')
    image_tool = shutil.which('qemu-img')
    if not qemu or not image_tool:
        parser.error('Install QEMU first: brew install qemu (macOS).')
    iso = None
    if not args.installed:
        candidates = list((root / 'dist').glob('*.iso'))
        iso = (args.iso or (candidates[0] if len(candidates) == 1 else Path('missing.iso'))).resolve()
        if not iso.is_file():
            parser.error('Provide --iso PATH, or put one ISO and its manifest in os/dist/.')
        manifest = json.loads((iso.parent / 'manifest.json').read_text())
        with iso.open('rb') as handle:
            digest = hashlib.file_digest(handle, 'sha256').hexdigest()
        if iso.stat().st_size != manifest['iso']['bytes'] or digest != manifest['iso']['sha256']:
            parser.error('ISO does not match its manifest.')
    folder = args.directory.resolve()
    folder.mkdir(parents=True, exist_ok=True)
    # Keep one QEMU process per virtual disk. Never accept a host block device.
    lock = (folder / 'vm.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        parser.error('This VM is already running.')
    disk = folder / 'disk.qcow2'
    if disk.is_symlink() or (disk.exists() and not disk.is_file()):
        parser.error('The virtual disk must be a regular file, not a symlink or device.')
    if not disk.exists():
        if args.installed:
            parser.error('Install to the VM disk from the ISO first.')
        if shutil.disk_usage(folder).free < 6 * 1024 ** 3:
            parser.error('Keep at least 6 GiB free before creating an installation VM.')
        subprocess.run([image_tool, 'create', '-f', 'qcow2', str(disk), '24G'], check=True)
    info = json.loads(subprocess.check_output([image_tool, 'info', '--output=json', str(disk)], text=True))
    if info['format'] != 'qcow2' or info.get('backing-filename'):
        parser.error('Expected a standalone qcow2 disk without a backing file.')
    mac = platform.system() == 'Darwin'
    native_x86 = platform.machine().lower() in ['x86_64', 'amd64']
    accel = 'hvf' if mac and native_x86 else 'kvm' if native_x86 and os.access('/dev/kvm', os.R_OK | os.W_OK) else 'tcg'
    display = 'none' if args.headless else 'cocoa,left-command-key=on' if mac else 'gtk'
    # QEMU key/value arguments escape literal commas by doubling them.
    path_arg = lambda path: str(path).replace(',', ',,')
    with tempfile.TemporaryDirectory(prefix='hn-os-', dir='/tmp') as control:
        control = Path(control)
        command = [qemu, '-name', 'Programmer OS', '-accel', accel,
                   '-cpu', 'max' if accel == 'tcg' else 'host', '-m', str(args.memory), '-smp', '2',
                   '-device', 'virtio-vga', '-display', display,
                   '-drive', f'file={path_arg(disk)},format=qcow2,if=none,id=target',
                   '-device', f'virtio-blk-pci,drive=target,serial=HN_OS_VM,bootindex={1 if args.installed else 2}',
                   '-device', 'virtio-net-pci,netdev=net', '-netdev', 'user,id=net',
                   '-serial', f'unix:{control / "serial.sock"},server=on,wait=off',
                   '-qmp', f'unix:{control / "qmp.sock"},server=on,wait=off']
        if iso:
            command += ['-drive', f'file={path_arg(iso)},format=raw,media=cdrom,if=none,id=live',
                        '-device', 'ide-cd,drive=live,bootindex=1']
        if args.firmware == 'uefi':
            share = Path(qemu).resolve().parents[1] / 'share' / 'qemu'
            options = [(share / 'edk2-x86_64-code.fd', share / 'edk2-i386-vars.fd'),
                       (Path('/usr/share/OVMF/OVMF_CODE_4M.fd'), Path('/usr/share/OVMF/OVMF_VARS_4M.fd'))]
            firmware = next(((code, template) for code, template in options if code.is_file() and template.is_file()), None)
            if not firmware:
                parser.error('UEFI firmware not found. Install OVMF, or use --firmware bios.')
            code, template = firmware
            variables = folder / 'uefi-vars.fd'
            if not variables.exists():
                shutil.copyfile(template, variables)
            command += ['-drive', f'if=pflash,format=raw,readonly=on,file={path_arg(code)}',
                        '-drive', f'if=pflash,format=raw,file={path_arg(variables)}']
        state = {'disk': str(disk), 'iso': str(iso) if iso else None, 'acceleration': accel,
                 'serial_socket': str(control / 'serial.sock'), 'qmp_socket': str(control / 'qmp.sock')}
        (folder / 'running.json').write_text(json.dumps(state, indent=2) + '\n')
        print(f'Virtual disk: {disk} (24 GiB capacity; grows only as used)', flush=True)
        print(f'Guest: {args.memory} MiB RAM, 2 CPUs, {accel}; control: {control}', flush=True)
        print('Install inside hn with: sudo hn-os install (choose /dev/vda).', flush=True)
        print('After shutdown: python3 os/tools/run-vm.py --installed', flush=True)
        try:
            with (folder / 'qemu.log').open('ab') as log:
                result = subprocess.run(command, stderr=log)
            if result.returncode:
                raise SystemExit(f'QEMU exited with {result.returncode}; see {folder / "qemu.log"}')
        finally:
            (folder / 'running.json').unlink(missing_ok=True)


if __name__ == '__main__':
    main()
