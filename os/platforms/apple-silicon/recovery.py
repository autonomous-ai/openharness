#!/usr/bin/python3
"""Private, cold Fedora/Asahi checkpoints and restartable offline recovery.

Run from independent maintenance Linux, in a private mount namespace. The ESP
contains the completed installer receipts; the LUKS device is already unlocked.
This module is deliberately not installed or connected to the session updater.
"""
from contextlib import contextmanager
import argparse
import base64
import configparser
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import uuid

spec = importlib.util.spec_from_file_location('recovery_storage', Path(__file__).with_name('storage.py'))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)
target = storage.target
Error = storage.StorageError
STORE = '.harness-recovery'
SEPARATE = ('boot', 'home', 'dev', 'proc', 'sys', 'run')
PAIRED = ('var/lib/selinux', 'var/lib/alternatives',
          'var/lib/harness-os/session-setup.json', 'var/lib/harness-os/firstboot.json',
          'var/lib/harness-os/firstboot.done')
DNF_STATE = 'usr/lib/sysimage/libdnf5/offline'
DNF_DATA = 'var/lib/dnf/offline'
EFI_TREES = ('EFI/BOOT', 'EFI/fedora')
EFI_FILES = ('m1n1/boot.bin', 'm1n1/boot.bin.old', 'm1n1/boot.bin.new')
PHASES = ('planned', 'evidence', 'candidate', 'boot', 'efi', 'root-moved', 'complete')
TOOLS = {name: '/usr/bin/' + name for name in ('btrfs', 'findmnt', 'mount', 'umount', 'lsblk', 'rsync', 'sync')}
TOOLS.update({name: '/usr/sbin/' + name for name in ('blkid', 'blockdev', 'cryptsetup', 'sfdisk')})
ENV = {'PATH': '/usr/sbin:/usr/bin', 'LC_ALL': 'C'}


def run(*args, timeout=900):
    """Only fixed maintenance tools; never inherit root's caller-controlled PATH."""
    command = [TOOLS[args[0]], *map(str, args[1:])]
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, timeout=timeout, env=ENV)
    if result.returncode:
        raise Error(f'{args[0]} failed ({result.returncode}): {result.stderr.strip()[-1000:]}')
    return result.stdout.strip()


target.command = run


def checked(root, name, *, parents_only=False):
    """Resolve no links in any path used for an archive or a privileged write."""
    relative = Path(name)
    if relative.is_absolute() or not relative.parts or any(p in ('.', '..') for p in relative.parts):
        raise Error('Invalid recovery path.')
    path = root / relative
    parts = relative.parts[:-1] if parents_only else relative.parts
    current = root
    for part in parts:
        current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            break
        if stat.S_ISLNK(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise Error('Recovery path is redirected or not securely owned: ' + str(current))
    return path


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        target.private_file(fd)
        with os.fdopen(fd) as stream:
            fd = None
            return json.load(stream)
    finally:
        if fd is not None:
            os.close(fd)


def text_file(root, name):
    """Read only a bounded regular configuration file, never a FIFO/device."""
    path = checked(root, name)
    if not stat.S_ISREG(path.lstat().st_mode):
        raise Error('The recovery configuration is not a regular file: ' + name)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 2 * 1024**2:
            raise Error('The recovery configuration is not a bounded regular file: ' + name)
        return stream.read()


def save(path, value):
    storage.save_state(path, value)


def sync(path):
    run('sync', '-f', path)


def generation(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{32}', value):
        raise Error('Use the exact checkpoint identifier.')
    return value


def under(name, prefixes):
    return any(name == prefix or name.startswith(prefix + '/') for prefix in prefixes)


def efi_owned(name):
    return under(name, EFI_TREES) or name in EFI_FILES


def efi_protected(name):
    # Structural parents can be created when restoring owned children. Every
    # other child is inventoried independently; no unowned file may change.
    return name not in ('EFI', 'm1n1') and not efi_owned(name)


def attributes(path):
    return {key: base64.b64encode(os.getxattr(path, key, follow_symlinks=False)).decode()
            for key in sorted(os.listxattr(path, follow_symlinks=False))}


def inventory(root, *, exclude=(), include=None, metadata=True):
    """A stable content/metadata digest, including hardlink relationships.

    Never follow a symlink or cross a mount/subvolume. Root workload hardlinks
    crossing the restore boundary are checked separately before any mutation.
    """
    digest = hashlib.sha256()
    links = {}
    device = root.stat().st_dev

    def walk(directory):
        for path in sorted(directory.iterdir()):
            name = str(path.relative_to(root))
            if under(name, exclude):
                continue
            info = path.lstat()
            if info.st_dev != device:
                raise Error('Unhandled mount or subvolume: ' + str(path))
            if include is None or include(name):
                row = [name, stat.S_IFMT(info.st_mode)]
                if metadata:
                    # Restoring an excluded sibling may change a directory's
                    # mtime; that is not a change to the preserved workload.
                    row += [stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid,
                            None if stat.S_ISDIR(info.st_mode) else info.st_mtime_ns, attributes(path)]
                if stat.S_ISREG(info.st_mode):
                    key = (info.st_dev, info.st_ino)
                    previous = links.setdefault(key, name)
                    with path.open('rb') as stream:
                        content = hashlib.file_digest(stream, 'sha256').hexdigest()
                    row += [info.st_size, content, previous]
                elif stat.S_ISLNK(info.st_mode):
                    row += [os.readlink(path)]
                elif not stat.S_ISDIR(info.st_mode):
                    row += [info.st_rdev]
                digest.update(json.dumps(row, sort_keys=True, separators=(',', ':')).encode() + b'\n')
            if stat.S_ISDIR(info.st_mode):
                walk(path)
    walk(root)
    return digest.hexdigest()


def system_digest(root):
    # /var is retained except the explicitly paired package state. Offline DNF
    # state and its trigger are deliberately absent from a recovered generation.
    return inventory(root, exclude=(*SEPARATE, DNF_STATE, DNF_DATA, 'system-update'),
                     include=lambda name: not under(name, ('var',)) or under(name, PAIRED))


def work_digest(root):
    return inventory(root / 'var', exclude=tuple(name.removeprefix('var/') for name in (*PAIRED, DNF_DATA)))


def boundary(root):
    for name in (*SEPARATE, 'var', 'var/lib', *PAIRED):
        checked(root, name)
    links = {}
    device = root.stat().st_dev
    for directory, directories, files in os.walk(root, followlinks=False):
        for name in [*directories, *files]:
            path = Path(directory) / name
            info = path.lstat()
            if info.st_dev != device:
                raise Error('Unhandled mount or subvolume: ' + str(path))
            if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                relative = str(path.relative_to(root))
                zone = next((name for name in (*PAIRED, DNF_DATA) if under(relative, (name,))),
                            'work' if under(relative, ('var',)) else 'system')
                key = (info.st_dev, info.st_ino)
                if key in links and links[key] != zone:
                    raise Error('A hardlink crosses the system/workload restore boundary.')
                links[key] = zone
    if os.path.lexists(root / 'etc/system-update'):
        raise Error('A different offline updater owns /etc/system-update.')
    trigger = root / 'system-update'
    if os.path.lexists(trigger) and (not trigger.is_symlink() or os.readlink(trigger) != '/' + DNF_STATE):
        raise Error('A different offline updater owns /system-update.')
    for name in (DNF_STATE, DNF_DATA):
        path = checked(root, name)
        if path.exists():
            if not path.is_dir():
                raise Error('Offline DNF state is not a directory.')
            for directory, directories, files in os.walk(path, followlinks=False):
                for child in [Path(directory), *(Path(directory) / n for n in [*directories, *files])]:
                    info = child.lstat()
                    if (info.st_uid != os.geteuid() or info.st_mode & 0o022 or
                            not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))):
                        raise Error('Offline DNF state is not exclusively root-owned.')


def profile(root):
    """Check the narrow layout without executing the installation's programs."""
    release = text_file(root, 'usr/lib/os-release')
    runtime = json.loads(text_file(root, 'usr/share/harness-os/runtime.json'))
    if not re.search(r'^ID=[\"\']?fedora-asahi-remix[\"\']?$', release, re.M) or runtime.get('system_profile') != 'fedora':
        raise Error('This checkpoint requires the Fedora Asahi Remix session installation.')
    if (not checked(root, 'usr/lib/sysimage/rpm').is_dir() or
            not (root / 'var/lib/rpm').is_symlink() or
            os.readlink(root / 'var/lib/rpm') not in ('../../usr/lib/sysimage/rpm', '/usr/lib/sysimage/rpm') or
            os.path.lexists(root / 'etc/alternatives.admindir')):
        raise Error('Custom RPM or alternatives state layouts are unsupported.')
    for name in PAIRED[:2]:
        if not checked(root, name).is_dir():
            raise Error('The Fedora paired package state is missing.')
    text = text_file(root, 'etc/selinux/semanage.conf')
    for key, value in re.findall(r'^\s*(module-store|store-root)\s*=\s*([^#\n]+)', text, re.M):
        if value.strip() != {'module-store': 'direct', 'store-root': '/var/lib/selinux'}[key]:
            raise Error('A custom SELinux policy store is unsupported.')
    dnf_layout(root)
    rpm_layout(root)


def dnf_layout(root):
    """Read DNF5's maintained main/drop-in order without running target code."""
    files = {}
    for name in ('usr/share/dnf5/libdnf.conf.d', 'etc/dnf/libdnf5.conf.d'):
        directory = checked(root, name)
        if directory.exists():
            if not directory.is_dir():
                raise Error('The DNF configuration directory is redirected.')
            for path in directory.glob('*.conf'):
                files[path.name] = checked(root, str(path.relative_to(root)))
    paths = [files[name] for name in sorted(files)]
    main = checked(root, 'etc/dnf/dnf.conf')
    if main.exists():
        paths.append(main)
    values = {}
    for path in paths:
        text = text_file(root, str(path.relative_to(root)))
        # DNF treats indented comments as value continuation, unlike Python.
        # The private factory profile refuses these forms instead of claiming
        # that ConfigParser implements every DNF syntax/expansion rule.
        if any(line[:1] in (' ', '\t', '\r') and line.strip() for line in text.splitlines()):
            raise Error('Indented DNF configuration needs inspection before checkpointing.')
        config = configparser.ConfigParser(interpolation=None, strict=False, delimiters=('=',),
                                           empty_lines_in_values=False,
                                           default_section='__unsupported_defaults__')
        config.optionxform = str  # DNF option names are case-sensitive.
        try:
            config.read_string(text)
        except configparser.Error as error:
            raise Error('The DNF configuration needs inspection before checkpointing.') from error
        if config.defaults():
            raise Error('An unsupported DNF configuration defaults section is present.')
        if config.has_section('main'):
            values.update(config.items('main'))
    for key, expected in (('system_state_dir', 'usr/lib/sysimage/libdnf5'),
                          ('transaction_history_dir', 'usr/lib/sysimage/libdnf5'), ('persistdir', 'var/lib/dnf')):
        if key in values and values[key] != '/' + expected:
            raise Error('Custom DNF state paths are unsupported: ' + key)
        checked(root, expected)


def rpm_layout(root):
    """Accept literal defaults and Fedora's one maintained _usr expression.

    Macro files are declarative, but expansion can execute code or load more
    definitions. Do not emulate expansion in maintenance. Also inspect masked
    platform/user definitions: this narrow adapter may refuse harmless custom
    configuration instead of silently omitting a package database in /var.
    """
    patterns = ('usr/lib/rpm/macros', 'usr/lib/rpm/macros.d/macros.*',
                'usr/lib/rpm/platform/*/macros', 'usr/lib/rpm/fileattrs/*.attr',
                'usr/lib/rpm/*/macros', 'etc/rpm/macros', 'etc/rpm/macros.*',
                'etc/rpm/*/macros', 'root/.config/rpm/macros', 'root/.rpmmacros')
    definitions, usr_definitions, needs_usr = 0, 0, False
    for pattern in patterns:
        for path in root.glob(pattern):
            text = text_file(root, str(path.relative_to(root)))
            for line in text.splitlines():
                # Reject parameters, continuations and macro/lua/load bodies.
                # RPM permits blanks after %, and any non-name character
                # ends COPYNAME (even '/' with only a warning). Recognize all
                # those candidates, then require our strict canonical form.
                if re.match(r'^\s*%\s*(?:(?:define|global)\s+)?_dbpath(?![A-Za-z0-9_])', line):
                    if not re.fullmatch(r'\s*%_dbpath\s+(?:/(?:usr/lib/sysimage/rpm|var/lib/rpm)|%\{_usr\}/lib/sysimage/rpm)\s*', line):
                        raise Error('Custom or expanded RPM database paths are unsupported.')
                    definitions += 1
                    needs_usr |= '%{_usr}' in line
                if re.match(r'^\s*%\s*(?:(?:define|global)\s+)?_usr(?![A-Za-z0-9_])', line):
                    if not re.fullmatch(r'\s*%_usr\s+/usr\s*', line):
                        raise Error('The standard RPM _usr definition is required.')
                    usr_definitions += 1
    if not definitions:
        raise Error('The standard RPM database definition is missing.')
    if needs_usr and not usr_definitions:
        raise Error('The standard RPM _usr definition is missing.')
    for pattern in ('usr/lib/rpm/rpmrc', 'usr/lib/rpm/*/rpmrc', 'etc/rpmrc',
                    'root/.rpmrc', 'root/.config/rpm/rpmrc'):
        for path in root.glob(pattern):
            text = text_file(root, str(path.relative_to(root)))
            if re.search(r'^\s*(?:macrofiles|include)\s*:', text, re.M | re.I):
                raise Error('Custom RPM macro-file loading is unsupported.')


def raw_labels():
    """Do not let SELinux translate an unknown on-disk label to unlabeled_t."""
    if not Path('/sys/fs/selinux/enforce').exists():
        return  # The filesystem supplies the raw xattr in maintenance kernels without SELinux.
    status = Path('/proc/self/status').read_text()
    value = re.search(r'^CapEff:\s*([a-f0-9]+)$', status, re.M)
    context = Path('/proc/self/attr/current').read_bytes().rstrip(b'\0\n')
    library = ctypes.CDLL('libselinux.so.1')
    access = library.selinux_check_access
    access.argtypes = [ctypes.c_char_p] * 4 + [ctypes.c_void_p]
    access.restype = ctypes.c_int
    if (not value or not int(value[1], 16) & (1 << 33) or
            access(context, context, b'capability2', b'mac_admin', None) != 0):
        raise Error('Maintenance recovery needs CAP_MAC_ADMIN to preserve raw SELinux labels.')


def copy_tree(source, destination, *, exclude=(), metadata=True):
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    args = ('-aHAXSc', '--numeric-ids') if metadata else ('-rlc',)
    run('rsync', *args, '--one-file-system', '--delete',
        *('--exclude=/' + name + '/***' for name in exclude), str(source) + '/', str(destination) + '/')
    sync(destination)
    if inventory(source, exclude=exclude, metadata=metadata) != inventory(destination, exclude=exclude, metadata=metadata):
        raise Error('The copied recovery tree did not verify.')


def copy_efi(source, destination):
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in EFI_TREES:
        src, dst = checked(source, name), checked(destination, name)
        if not src.is_dir():
            raise Error('The Fedora EFI loader directory is missing.')
        copy_tree(src, dst, metadata=False)
    for name in EFI_FILES:
        src, dst = checked(source, name), checked(destination, name)
        if src.exists():
            if not src.is_file():
                raise Error('Unexpected m1n1 boot file.')
            dst.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            data = src.read_bytes()
            # This owned file may be partial after interruption. The durable
            # journal retains both complete generations and retries the copy.
            # Do not leave an unrecorded temporary file in the protected ESP.
            fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        elif os.path.lexists(dst):
            dst.unlink()
    sync(destination)
    if inventory(source, include=efi_owned, metadata=False) != inventory(destination, include=efi_owned, metadata=False):
        raise Error('The EFI recovery copy did not verify.')


def subvolume(path, *, readonly=None):
    values = {}
    for line in run('btrfs', 'subvolume', 'show', path).splitlines():
        if ':' in line:
            key, value = line.strip().split(':', 1)
            values[key] = value.strip()
    if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', values.get('UUID', '')):
        raise Error('Cannot identify the recovery subvolume.')
    if readonly is not None and run('btrfs', 'property', 'get', '-ts', path, 'ro') != 'ro=' + str(readonly).lower():
        raise Error('The recovery subvolume protection changed.')
    return values


def snapshot(source, destination, *, readonly):
    source_uuid = subvolume(source)['UUID']
    if not destination.exists():
        run('btrfs', 'subvolume', 'snapshot', *(('-r',) if readonly else ()), source, destination)
        sync(destination.parent)
    found = subvolume(destination, readonly=readonly)
    if found.get('Parent UUID') != source_uuid:
        raise Error('The saved subvolume came from another generation.')
    return found['UUID']


def validate_layout(top):
    if any(path.name not in ('root', 'home', STORE) for path in top.iterdir()):
        raise Error('Unhandled top-level Btrfs layout.')
    names = []
    for line in run('btrfs', 'subvolume', 'list', top).splitlines():
        if ' path ' not in line:
            raise Error('Cannot inventory Btrfs subvolumes.')
        names.append(line.split(' path ', 1)[1].removeprefix('<FS_TREE>/'))
    for name in names:
        if name in ('root', 'home'):
            continue
        if not re.fullmatch(re.escape(STORE) + r'/[a-f0-9]{32}/(root|failed-root|candidate|replaced-root)', name):
            raise Error('Unhandled nested Btrfs subvolume: ' + name)
        folder = checked(top, str(Path(name).parent))
        record = read_json(folder / 'checkpoint.json')
        if record.get('id') != folder.name or record.get('kind') != 'harness-fedora-checkpoint':
            raise Error('An unrecognized archive occupies the recovery directory.')
    if 'home' not in names:
        raise Error('The separate home subvolume is missing.')
    for name in ('root', 'home'):
        path = checked(top, name)
        if os.path.lexists(path) and not path.is_dir():
            raise Error('The installation subvolume path is not a directory.')


def digests(value, fields):
    if any(not re.fullmatch('[a-f0-9]{64}', str(value.get(key, ''))) for key in fields):
        raise Error('The recovery record contains an invalid content digest.')


def probe(device):
    result = run('blkid', '-p', '-o', 'export', device)
    return dict(line.split('=', 1) for line in result.splitlines() if '=' in line)


def single_device(mapper, root_uuid):
    # All present superblock copies must describe the supported one-device
    # filesystem before even a no-replay mount can discover another device.
    text = run('btrfs', 'inspect-internal', 'dump-super', '--all', mapper)
    ids = re.findall(r'^fsid\s+(\S+)\s*$', text, re.M)
    devices = re.findall(r'^num_devices\s+(\S+)\s*$', text, re.M)
    checksums = re.findall(r'^csum\s+0x[0-9a-f]+\s+\[match\]\s*$', text, re.M)
    if not ids or any(value != root_uuid for value in ids) or devices != ['1'] * len(ids) or len(checksums) != len(ids):
        raise Error('Recovery requires the verified single-device Btrfs filesystem.')


def mounted_device(mapper, root_uuid):
    """Confirm the no-replay kernel mount selected only the verified mapper."""
    device = os.stat(mapper).st_rdev
    expected = f'{os.major(device)}:{os.minor(device)}'
    members = list((Path('/sys/fs/btrfs') / root_uuid / 'devices').iterdir())
    if len(members) != 1 or (members[0] / 'dev').read_text().strip() != expected:
        raise Error('The mounted Btrfs device set differs from the verified mapper.')


def remap(plan, disk):
    result = json.loads(json.dumps(plan))
    original = plan['original']['device']
    result['original']['device'] = disk
    for item in [*result['original']['partitions'], *result['additions']]:
        number = target.partition_number(original, item['node'])
        item['node'] = disk + ('p' if disk[-1].isdigit() else '') + str(number)
    return result


def unmounted(devices, esp_device, esp_path, root_uuid):
    """Check every visible mount namespace, including the maintenance host's."""
    # Btrfs uses anonymous major/minor mount IDs. Its mounted feature directory
    # also catches a mount whose source alias (e.g. /dev/root) is unavailable.
    if (Path('/sys/fs/btrfs') / root_uuid / 'features').exists():
        raise Error('The target Btrfs filesystem is mounted; use maintenance Linux.')
    identities = {os.stat(path).st_rdev for path in devices}
    esp_identity = os.stat(esp_device).st_rdev
    own_namespace = os.readlink('/proc/self/ns/mnt')
    namespaces = set()
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        try:
            namespace = os.readlink(process / 'ns/mnt')
            if namespace in namespaces:
                continue
            content = (process / 'mountinfo').read_text()
            namespaces.add(namespace)
        except (FileNotFoundError, ProcessLookupError):
            continue
        for line in content.splitlines():
            fields = line.split()
            separator = fields.index('-')
            source = fields[separator + 2]
            mount = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), fields[4])
            try:
                device = os.stat(source).st_rdev if source.startswith('/dev/') else None
            except FileNotFoundError:
                device = None
            major, minor = map(int, fields[2].split(':'))
            mounted_device = os.makedev(major, minor)
            if (device in identities or mounted_device in identities or
                    (esp_identity in (device, mounted_device) and
                     (namespace != own_namespace or mount != str(esp_path)))):
                raise Error('The target is mounted; use an independent maintenance system.')
            if mount.startswith(str(esp_path) + '/'):
                raise Error('An unexpected filesystem is mounted below the owned ESP.')


@contextmanager
def mounted(device, path, options):
    path.mkdir(mode=0o700)
    run('mount', '-o', options, device, path)
    try:
        yield path
    finally:
        run('umount', path)


def inspect_cold(mapper, boot, work, root_uuid):
    """Reject unsupported trees without replaying either filesystem's journal.

    Ordinary ro mounts can write during journal replay. After this inspection,
    normal kernel replay is necessary to retain committed work from a crash;
    the normal mounts and Engine must validate the resulting trees again.
    """
    with mounted(mapper, work / 'inspect-root', 'ro,subvolid=5,rescue=nologreplay,noatime') as top:
        mounted_device(mapper, root_uuid)
        validate_layout(top)
        if (top / 'root').exists():
            boundary(top / 'root')
    with mounted(boot, work / 'inspect-boot', 'ro,noload,noatime') as boot_path:
        checked(boot_path, 'efi')
        inventory(boot_path, exclude=('efi',))


@contextmanager
def installation(plan_path, mapper):
    if platform.system() != 'Linux' or os.geteuid() != 0:
        raise Error('Recovery requires root in independent maintenance Linux.')
    if (os.readlink('/proc/self/ns/mnt') == os.readlink('/proc/1/ns/mnt') or
            run('findmnt', '-nro', 'PROPAGATION', '/') != 'private'):
        raise Error('Use a private mount namespace for maintenance recovery.')
    raw_labels()
    plan_path, mapper = Path(plan_path), Path(mapper)
    plan = target.load_plan(plan_path)
    if target.platform_esp() != plan['esp_uuid']:
        raise Error('The firmware selected another installation.')
    disk = target.owning_disk(target.inventory(), plan['esp_uuid'])
    current = remap(plan, disk)
    fd = os.open(disk, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        if (not stat.S_ISBLK(os.fstat(fd).st_mode) or run('blockdev', '--getss', disk) != '4096' or
                run('blockdev', '--getro', disk) != '0'):
            raise Error('Use the recorded writable 4096-byte-sector disk.')
        target.lock_disk(fd)
        table = target.read_table(disk)
        target.verify_gpt(fd, int(run('blockdev', '--getsize64', disk)), target.normalize(table))
        if target.remaining(current, table):
            raise Error('The recorded installation partitions are incomplete.')
        target.verify_partition_devices(current)
        esp_part = next(p for p in current['original']['partitions'] if p['uuid'] == plan['esp_uuid'])
        mount = json.loads(run('findmnt', '--json', '--target', plan_path,
                              '--output', 'SOURCE,TARGET,FSTYPE,OPTIONS'))['filesystems'][0]
        esp = Path(mount['target'])
        if (mount['fstype'] != 'vfat' or 'rw' not in mount['options'].split(',') or
                os.stat(mount['source']).st_rdev != os.stat(esp_part['node']).st_rdev or
                plan_path != esp / 'asahi/harness-install/target.json'):
            raise Error('Use the completed receipt on its privately mounted writable ESP.')
        state = read_json(plan_path.with_name('storage.json'))
        storage.validate_identity(state.get('image_sha256'), state.get('source_commit'))
        storage.validate_state(state, plan, state.get('image_sha256'), state.get('source_commit'))
        startup = read_json(plan_path.with_name('startup.json'))
        if (set(startup) != {'schema', 'kind', 'phase', 'storage_sha256', 'boot_files'} or
                type(startup.get('schema')) is not int or startup['schema'] != 1 or
                startup.get('kind') != 'harness-asahi-startup' or state['phase'] != 'copied' or
                startup.get('phase') != 'complete' or startup.get('storage_sha256') != storage.fingerprint(state)):
            raise Error('The recorded installation has not completed.')
        boot, encrypted = (p['node'] for p in current['additions'])
        storage.require_filesystem(probe(boot), 'ext4', state['boot_uuid'])
        storage.require_filesystem(probe(encrypted), 'crypto_LUKS', state['luks_uuid'])
        if not re.fullmatch(r'/dev/mapper/[A-Za-z0-9_-]+', str(mapper)) or not stat.S_ISBLK(mapper.stat().st_mode):
            raise Error('Supply the already unlocked installation mapper.')
        status = dict(line.strip().split(':', 1) for line in run('cryptsetup', 'status', mapper.name).splitlines()[1:] if ':' in line)
        if status.get('type', '').strip() != 'LUKS2' or os.stat(status.get('device', '').strip()).st_rdev != os.stat(encrypted).st_rdev:
            raise Error('The unlocked mapper belongs to another encrypted device.')
        storage.require_filesystem(probe(mapper), 'btrfs', state['root_uuid'])
        unmounted((mapper, boot, encrypted), esp_part['node'], esp, state['root_uuid'])
        single_device(mapper, state['root_uuid'])
        identity = {key: state[key] for key in ('luks_uuid', 'root_uuid', 'boot_uuid', 'image_sha256', 'source_commit')}
        identity.update(esp_partuuid=plan['esp_uuid'], disk_guid=plan['original']['id'],
                        plan_sha256=storage.fingerprint(plan), storage_sha256=storage.fingerprint(state))
        with storage.work_directory() as work:
            inspect_cold(mapper, boot, work, state['root_uuid'])
            with mounted(mapper, work / 'top', 'ro,subvolid=5,noatime') as top, mounted(boot, work / 'boot', 'ro,noatime') as boot_path:
                mounted_device(mapper, state['root_uuid'])
                validate_layout(top)
                if (top / 'root').exists():
                    boundary(top / 'root')
                yield Engine(top, boot_path, esp, identity)
    finally:
        os.close(fd)


class Engine:
    """The archive/journal core; its caller owns cold mounts and the disk lock."""
    def __init__(self, top, boot, esp, identity):
        self.top, self.boot, self.esp, self.identity = top, boot, esp, identity

    def writable(self):
        run('mount', '-o', 'remount,rw', self.top)
        run('mount', '-o', 'remount,rw', self.boot)

    def folder(self, name):
        folder = checked(self.top, STORE + '/' + generation(name))
        for path in (folder.parent, folder):
            if path.exists() and (not path.is_dir() or stat.S_IMODE(path.stat().st_mode) != 0o700):
                raise Error('Recovery archives must be private root-only directories.')
        return folder

    def verify_checkpoint(self, folder):
        record = read_json(folder / 'checkpoint.json')
        if (set(record) != {'schema', 'kind', 'id', 'identity', 'phase', 'source_root', 'system', 'boot', 'efi'} or
                type(record.get('schema')) is not int or record['schema'] != 1 or record.get('kind') != 'harness-fedora-checkpoint' or
                record.get('id') != folder.name or record.get('identity') != self.identity or record.get('phase') != 'complete'):
            raise Error('The checkpoint is incomplete or belongs to another installation.')
        digests(record, ('system', 'boot', 'efi'))
        boundary(folder / 'root')
        profile(folder / 'root')
        if subvolume(folder / 'root', readonly=True).get('Parent UUID') != record['source_root']:
            raise Error('The checkpoint snapshot came from another root.')
        if (system_digest(folder / 'root') != record['system'] or
                inventory(folder / 'boot', exclude=('efi',)) != record['boot'] or
                inventory(folder / 'efi', include=efi_owned, metadata=False) != record['efi']):
            raise Error('The checkpoint contents do not verify.')
        return record

    def checkpoint(self, name):
        folder = self.folder(name)
        root = self.top / 'root'
        boundary(root)
        profile(root)
        source = subvolume(root)['UUID']
        if folder.exists():
            try:
                previous = read_json(folder / 'checkpoint.json')
            except FileNotFoundError:
                if any(folder.iterdir()):
                    raise Error('An unrecorded directory occupies this checkpoint.')
                previous = None  # mkdir completed before the initial record.
            if previous is not None and previous.get('phase') == 'complete':
                self.verify_checkpoint(folder)
                return name
        record = {'schema': 1, 'kind': 'harness-fedora-checkpoint', 'id': name, 'identity': self.identity,
                  'phase': 'planned', 'source_root': source, 'system': system_digest(root),
                  'boot': inventory(self.boot, exclude=('efi',)),
                  'efi': inventory(self.esp, include=efi_owned, metadata=False)}
        if folder.exists() and previous is not None and previous != record:
            raise Error('An unfinished checkpoint belongs to different source contents.')
        self.writable()
        if not folder.exists():
            folder.parent.mkdir(mode=0o700, exist_ok=True)
            folder.mkdir(mode=0o700)
        if not (folder / 'checkpoint.json').exists():
            save(folder / 'checkpoint.json', record)
        snapshot(root, folder / 'root', readonly=True)
        copy_tree(self.boot, folder / 'boot', exclude=('efi',))
        copy_efi(self.esp, folder / 'efi')
        record['phase'] = 'complete'
        save(folder / 'checkpoint.json', record)
        self.verify_checkpoint(folder)
        return name

    def advance(self, folder, state, phase):
        updated = {**state, 'phase': phase}
        save(folder / 'recovery.json', updated)
        state.update(updated)

    def verify_boot_stages(self, checkpoint, phase):
        if (phase in ('boot', 'efi', 'root-moved') and
                inventory(self.boot, exclude=('efi',)) != checkpoint['boot']):
            raise Error('The completed boot restoration changed; no later stage was written.')
        if (phase in ('efi', 'root-moved') and
                inventory(self.esp, include=efi_owned, metadata=False) != checkpoint['efi']):
            raise Error('The completed EFI restoration changed; no later stage was written.')

    def recover(self, name):
        folder = self.folder(name)
        checkpoint = self.verify_checkpoint(folder)
        root, failed, candidate, replaced = (self.top / 'root', folder / 'failed-root', folder / 'candidate', folder / 'replaced-root')
        journal = folder / 'recovery.json'
        if journal.exists():
            state = read_json(journal)
            required = {'schema', 'kind', 'checkpoint', 'phase', 'original_root', 'failed_system', 'work',
                        'failed_boot', 'failed_efi', 'protected_efi'}
            phase = state.get('phase')
            if phase in PHASES[1:]:
                required.add('failed_root')
            if phase in PHASES[2:]:
                required.add('candidate_root')
            if (set(state) != required or type(state.get('schema')) is not int or state['schema'] != 1 or
                    state.get('kind') != 'harness-fedora-recovery' or
                    state.get('checkpoint') != storage.fingerprint(checkpoint) or state.get('phase') not in PHASES):
                raise Error('The recovery journal has changed.')
            digests(state, ('checkpoint', 'failed_system', 'work', 'failed_boot', 'failed_efi', 'protected_efi'))
            if state['phase'] == 'complete':
                return state
        else:
            boundary(root)
            state = {'schema': 1, 'kind': 'harness-fedora-recovery', 'checkpoint': storage.fingerprint(checkpoint),
                     'phase': 'planned', 'original_root': subvolume(root)['UUID'],
                     'failed_system': system_digest(root), 'work': work_digest(root),
                     'failed_boot': inventory(self.boot, exclude=('efi',)),
                     'failed_efi': inventory(self.esp, include=efi_owned, metadata=False),
                     'protected_efi': inventory(self.esp, include=efi_protected, metadata=False)}
        # No writes until every extant source and the untouched ESP area verify.
        boundary(folder / 'root')
        if inventory(self.esp, include=efi_protected, metadata=False) != state['protected_efi']:
            raise Error('Unowned EFI files changed during recovery.')
        if root.exists():
            boundary(root)
        if state['phase'] in ('planned', 'evidence', 'candidate', 'boot', 'efi'):
            if (not root.exists() or subvolume(root)['UUID'] != state['original_root'] or
                    system_digest(root) != state['failed_system'] or work_digest(root) != state['work']):
                # The rename can complete before its journal record is durable.
                if not (state['phase'] == 'efi' and replaced.exists() and not root.exists()):
                    raise Error('The failed root changed; preserve its new work before retrying.')
        if state['phase'] != 'planned':
            if (subvolume(failed, readonly=True)['UUID'] != state['failed_root'] or
                    system_digest(failed) != state['failed_system'] or work_digest(failed) != state['work'] or
                    inventory(folder / 'failed-boot', exclude=('efi',)) != state['failed_boot'] or
                    inventory(folder / 'failed-efi', include=efi_owned, metadata=False) != state['failed_efi']):
                raise Error('The retained failed-generation evidence changed.')
        if state['phase'] in PHASES[2:]:
            prepared = root if state['phase'] == 'root-moved' and root.exists() else candidate
            if (subvolume(prepared, readonly=False)['UUID'] != state['candidate_root'] or
                    system_digest(prepared) != checkpoint['system'] or work_digest(prepared) != state['work']):
                raise Error('The prepared candidate changed; no boot files were restored.')
        self.verify_boot_stages(checkpoint, state['phase'])
        self.writable()
        if not journal.exists():
            save(journal, state)
        if state['phase'] == 'planned':
            state['failed_root'] = snapshot(root, failed, readonly=True)
            copy_tree(self.boot, folder / 'failed-boot', exclude=('efi',))
            copy_efi(self.esp, folder / 'failed-efi')
            if (system_digest(failed) != state['failed_system'] or work_digest(failed) != state['work'] or
                    inventory(folder / 'failed-boot', exclude=('efi',)) != state['failed_boot'] or
                    inventory(folder / 'failed-efi', include=efi_owned, metadata=False) != state['failed_efi']):
                raise Error('The failed-generation evidence did not verify.')
            self.advance(folder, state, 'evidence')
        if state['phase'] == 'evidence':
            boundary(failed)
            state['candidate_root'] = snapshot(failed, candidate, readonly=False)
            boundary(candidate)
            if work_digest(candidate) != state['work']:
                raise Error('The candidate workload tree changed.')
            copy_tree(folder / 'root', candidate, exclude=(*SEPARATE, 'var'))
            for name in PAIRED:
                src, dst = checked(folder / 'root', name), checked(candidate, name)
                if src.is_dir():
                    copy_tree(src, dst)
                elif src.is_file():
                    run('rsync', '-aHAXc', '--numeric-ids', src, dst)
                elif os.path.lexists(dst):
                    if not dst.is_file():
                        raise Error('An unexpected paired state directory needs inspection.')
                    dst.unlink()
            self.clean_offline(candidate)
            profile(candidate)
            sync(candidate)
            if system_digest(candidate) != checkpoint['system'] or work_digest(candidate) != state['work']:
                raise Error('The candidate did not restore the system while preserving workload data.')
            self.advance(folder, state, 'candidate')
        if state['phase'] == 'candidate':
            copy_tree(folder / 'boot', self.boot, exclude=('efi',))
            self.advance(folder, state, 'boot')
        if state['phase'] == 'boot':
            self.verify_boot_stages(checkpoint, 'boot')
            copy_efi(folder / 'efi', self.esp)
            self.advance(folder, state, 'efi')
        if state['phase'] == 'efi':
            self.verify_boot_stages(checkpoint, 'efi')
            if root.exists():
                if replaced.exists():
                    raise Error('Another replaced root occupies this recovery generation.')
                root.rename(replaced)
                sync(self.top)
            if subvolume(replaced)['UUID'] != state['original_root']:
                raise Error('The retained original root has changed.')
            if system_digest(replaced) != state['failed_system'] or work_digest(replaced) != state['work']:
                raise Error('The retained original root contents changed.')
            self.advance(folder, state, 'root-moved')
        if state['phase'] == 'root-moved':
            self.verify_boot_stages(checkpoint, 'root-moved')
            if not root.exists():
                if subvolume(candidate)['UUID'] != state['candidate_root']:
                    raise Error('The candidate identity changed.')
                candidate.rename(root)
                sync(self.top)
            if (subvolume(root)['UUID'] != state['candidate_root'] or system_digest(root) != checkpoint['system'] or
                    work_digest(root) != state['work'] or inventory(self.boot, exclude=('efi',)) != checkpoint['boot'] or
                    inventory(self.esp, include=efi_owned, metadata=False) != checkpoint['efi'] or
                    inventory(self.esp, include=efi_protected, metadata=False) != state['protected_efi']):
                raise Error('The activated generation needs inspection; no further files were replaced.')
            self.advance(folder, state, 'complete')
        return state

    def clean_offline(self, root):
        # The failed snapshot retains the original bytes. Do not execute programs
        # or plugins from the damaged installation just to remove its trigger.
        boundary(root)
        trigger = root / 'system-update'
        if trigger.is_symlink():
            trigger.unlink()
        for name in (DNF_STATE, DNF_DATA):
            path = checked(root, name)
            if path.is_dir():
                for directory, directories, files in os.walk(path, topdown=False, followlinks=False):
                    for child in files:
                        (Path(directory) / child).unlink()
                    for child in directories:
                        (Path(directory) / child).rmdir()
                path.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True, type=Path, help='Completed target.json on the privately mounted owned ESP')
    parser.add_argument('--mapper', required=True, type=Path, help='Already unlocked LUKS mapper; no password is stored')
    sub = parser.add_subparsers(dest='command', required=True)
    create = sub.add_parser('checkpoint')
    create.add_argument('--id', default=None, help='A fixed 32-digit hexadecimal id permits exact-content retries')
    restore = sub.add_parser('recover')
    restore.add_argument('checkpoint', type=generation)
    args = parser.parse_args()
    with installation(args.plan, args.mapper) as engine:
        if args.command == 'checkpoint':
            print(engine.checkpoint(generation(args.id or uuid.uuid4().hex)))
        else:
            print(json.dumps(engine.recover(args.checkpoint), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (Error, target.TargetError, OSError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from error
