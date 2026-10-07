"""Private Asahi encrypted storage enrollment and verified image copy.

Only prepared target.py partitions can be written. This stage does not configure
boot or make an installation live; completed copies are never recopied on retry.
"""
from contextlib import contextmanager, ExitStack
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import uuid

spec = importlib.util.spec_from_file_location('asahi_target', Path(__file__).with_name('target.py'))
target = importlib.util.module_from_spec(spec)
spec.loader.exec_module(target)
PHASES = ('planned', 'encrypted', 'filesystems', 'copying', 'copied')


class StorageError(ValueError):
    pass


def run(*args, secret=None, timeout=120):
    result = subprocess.run(list(map(str, args)), input=secret, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, env={**os.environ, 'LC_ALL': 'C'})
    if result.returncode:
        # Passwords go only through stdin, never arguments, state or diagnostics.
        raise StorageError(f'{args[0]} failed ({result.returncode}): ' + result.stderr.decode(errors='replace').strip())
    return result.stdout.decode().strip()


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def validate_identity(digest, source):
    if not re.fullmatch('[a-f0-9]{64}', str(digest)) or not re.fullmatch('[a-f0-9]{40}', str(source)):
        raise StorageError('Use the verified image SHA-256 and full source commit.')


def new_state(plan, image_sha256, source_commit):
    target.validate_plan(plan)
    validate_identity(image_sha256, source_commit)
    return {'schema': 1, 'kind': 'harness-asahi-storage', 'plan_sha256': fingerprint(plan),
            'image_sha256': image_sha256, 'source_commit': source_commit,
            'luks_uuid': str(uuid.uuid4()), 'root_uuid': str(uuid.uuid4()),
            'boot_uuid': str(uuid.uuid4()), 'phase': 'planned'}


def validate_state(state, plan, image_sha256, source_commit):
    fields = {'schema', 'kind', 'plan_sha256', 'image_sha256', 'source_commit',
              'luks_uuid', 'root_uuid', 'boot_uuid', 'phase'}
    if (not isinstance(state, dict) or set(state) != fields or type(state['schema']) is not int or state['schema'] != 1 or
            state['kind'] != 'harness-asahi-storage' or state['plan_sha256'] != fingerprint(plan) or
            state['image_sha256'] != image_sha256 or state['source_commit'] != source_commit or
            state['phase'] not in PHASES):
        raise StorageError('The saved copy belongs to a different installation or image.')
    ids = [target.identifier(state[name]) for name in ('luks_uuid', 'root_uuid', 'boot_uuid')]
    if len(set(ids)) != 3 or ids != [state[name] for name in ('luks_uuid', 'root_uuid', 'boot_uuid')]:
        raise StorageError('The installation filesystem identities are invalid.')
    return state


def read_state(path, plan, digest, source):
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd = None
    try:
        target.private_directory(directory)
        try:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return None
        target.private_file(fd)
        with os.fdopen(fd, 'r') as stream:
            fd = None
            try:
                state = json.loads(stream.read(128 * 1024))
            except (UnicodeError, json.JSONDecodeError) as error:
                raise StorageError('The saved storage record is incomplete. Keep it for recovery.') from error
        return validate_state(state, plan, digest, source)
    finally:
        if fd is not None:
            os.close(fd)
        os.close(directory)


def save_state(path, state):
    """Caller holds the verified target disk lock; publish only a fully synced record."""
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary = None
    try:
        target.private_directory(directory)
        if os.path.lexists(path):
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                target.private_file(fd)
            finally:
                os.close(fd)
        fd, temporary = tempfile.mkstemp(prefix='.storage-', dir=path.parent)
        with os.fdopen(fd, 'w') as stream:
            json.dump(state, stream, sort_keys=True, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
        target.sync_directory(directory)
    finally:
        if temporary is not None:
            os.unlink(temporary)
        os.close(directory)


def advance(path, state, phase):
    if PHASES.index(state['phase']) < PHASES.index(phase):
        updated = {**state, 'phase': phase}
        save_state(path, updated)
        state.update(updated)


def probe(device):
    result = subprocess.run(['blkid', '-p', '-o', 'export', str(device)], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=30)
    if result.returncode not in (0, 2):
        raise StorageError('Cannot identify the installation filesystem.')
    values = dict(line.split('=', 1) for line in result.stdout.decode().splitlines() if '=' in line)
    if result.returncode == 2 and values:
        raise StorageError('The filesystem probe is incomplete.')
    return values


def require_filesystem(values, kind, identity):
    if values.get('TYPE') != kind or values.get('UUID') != identity:
        raise StorageError('An installation filesystem has changed. Keep its data untouched.')


@contextmanager
def work_directory():
    root = Path(tempfile.mkdtemp(prefix='harness-asahi-', dir='/run'))
    try:
        yield root
    finally:
        # Never recursively delete a work directory: an unsuccessful unmount
        # could otherwise turn cleanup into deletion of the installed OS.
        for child in root.iterdir():
            child.rmdir()
        root.rmdir()


@contextmanager
def mounted(device, path, options):
    path.mkdir()
    try:
        run('mount', '-o', options, device, path)
        yield path
    finally:
        if os.path.ismount(path):
            run('umount', path)


class Payload:
    """A SHA-256-verified raw Asahi image exposed as a read-only block device."""
    def __init__(self, device, image_sha256, source_commit):
        validate_identity(image_sha256, source_commit)
        self.device = str(device)
        self.sha256, self.source_commit = image_sha256, source_commit
        self.root = self.home = self.boot = self.esp = None
        self._opened = False

    @contextmanager
    def open(self):
        # Installation stages can share one verified, read-only mount lifetime.
        # This is never cached across attempts: the outer exit clears the state
        # and the next independent open verifies the whole source again.
        if self._opened:
            yield self
            return
        info = os.stat(self.device, follow_symlinks=False)
        if not stat.S_ISBLK(info.st_mode) or run('blockdev', '--getro', self.device) != '1':
            raise StorageError('The verified source image must be a read-only block device.')
        if run('blockdev', '--getss', self.device) != '4096':
            raise StorageError('Use the Asahi 4096-byte-sector source image.')
        with open(self.device, 'rb', buffering=0) as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != self.sha256:
                raise StorageError('The source image checksum does not match. Nothing was installed.')
            table = target.normalize(target.read_table(self.device))
            target.verify_gpt(stream.fileno(), int(run('blockdev', '--getsize64', self.device)), table)
        separator = 'p' if self.device[-1].isdigit() else ''
        parts = [self.device + separator + str(n) for n in (1, 2, 3)]
        if [p['node'] for p in table['partitions']] != parts:
            raise StorageError('The source image partition layout has changed.')
        for device, kind in zip(parts, ('vfat', 'ext4', 'btrfs')):
            if probe(device).get('TYPE') != kind:
                raise StorageError('The source image filesystems have changed.')
        with work_directory() as root, ExitStack() as mounts:
            top = mounts.enter_context(mounted(parts[2], root / 'top', 'ro,rescue=nologreplay,subvolid=5'))
            boot = mounts.enter_context(mounted(parts[1], root / 'boot', 'ro,noload'))
            self.esp = mounts.enter_context(mounted(parts[0], root / 'esp', 'ro'))
            self.root, self.home, self.boot = top / 'root', top / 'home', boot
            try:
                self.verify_pristine()
                self._opened = True
                yield self
            finally:
                self._opened = False
                self.root = self.home = self.boot = self.esp = None

    def verify_pristine(self):
        image = json.loads((self.root / 'usr/share/harness-os/image.json').read_text())
        if (image.get('kind') != 'harness-asahi-image-construction' or image.get('profile') != 'Harness' or
                image.get('release_ready') is not False or image.get('source_commit') != self.source_commit):
            raise StorageError('Use the verified private Harness Asahi image.')
        accounts = [row.split(':') for row in (self.root / 'etc/passwd').read_text().splitlines()]
        if any(1000 <= int(row[2]) < 65534 for row in accounts) or any(self.home.iterdir()):
            raise StorageError('The source image already contains a user or home data.')
        root = next(row.split(':') for row in (self.root / 'etc/shadow').read_text().splitlines() if row.startswith('root:'))
        if not root[1].startswith(('!', '*')) or (self.root / 'var/lib/harness-os/firstboot.json').exists():
            raise StorageError('The source image has already been configured.')


@contextmanager
def encrypted_root(device, state, secret):
    name = 'harness-stage-' + state['luks_uuid'].replace('-', '')
    path = Path('/dev/mapper') / name
    if path.exists():
        identity = run('dmsetup', 'info', '--columns', '--noheadings', '--options', 'uuid', name)
        expected = 'CRYPT-LUKS2-' + state['luks_uuid'].replace('-', '') + '-' + name
        slaves = Path('/sys/dev/block') / f'{os.major(path.stat().st_rdev)}:{os.minor(path.stat().st_rdev)}' / 'slaves'
        if (identity != expected or len(list(slaves.iterdir())) != 1 or
                next(slaves.iterdir()).name != Path(device).name or
                run('dmsetup', 'info', '--columns', '--noheadings', '--options', 'open', name) != '0'):
            raise StorageError('An existing encryption mapping is in use or belongs to another installation.')
        run('cryptsetup', 'open', '--test-passphrase', '--key-file=-', device, secret=secret)
    else:
        run('cryptsetup', 'open', '--key-file=-', device, name, secret=secret)
    try:
        yield path
    finally:
        run('cryptsetup', 'close', name, timeout=30)


def ensure_filesystem(device, kind, identity, state, *mkfs):
    values = probe(device)
    if not values.get('TYPE'):
        if PHASES.index(state['phase']) >= PHASES.index('filesystems') or values.get('PTTYPE'):
            raise StorageError('A previously created filesystem is missing. Keep this target untouched.')
        run(*mkfs, device)
        values = probe(device)
    require_filesystem(values, kind, identity)


def subvolumes(top):
    if any(path.name not in ('root', 'home') for path in top.iterdir()):
        raise StorageError('The installation root contains another layout.')
    for name in ('root', 'home'):
        path = top / name
        if not path.exists():
            run('btrfs', 'subvolume', 'create', path)
        if path.is_symlink() or not path.is_dir():
            raise StorageError('An installation subvolume has changed.')
        run('btrfs', 'subvolume', 'show', path)


def copy_tree(source, destination, excludes=(), *, copy_selinux=True):
    # Some generated boot files are unlabeled. Keep destination labels until
    # startup applies the installed policy, rather than removing those labels
    # under enforcement. Root/home retain their source labels. An explicit
    # xattr rule also requires preserving rsync's system.* exclusion.
    filters = () if copy_selinux else ('--filter=-x system.*', '--filter=-x security.selinux')
    run('rsync', '-aHAX', '--numeric-ids', '--one-file-system', '--delete', '--checksum',
        *filters, *('--exclude=' + value for value in excludes),
        str(source) + '/', str(destination) + '/', timeout=300)


def mountpoint(source, destination):
    if os.path.lexists(destination) and (destination.is_symlink() or not destination.is_dir()):
        raise StorageError('An installation mountpoint has changed.')
    destination.mkdir(exist_ok=True)
    shutil.copystat(source, destination)


def copy_root(source, destination):
    # The kernel supplies runtime filesystems on boot. Copying the image's
    # temporary /dev nodes also tries to remove their SELinux labels, which an
    # enforcing installer correctly refuses. Keep only the mount directories.
    separate = ('boot', 'home', 'dev', 'proc', 'sys', 'run')
    for name in separate:
        mountpoint(source / name, destination / name)
    copy_tree(source, destination, excludes=tuple('/' + name + '/***' for name in separate))


def install(plan_path, payload, password, progress=None):
    """Enroll unique encrypted storage, then resume only its unfinished OS copy."""
    if not isinstance(password, str) or not password or any(c in password for c in '\0\n\r'):
        raise StorageError('Enter a password without line breaks.')
    report = progress or (lambda message: None)
    path = Path(plan_path).with_name('storage.json')
    # Authenticate the immutable payload before changing the destination.
    report('Checking installation files…')
    with payload.open(), target.locked_plan(plan_path) as (plan, disk_fd):
        boot, encrypted = [part['node'] for part in plan['additions']]
        state = read_state(path, plan, payload.sha256, payload.source_commit)
        if state is None:
            for device in (boot, encrypted):
                existing = probe(device)
                if existing.get('TYPE') or existing.get('PTTYPE'):
                    raise StorageError('The reserved partitions already contain a filesystem. Keep it untouched.')
            state = new_state(plan, payload.sha256, payload.source_commit)
            save_state(path, state)  # Durable identities before the first format.
        report('Setting up encryption…')
        values = probe(encrypted)
        if not values.get('TYPE'):
            if state['phase'] != 'planned' or values.get('PTTYPE'):
                raise StorageError('The encrypted filesystem is missing. Keep this target untouched.')
            run('cryptsetup', 'luksFormat', '--type', 'luks2', '--batch-mode', '--uuid', state['luks_uuid'],
                '--pbkdf', 'argon2id', '--pbkdf-memory', '262144', '--key-file=-', encrypted,
                secret=password.encode())
            values = probe(encrypted)
        require_filesystem(values, 'crypto_LUKS', state['luks_uuid'])
        metadata = json.loads(run('cryptsetup', 'luksDump', '--dump-json-metadata', encrypted))
        if not metadata.get('keyslots') or any(slot['kdf']['type'] != 'argon2id' for slot in metadata['keyslots'].values()):
            raise StorageError('The encryption configuration has changed.')
        with encrypted_root(encrypted, state, password.encode()) as mapper:
            advance(path, state, 'encrypted')
            ensure_filesystem(mapper, 'btrfs', state['root_uuid'], state,
                              'mkfs.btrfs', '--uuid', state['root_uuid'], '--label', 'Harness')
            ensure_filesystem(boot, 'ext4', state['boot_uuid'], state,
                              'mkfs.ext4', '-U', state['boot_uuid'], '-L', 'Harness boot',
                              '-E', 'lazy_itable_init=0,lazy_journal_init=0')
            if state['phase'] == 'copied':
                return state  # Never overwrite work in a completed installation.
            with work_directory() as root, ExitStack() as mounts:
                top = mounts.enter_context(mounted(mapper, root / 'top', 'subvolid=5,compress=zstd:1,noatime'))
                boot_path = mounts.enter_context(mounted(boot, root / 'boot', 'noatime'))
                subvolumes(top)
                advance(path, state, 'filesystems')
                advance(path, state, 'copying')
                report('Copying Harness…')
                copy_root(payload.root, top / 'root')
                mountpoint(payload.boot / 'efi', boot_path / 'efi')
                copy_tree(payload.home, top / 'home')
                copy_tree(payload.boot, boot_path, excludes=('/efi/***',), copy_selinux=False)
                run('sync', '-f', top)
                run('sync', '-f', boot_path)
                current = target.read_table(plan['original']['device'])
                target.verify_gpt(disk_fd, int(run('blockdev', '--getsize64', plan['original']['device'])), target.normalize(current))
                if target.remaining(plan, current):
                    raise StorageError('The target partition layout changed during copying.')
                advance(path, state, 'copied')
                report('Harness files are ready.')
        return state
