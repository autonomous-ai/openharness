#!/usr/bin/env python3
"""Try the real installer and installed OS in a persistent, isolated QEMU window."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import tempfile


def arguments(argv=None):
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, help='ISO with its manifest.json beside it')
    parser.add_argument('--installed', action='store_true', help='Boot the virtual disk without the ISO')
    parser.add_argument('--directory', type=Path, default=root / 'work' / 'interactive-vm')
    parser.add_argument('--memory', type=int, default=2048, help='Guest RAM in MiB')
    parser.add_argument('--firmware', choices=['uefi', 'bios'], default='uefi')
    parser.add_argument('--headless', action='store_true', help='Use QMP/serial sockets without opening a window')
    parser.add_argument('--vnc-port', type=int, help='Serve the VM display on localhost TCP port 5900–65535; implies headless')
    parser.add_argument('--ssh-port', type=int, help='Forward localhost TCP port 1024–65535 to guest SSH; does not enable sshd')
    parser.add_argument('--remote-host', help='Print an SSH tunnel command for this server (user@host or an SSH config alias)')
    parser.add_argument('--require-acceleration', action='store_true', help='Stop instead of falling back to software emulation')
    args = parser.parse_args(argv)
    if args.memory < 1024:
        parser.error('Use at least 1024 MiB for this development image.')
    if args.vnc_port is not None and not 5900 <= args.vnc_port <= 65535:
        parser.error('--vnc-port must be between 5900 and 65535.')
    if args.ssh_port is not None and not 1024 <= args.ssh_port <= 65535:
        parser.error('--ssh-port must be between 1024 and 65535.')
    if args.vnc_port is not None and args.vnc_port == args.ssh_port:
        parser.error('Use different display and guest SSH ports.')
    if args.remote_host:
        if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.@:-]*', args.remote_host):
            parser.error('--remote-host must be a user@host or SSH config alias.')
        if args.vnc_port is None and args.ssh_port is None:
            parser.error('--remote-host needs --vnc-port or --ssh-port.')
    return parser, args


def acceleration():
    mac = platform.system() == 'Darwin'
    native_x86 = platform.machine().lower() in ['x86_64', 'amd64']
    return 'hvf' if mac and native_x86 else 'kvm' if native_x86 and os.access('/dev/kvm', os.R_OK | os.W_OK) else 'tcg'


def remote_options(args):
    network = 'user,id=net'
    if args.ssh_port is not None:
        network += f',hostfwd=tcp:127.0.0.1:{args.ssh_port}-:22'
    options = ['-netdev', network]
    if args.vnc_port is not None:
        options += ['-vnc', f'127.0.0.1:{args.vnc_port - 5900}']
    return options


def connection_help(args):
    lines = []
    if args.remote_host:
        tunnel = ['ssh', '-N', '-o', 'ExitOnForwardFailure=yes']
        for port in [args.vnc_port, args.ssh_port]:
            if port is not None:
                tunnel += ['-L', f'127.0.0.1:{port}:127.0.0.1:{port}']
        tunnel += [args.remote_host]
        lines += ['On your Mac, keep this tunnel running:', shlex.join(tunnel)]
    if args.vnc_port is not None:
        lines += [f'Display: vnc://127.0.0.1:{args.vnc_port}',
                  f'On macOS: open vnc://127.0.0.1:{args.vnc_port}']
    if args.ssh_port is not None:
        lines += [f'Guest SSH: ssh -p {args.ssh_port} me@127.0.0.1',
                  'Guest SSH requires sshd and your login/key setup inside the VM.']
    return lines


def main(argv=None):
    root = Path(__file__).resolve().parents[1]
    parser, args = arguments(argv)
    qemu = shutil.which('qemu-system-x86_64')
    image_tool = shutil.which('qemu-img')
    if not qemu or not image_tool:
        parser.error('Install QEMU first: brew install qemu (macOS), or qemu-system-x86 and qemu-utils (Debian/Ubuntu).')
    accel = acceleration()
    if args.require_acceleration and accel == 'tcg':
        parser.error('Hardware acceleration is unavailable. Use an x86 Linux host with /dev/kvm access or an Intel Mac. This x86 image requires software emulation on Apple Silicon.')
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
    display = 'none' if args.headless or args.vnc_port is not None else 'cocoa,left-command-key=on' if mac else 'gtk'
    # QEMU key/value arguments escape literal commas by doubling them.
    path_arg = lambda path: str(path).replace(',', ',,')
    with tempfile.TemporaryDirectory(prefix='hn-os-', dir='/tmp') as control:
        control = Path(control)
        command = [qemu, '-name', 'Harness', '-accel', accel,
                   '-cpu', 'max' if accel == 'tcg' else 'host', '-m', str(args.memory), '-smp', '2',
                   '-device', 'virtio-vga', '-display', display,
                   '-drive', f'file={path_arg(disk)},format=qcow2,if=none,id=target',
                   '-device', f'virtio-blk-pci,drive=target,serial=HN_OS_VM,bootindex={1 if args.installed else 2}',
                   '-device', 'virtio-net-pci,netdev=net', *remote_options(args),
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
                 'serial_socket': str(control / 'serial.sock'), 'qmp_socket': str(control / 'qmp.sock'),
                 'vnc_address': f'127.0.0.1:{args.vnc_port}' if args.vnc_port is not None else None,
                 'guest_ssh_address': f'127.0.0.1:{args.ssh_port}' if args.ssh_port is not None else None}
        (folder / 'running.json').write_text(json.dumps(state, indent=2) + '\n')
        print(f'Virtual disk: {disk} ({info["virtual-size"] / 1024 ** 3:g} GiB capacity; grows only as used)', flush=True)
        print(f'Guest: {args.memory} MiB RAM, 2 CPUs, {accel}; control: {control}', flush=True)
        if not args.installed:
            print('The USB opens the installer. Install to the virtual disk (/dev/vda).', flush=True)
        reboot = ['python3', 'os/tools/run-vm.py', '--installed', '--directory', str(folder),
                  '--firmware', args.firmware, '--memory', str(args.memory)]
        for flag, value in [('--vnc-port', args.vnc_port), ('--ssh-port', args.ssh_port), ('--remote-host', args.remote_host)]:
            if value is not None:
                reboot += [flag, str(value)]
        if args.headless:
            reboot += ['--headless']
        if args.require_acceleration:
            reboot += ['--require-acceleration']
        print('After shutdown: ' + shlex.join(reboot), flush=True)
        for line in connection_help(args):
            print(line, flush=True)
        try:
            with (folder / 'qemu.log').open('ab') as log:
                result = subprocess.run(command, stderr=log)
            if result.returncode:
                raise SystemExit(f'QEMU exited with {result.returncode}; see {folder / "qemu.log"}')
        finally:
            (folder / 'running.json').unlink(missing_ok=True)


if __name__ == '__main__':
    main()
