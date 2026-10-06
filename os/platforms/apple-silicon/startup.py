"""Private Asahi boot/account enrollment after a completed encrypted image copy.

This is an installer stage, not a runnable whole-disk installer. It owns only the
persisted target's Linux filesystems and new EFI files. Apple boot policy, m1n1,
vendor firmware, other operating systems and the frozen session RPM stay intact.
"""
from contextlib import contextmanager, ExitStack
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import tempfile

spec = importlib.util.spec_from_file_location('asahi_storage', Path(__file__).with_name('storage.py'))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)
target = storage.target
run = storage.run
Error = storage.StorageError
PHASES = ('planned', 'boot', 'account', 'complete')

# Run from stdin inside the installed root with its own /run. Reuse the frozen
# image's provisioning and rollback implementation; do not replace package files
# or talk to the installer's service manager. All other preflight checks remain.
ACCOUNT = r'''
import os, pathlib, sys
if os.geteuid() != 0 or os.path.samefile('/', '/proc/1/root') or pathlib.Path('/run/systemd/system').exists():
    raise RuntimeError('Account enrollment requires the isolated offline target.')
sys.path.insert(0, '/usr/lib/harness-os')
import firstboot
class OfflineFirstBoot(firstboot.FirstBoot):
    def run(self, *command, check=True):
        if command[:2] == ('/usr/bin/systemctl', 'is-active'):
            if len(command) != 3 or command[2] not in ('greetd.service', 'display-manager.service'):
                raise RuntimeError('Unexpected offline activity query.')
            return 'inactive'  # No target services can run in this offline chroot.
        return super().run(*command, check=check)
setup = OfflineFirstBoot()
password = sys.stdin.read() if sys.argv[1] != 'verify' else None
with setup.locked():
    if sys.argv[1] == 'verify':
        state = setup.read_state()
        if not state or state['phase'] != 'complete':
            raise RuntimeError('The installation account is incomplete.')
        setup.identity(state)
        previous = setup.load()
        if not previous or previous['phase'] != 'enabled' or previous['user'] != 'me' or previous['uid'] != 1000:
            raise RuntimeError('Keep the changed login configuration.')
        setup.verify(previous)
        setup.account('me')
        if setup.path(firstboot.DONE).read_text() != 'me@harness\n':
            raise RuntimeError('The completed account record has changed.')
    else:
        state = setup.prepare()
        if state['phase'] == 'account':
            setup.provision(state, password)
        setup.finish(state)
    password = None
'''


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def checked(root, name):
    relative = Path(name)
    if relative.is_absolute() or not relative.parts or any(p in ('.', '..') for p in relative.parts):
        raise Error('Invalid installation file path.')
    path = root / relative
    for parent in [path, *path.parents]:
        if parent == root:
            break
        if parent.is_symlink():
            raise Error('An installation path was redirected: ' + name)
    return path


def snapshot(root, name):
    path = checked(root, name)
    if not path.exists():
        return None
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0:
        raise Error('An installation file has a different type or owner: ' + name)
    return digest(path)


def atomic(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.harness-boot-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def configuration(payload, state, esp_uuid):
    """Replace source disk identities, preserving the image's other kernel options."""
    for key in ('root_uuid', 'boot_uuid', 'luks_uuid'):
        target.identifier(state[key])
    target.identifier(esp_uuid)
    cmdline = (payload.root / 'etc/kernel/cmdline').read_text().split()
    if not any(arg.startswith('root=UUID=') for arg in cmdline):
        raise Error('The image kernel command line has changed.')
    options = list(dict.fromkeys(arg for arg in cmdline if not arg.startswith(('root=', 'rd.luks.'))))
    options += ['root=UUID=' + state['root_uuid'], 'rd.luks.name=' + state['luks_uuid'] + '=harness-root']
    if 'rootflags=subvol=root' not in options:
        raise Error('The image no longer uses the expected root subvolume.')
    grub = (payload.root / 'etc/default/grub').read_text()
    grub, count = re.subn(r'(?m)^GRUB_CMDLINE_LINUX_DEFAULT="[^"]*"$',
                         'GRUB_CMDLINE_LINUX_DEFAULT="' + ' '.join(options) + '"', grub)
    if count != 1:
        raise Error('The image GRUB defaults have changed.')
    return {
        'etc/fstab': (f'UUID={state["root_uuid"]} / btrfs compress=zstd:1,subvol=root 0 0\n'
                      f'UUID={state["root_uuid"]} /home btrfs compress=zstd:1,subvol=home 0 0\n'
                      f'UUID={state["boot_uuid"]} /boot ext4 defaults 0 2\n'
                      f'PARTUUID={esp_uuid} /boot/efi vfat umask=0077,shortname=winnt 0 2\n'),
        'etc/crypttab': f'harness-root UUID={state["luks_uuid"]} none luks,x-initrd.attach\n',
        'etc/kernel/cmdline': ' '.join(options) + '\n',
        'etc/default/grub': grub,
        'etc/dracut.conf.d/20-harness-crypt.conf': 'add_dracutmodules+=" crypt "\n',
    }


def efi_files(payload, state):
    files = {}
    for prefix in ('EFI/BOOT', 'EFI/fedora'):
        for path in (payload.esp / prefix).iterdir():
            if not path.is_file() or path.is_symlink():
                raise Error('Unexpected source EFI content.')
            if path.name == 'bootx64.efi':
                continue
            name = str(path.relative_to(payload.esp))
            data = path.read_bytes()
            if path.name == 'grub.cfg':
                data = (f'search --fs-uuid --set=root {state["boot_uuid"]}\n'
                        'set prefix=($root)/grub2\nconfigfile ($root)/grub2/grub.cfg\n').encode()
            files[name] = data
    if not {'EFI/BOOT/BOOTAA64.EFI', 'EFI/BOOT/grubaa64.efi', 'EFI/fedora/grub.cfg'} <= files.keys():
        raise Error('The source image is missing its ARM EFI loader.')
    return files


def record(path, identity):
    if not os.path.lexists(path):
        return {**identity, 'phase': 'planned', 'boot_files': {}}
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        target.private_file(stream.fileno())
        state = json.loads(stream.read(128 * 1024))
    if (set(state) != {*identity, 'phase', 'boot_files'} or
            any(state.get(k) != v for k, v in identity.items()) or state['phase'] not in PHASES or
            not isinstance(state['boot_files'], dict) or
            any(not re.fullmatch(r'[a-f0-9]{64}', str(v)) for v in state['boot_files'].values()) or
            (state['phase'] != 'planned' and not state['boot_files'])):
        raise Error('The startup receipt belongs to a different installation.')
    return state


@contextmanager
def mount_at(device, path, options, filesystem=None):
    if path.is_symlink() or not path.is_dir() or os.path.ismount(path):
        raise Error('The target mount point has changed.')
    try:
        run('mount', *(['-t', filesystem] if filesystem else []), '-o', options, device, path)
        yield path
    finally:
        if os.path.ismount(path):
            run('umount', '-R', path)


@contextmanager
def offline(root):
    """Private /run prevents systemctl, D-Bus and password tools reaching the host."""
    with ExitStack() as mounts:
        mounts.enter_context(mount_at('proc', root / 'proc', 'nosuid,nodev,noexec', 'proc'))
        mounts.enter_context(mount_at('sysfs', root / 'sys', 'ro,nosuid,nodev,noexec', 'sysfs'))
        # --rbind is needed for /dev/pts. The outer private namespace prevents
        # propagation into installer services; recursive unmount releases it.
        dev = root / 'dev'
        if dev.is_symlink() or not dev.is_dir() or os.path.ismount(dev):
            raise Error('The target device mount point has changed.')
        run('mount', '--rbind', '/dev', dev)
        mounts.callback(run, 'umount', '-R', dev)
        run('mount', '--make-rslave', dev)
        mounts.enter_context(mount_at('tmpfs', root / 'run', 'mode=0755,nosuid,nodev', 'tmpfs'))
        yield


def check_configs(root, payload, configs):
    for name, content in configs.items():
        wanted = hashlib.sha256(content.encode()).hexdigest()
        if snapshot(root, name) not in (snapshot(payload.root, name), wanted):
            raise Error('Keep the modified installation configuration: ' + name)


def verify_runtime(root, payload):
    manifest = 'usr/share/harness-os/image.json'
    image = json.loads(checked(payload.root, manifest).read_text())
    if snapshot(root, manifest) != snapshot(payload.root, manifest):
        raise Error('The installed image identity changed.')
    files = {**image['session_package']['files'],
             **{k: v['sha256'] for k, v in image['first_boot']['files'].items()}}
    for name, expected in files.items():
        if snapshot(root, name) != expected:
            raise Error('A frozen runtime file changed: ' + name)


def label_files(root, *paths):
    # restorecon can silently do nothing when the installer kernel has SELinux
    # disabled. setfiles explicitly labels an offline filesystem with the
    # installed policy, regardless of the installer's enforcement mode.
    run('chroot', root, '/usr/sbin/setfiles', '-F', '-e', '/boot/efi',
        '/etc/selinux/targeted/contexts/files/file_contexts', *paths, timeout=90)


def build_boot(root, configs):
    for name, content in configs.items():
        atomic(checked(root, name), content.encode(), 0o600 if name == 'etc/crypttab' else 0o644)
    label_files(root, *('/' + name for name in configs))
    run('chroot', root, 'grubby', '--update-kernel=ALL', '--remove-args=root rd.luks.uuid rd.luks.name',
        '--args=' + configs['etc/kernel/cmdline'].strip())
    run('chroot', root, 'grub2-mkconfig', '-o', '/boot/grub2/grub.cfg')
    kernels = [p.name for p in (root / 'usr/lib/modules').iterdir() if p.is_dir() and (p / 'vmlinuz').is_file()]
    if len(kernels) != 1 or not kernels[0].endswith('+16k'):
        raise Error('Use the verified image with one Asahi 16 KiB kernel.')
    initrd = '/boot/initramfs-' + kernels[0] + '.img'
    run('chroot', root, 'dracut', '--force', '--no-hostonly', initrd, kernels[0], timeout=180)
    modules = run('chroot', root, 'lsinitrd', '-m', initrd)
    if 'crypt' not in modules or 'kernel-modules-asahi' not in modules:
        raise Error('The boot image is missing encryption or Apple drivers.')
    names = [*configs, 'boot/grub2/grub.cfg', initrd.lstrip('/')]
    entries = sorted((root / 'boot/loader/entries').glob('*.conf'))
    if not entries or any(not set(configs['etc/kernel/cmdline'].split()) <= set(
            next((line.removeprefix('options ') for line in p.read_text().splitlines()
                  if line.startswith('options ')), '').split()) for p in entries):
        raise Error('The kernel boot entries do not select the installed root.')
    names += [str(p.relative_to(root)) for p in entries]
    label_files(root, '/boot')
    run('sync', '-f', root / 'boot')
    run('sync', '-f', root)
    return {name: snapshot(root, name) for name in names}


def finish(plan_path, payload, password, *, progress=None):
    """Complete an owned copy; retry without resetting an account or user work."""
    if not isinstance(password, str) or not password or any(c in password for c in '\n\r\0'):
        raise Error('Enter an installation password without line breaks.')
    path = Path(plan_path)
    progress = progress or (lambda phase: None)
    with payload.open(), target.locked_plan(path) as (plan, fd):
        saved = storage.read_state(path.with_name('storage.json'), plan, payload.sha256, payload.source_commit)
        if not saved or saved['phase'] != 'copied':
            raise Error('Complete the verified system copy before preparing startup.')
        state_path = path.with_name('startup.json')
        identity = {'schema': 1, 'kind': 'harness-asahi-startup', 'storage_sha256': storage.fingerprint(saved)}
        state = record(state_path, identity)
        boot_part, root_part = plan['additions']
        storage.require_filesystem(storage.probe(root_part['node']), 'crypto_LUKS', saved['luks_uuid'])
        storage.require_filesystem(storage.probe(boot_part['node']), 'ext4', saved['boot_uuid'])
        esp = Path(run('findmnt', '-nro', 'TARGET', '--target', path))
        files = efi_files(payload, saved)
        for name, data in files.items():
            allowed = [hashlib.sha256(data).hexdigest()]
            if state['phase'] != 'complete':
                allowed.append(None)
            if snapshot(esp, name) not in allowed:
                raise Error('Keep the existing EFI loader: ' + name)
        configs = configuration(payload, saved, plan['esp_uuid'])
        with storage.encrypted_root(root_part['node'], saved, password.encode()) as device:
            storage.require_filesystem(storage.probe(device), 'btrfs', saved['root_uuid'])
            with storage.work_directory() as work, ExitStack() as mounts:
                root = mounts.enter_context(storage.mounted(device, work / 'root', 'subvol=root'))
                mounts.enter_context(mount_at(device, checked(root, 'home'), 'subvol=home'))
                mounts.enter_context(mount_at(boot_part['node'], checked(root, 'boot'), 'defaults'))
                mounts.enter_context(mount_at(esp, checked(root, 'boot/efi'), 'bind'))
                verify_runtime(root, payload)
                if state['phase'] == 'planned':
                    # No existing human account is allowed before this transaction
                    # has durably finished boot configuration.
                    if (root / 'var/lib/harness-os/firstboot.json').exists() or any(
                            1000 <= int(row.split(':')[2]) < 65534 for row in (root / 'etc/passwd').read_text().splitlines()):
                        raise Error('Keep the existing account; boot preparation was not recorded.')
                    check_configs(root, payload, configs)
                    storage.save_state(state_path, state)
                    with offline(root):
                        state['boot_files'] = build_boot(root, configs)
                    state['phase'] = 'boot'
                    storage.save_state(state_path, state)
                    progress('boot')
                for name, expected in state['boot_files'].items():
                    if snapshot(root, name) != expected:
                        raise Error('Keep the changed boot configuration: ' + name)
                if state['phase'] == 'boot':
                    with offline(root):
                        run('chroot', root, '/usr/bin/python3', '-c', ACCOUNT, 'configure', secret=password.encode(), timeout=90)
                        label_files(root, '/etc', '/var/lib/harness-os', '/home')
                        run('chroot', root, '/usr/sbin/matchpathcon', '-V', '/etc/passwd', '/etc/shadow',
                            '/etc/group', '/etc/gshadow', '/etc/greetd/harness.toml', '/home', '/home/me')
                    run('sync', '-f', root)
                    state['phase'] = 'account'
                    storage.save_state(state_path, state)
                    progress('account')
                with offline(root):
                    run('chroot', root, '/usr/bin/python3', '-c', ACCOUNT, 'verify', timeout=60)
                if state['phase'] == 'account':
                    # Publish the fallback entry last. Existing m1n1, vendor
                    # firmware and Apple-owned partitions are never copied over.
                    for name in sorted(files, key=lambda n: (n == 'EFI/BOOT/BOOTAA64.EFI', n)):
                        if snapshot(esp, name) != hashlib.sha256(files[name]).hexdigest():
                            atomic(checked(esp, name), files[name], mode=0o600)
                    run('sync', '-f', esp)
                    state['phase'] = 'complete'
                    storage.save_state(state_path, state)
                    progress('complete')
                verify_runtime(root, payload)
                target.verify_gpt(fd, int(run('blockdev', '--getsize64', plan['original']['device'])),
                                  target.normalize(target.read_table(plan['original']['device'])))
        return state
