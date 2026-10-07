"""Private Asahi installer disk preparation, restricted to its owned ESP's gap.

The platform handoff identifies one EFI partition. Only the unallocated space
immediately following it can become Harness boot/root partitions. Existing
partitions are never removed, moved, resized or formatted by this module.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import fcntl
import json
import os
from pathlib import Path
import platform
import re
import stat
import struct
import subprocess
import tempfile
import time
import uuid
import zlib

EFI = 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b'
LINUX = '0fc63daf-8483-4772-8e79-3d69d8477de4'
LUKS = 'ca7d7ccb-63ed-4c53-861c-1742536059cc'
BOOT_BYTES = 1024**3
ROOT_MIN_BYTES = 12 * 1024**3
ALIGN_BYTES = 1024**2


class TargetError(ValueError):
    pass


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', value):
        raise TargetError('Invalid partition identity.')
    return str(uuid.UUID(value))


def integer(value):
    if type(value) is not int or value < 0:
        raise TargetError('Invalid disk geometry.')
    return value


def partition_number(device, node):
    if not isinstance(node, str):
        raise TargetError('Invalid partition device.')
    separator = 'p' if device[-1].isdigit() else ''
    match = re.fullmatch(re.escape(device + separator) + r'([1-9][0-9]*)', node)
    if not match or not 1 <= int(match[1]) <= 128:
        raise TargetError('Partition is not a GPT entry on the selected disk.')
    return int(match[1])


def normalize(snapshot):
    """Validate sfdisk's geometry without accepting a caller's arbitrary extents."""
    try:
        table = snapshot['partitiontable']
        device = table['device']
        if not isinstance(device, str) or not re.fullmatch(r'/dev/[a-zA-Z0-9_-]+', device):
            raise TargetError('Use an identified whole block device.')
        if table['label'] != 'gpt' or table['unit'] != 'sectors' or table['sectorsize'] != 4096:
            raise TargetError('Use the Asahi 4096-byte-sector GPT layout.')
        first, last = integer(table['firstlba']), integer(table['lastlba'])
        if not 1 <= first < last:
            raise TargetError('Invalid usable disk bounds.')
        normalized = {'device': device, 'id': identifier(table['id']), 'firstlba': first,
                      'lastlba': last, 'sectorsize': 4096, 'partitions': []}
        numbers, identities = set(), set()
        for part in table['partitions']:
            # Retain all attributes reported by sfdisk, including names and GPT
            # flags: a change outside our two new entries invalidates the plan.
            entry = dict(part)
            number = partition_number(device, entry['node'])
            entry['uuid'], entry['type'] = identifier(entry['uuid']), identifier(entry['type'])
            start, size = integer(entry['start']), integer(entry['size'])
            if not size or start < first or start + size - 1 > last:
                raise TargetError('A partition leaves the usable disk bounds.')
            if number in numbers or entry['uuid'] in identities:
                raise TargetError('Duplicate partition number or identity.')
            numbers.add(number)
            identities.add(entry['uuid'])
            normalized['partitions'].append(entry)
        normalized['partitions'].sort(key=lambda part: part['start'])
        for left, right in zip(normalized['partitions'], normalized['partitions'][1:]):
            if left['start'] + left['size'] > right['start']:
                raise TargetError('Overlapping partitions.')
        if not normalized['partitions']:
            raise TargetError('The Asahi boot partition is missing.')
        return normalized
    except (KeyError, TypeError, AttributeError) as error:
        raise TargetError('Incomplete partition inventory.') from error


def new_plan(snapshot, esp_uuid, *, partition_ids=None):
    table = normalize(snapshot)
    esp_uuid = identifier(esp_uuid)
    entries = table['partitions']
    selected = [part for part in entries if part['uuid'] == esp_uuid]
    if len(selected) != 1 or selected[0]['type'] != EFI:
        raise TargetError('The current Asahi EFI partition is not on this disk.')
    esp = selected[0]
    sector = table['sectorsize']
    alignment = ALIGN_BYTES // sector
    first = (esp['start'] + esp['size'] + alignment - 1) // alignment * alignment
    next_start = next((part['start'] for part in entries if part['start'] > esp['start']), table['lastlba'] + 1)
    end = next_start // alignment * alignment
    boot_size = BOOT_BYTES // sector
    if end - first < (BOOT_BYTES + ROOT_MIN_BYTES) // sector:
        raise TargetError('Use the Asahi installer to reserve at least 13 GiB after this EFI partition.')
    occupied = {partition_number(table['device'], part['node']) for part in entries}
    free_numbers = [number for number in range(1, 129) if number not in occupied]
    if len(free_numbers) < 2:
        raise TargetError('Two unused GPT entries are required.')
    if partition_ids is None:
        partition_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
    identities = [identifier(value) for value in partition_ids]
    if len(identities) != 2 or len(set(identities)) != 2 or any(value in {p['uuid'] for p in entries} for value in identities):
        raise TargetError('New partitions require distinct, unused identities.')
    separator = 'p' if table['device'][-1].isdigit() else ''
    additions = []
    for number, identity, start, size, kind, name in [
        (free_numbers[0], identities[0], first, boot_size, LINUX, 'Harness boot'),
        (free_numbers[1], identities[1], first + boot_size, end - first - boot_size, LUKS, 'Harness root'),
    ]:
        additions.append({'node': table['device'] + separator + str(number), 'start': start,
                          'size': size, 'type': kind, 'uuid': identity, 'name': name})
    return {'schema': 1, 'kind': 'harness-asahi-target', 'esp_uuid': esp_uuid,
            'original': table, 'additions': additions}


def validate_plan(plan):
    try:
        original = plan['original']
        snapshot = {'partitiontable': {**original, 'label': 'gpt', 'unit': 'sectors'}}
        expected = new_plan(snapshot, plan['esp_uuid'], partition_ids=[p['uuid'] for p in plan['additions']])
    except (KeyError, TypeError) as error:
        raise TargetError('Incomplete installation plan.') from error
    if plan != expected:
        raise TargetError('The installation plan no longer matches its reserved space.')
    return expected


def remaining(plan, snapshot):
    """Allow only the exact original layout plus any already-written planned entries."""
    validate_plan(plan)
    actual = normalize(snapshot)
    original = plan['original']
    if {k: v for k, v in actual.items() if k != 'partitions'} != {k: v for k, v in original.items() if k != 'partitions'}:
        raise TargetError('The selected disk identity or geometry changed.')
    existing = {part['node']: part for part in actual['partitions']}
    for part in original['partitions']:
        if existing.pop(part['node'], None) != part:
            raise TargetError('An existing partition changed. Keep this disk untouched.')
    missing = []
    for part in plan['additions']:
        found = existing.pop(part['node'], None)
        if found is None:
            missing.append(part)
        elif found != part:
            raise TargetError('A new partition differs from this installation plan.')
    if existing:
        raise TargetError('Another partition appeared after installation was planned.')
    return missing


def command(*args):
    return subprocess.check_output(list(map(str, args)), text=True, stderr=subprocess.PIPE, timeout=30).strip()


def read_table(device):
    return json.loads(command('sfdisk', '--json', device))


def verify_gpt(fd, total_bytes, table):
    """Require two intact, matching GPT copies before any partition write.

    Disk utilities can silently read a backup after a torn primary write. An
    interrupted metadata write is a recovery case, not permission to repair or
    reinterpret the Mac's partition table during installation.
    """
    sector = 4096
    if total_bytes % sector:
        raise TargetError('Invalid physical disk size.')
    last = total_bytes // sector - 1
    copies = []
    for location, alternate in [(1, last), (last, 1)]:
        raw = os.pread(fd, sector, location * sector)
        if len(raw) != sector:
            raise TargetError('Cannot read both GPT headers.')
        values = struct.unpack('<8sIIIIQQQQ16sQIII', raw[:92])
        magic, revision, size, crc, reserved, current, backup, first, end, identity, entries, count, width, entries_crc = values
        if (magic != b'EFI PART' or revision != 0x10000 or not 92 <= size <= sector or reserved or
                current != location or backup != alternate or count != 128 or width != 128 or
                first != table['firstlba'] or end != table['lastlba'] or
                str(uuid.UUID(bytes_le=identity)) != table['id'] or
                (location == 1 and (entries < 2 or entries + 4 > first)) or
                (location == last and (entries <= end or entries + 4 > last))):
            raise TargetError('The GPT headers do not match the planned disk geometry.')
        header = bytearray(raw[:size])
        header[16:20] = b'\0' * 4
        data = os.pread(fd, count * width, entries * sector)
        if zlib.crc32(header) != crc or len(data) != count * width or zlib.crc32(data) != entries_crc:
            raise TargetError('The GPT is damaged. Recover its metadata before installation.')
        copies.append(data)
    if copies[0] != copies[1]:
        raise TargetError('The GPT copies disagree. Recover its metadata before installation.')


def platform_esp(chosen=Path('/proc/device-tree/chosen/asahi,efi-system-partition')):
    if platform.machine() != 'aarch64' or os.sysconf('SC_PAGESIZE') != 16384:
        raise TargetError('Use the maintained Asahi kernel on Apple Silicon.')
    try:
        raw = chosen.read_bytes()
    except OSError as error:
        raise TargetError('The Asahi firmware did not identify its EFI partition.') from error
    if len(raw) != 37 or raw[-1:] != b'\0':
        raise TargetError('The Asahi firmware did not identify its EFI partition.')
    try:
        return identifier(raw[:-1].decode('ascii'))
    except UnicodeError as error:
        raise TargetError('Invalid Asahi EFI identity.') from error


def owning_disk(data, esp_uuid):
    """Select only the internal disk containing the firmware-identified ESP."""
    esp_uuid = identifier(esp_uuid)
    matches = []
    try:
        for disk in data['blockdevices']:
            if disk['type'] != 'disk' or disk['ro'] not in (False, 0) or disk['rm'] not in (False, 0):
                continue
            for part in disk.get('children', []):
                if part.get('type') == 'part' and str(part.get('partuuid', '')).lower() == esp_uuid:
                    matches.append(disk['name'])
    except (KeyError, TypeError, AttributeError) as error:
        raise TargetError('Incomplete block device inventory.') from error
    if len(matches) != 1:
        raise TargetError('Cannot identify one writable internal disk for this Asahi installation.')
    return matches[0]


def inventory():
    return json.loads(command('lsblk', '--json', '--paths', '--output', 'NAME,TYPE,PARTUUID,RO,RM'))


def discover():
    """Read-only platform handoff; the firmware chooses the owning ESP, never a picker."""
    esp_uuid = platform_esp()
    return new_plan(read_table(owning_disk(inventory(), esp_uuid)), esp_uuid)


def private_file(fd):
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
            stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > 128 * 1024):
        raise TargetError('The saved plan must be a private, owned regular file.')


def private_directory(fd):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise TargetError('Save the plan in a private, owned directory.')


def save_plan(path, plan):
    """Atomically persist before disk writes, including on the FAT boot partition.

    The parent must be private and owned. A persistent advisory lock coordinates
    installer attempts; an interrupted temporary write is never a valid plan.
    No hard links are required, because the Asahi ESP uses FAT.
    """
    validate_plan(plan)
    path = Path(path)
    content = json.dumps(plan, sort_keys=True, indent=2).encode() + b'\n'
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock, temporary = None, None
    try:
        private_directory(directory)
        lock = os.open(path.name + '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=directory)
        private_file(lock)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if os.path.lexists(path):
            raise FileExistsError('An installation plan already exists; load it to resume.')
        fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.rename(temporary, path)
        temporary = None
        os.fsync(directory)
    finally:
        if temporary is not None:
            os.unlink(temporary)
        if lock is not None:
            os.close(lock)
        os.close(directory)
    return hashlib.sha256(content).hexdigest()


def load_plan(path):
    path = Path(path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd = None
    try:
        private_directory(directory)
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        private_file(fd)
        with os.fdopen(fd, 'r') as stream:
            fd = None
            try:
                return validate_plan(json.loads(stream.read(128 * 1024)))
            except (UnicodeError, json.JSONDecodeError) as error:
                raise TargetError('The saved installation plan is incomplete.') from error
    finally:
        if fd is not None:
            os.close(fd)
        os.close(directory)


def lock_disk(fd, timeout=5):
    # udev briefly takes the same lock while probing a changed table. Wait for
    # that normal handoff, but never wait indefinitely for another installer.
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError as error:
            if time.monotonic() >= deadline:
                raise TargetError('The disk is busy. Close other disk tools and try again.') from error
            time.sleep(.05)


def verify_partition_devices(plan):
    """The kernel's writable device nodes must describe the same planned extents."""
    disk = os.stat(plan['original']['device']).st_rdev
    for part in plan['additions']:
        node = os.stat(part['node'], follow_symlinks=False)
        if not stat.S_ISBLK(node.st_mode):
            raise TargetError('An installation partition is not a block device.')
        block = (Path('/sys/dev/block') / f'{os.major(node.st_rdev)}:{os.minor(node.st_rdev)}').resolve(strict=True)
        if (int((block / 'start').read_text()) * 512 != part['start'] * 4096 or
                int((block / 'size').read_text()) * 512 != part['size'] * 4096 or
                (block.parent / 'dev').read_text().strip() != f'{os.major(disk)}:{os.minor(disk)}'):
            raise TargetError('Kernel partition devices differ from the installation plan. Restart before continuing.')


@contextmanager
def locked_plan(path, *, allow_missing=False):
    """Revalidate ownership and hold the disk lock through an installation stage."""
    if platform.system() != 'Linux' or os.geteuid() != 0:
        raise TargetError('Partition preparation requires the Linux installer.')
    if (os.readlink('/proc/self/ns/mnt') == os.readlink('/proc/1/ns/mnt') or
            command('findmnt', '-nro', 'PROPAGATION', '/') != 'private'):
        raise TargetError('Use the installer’s private mount namespace.')
    plan = load_plan(path)
    device = plan['original']['device']
    esp_uuid = platform_esp()
    if esp_uuid != plan['esp_uuid'] or owning_disk(inventory(), esp_uuid) != device:
        raise TargetError('The plan belongs to a different Asahi installation.')
    esp = next(part for part in plan['original']['partitions'] if part['uuid'] == esp_uuid)
    mount = json.loads(command('findmnt', '--json', '--target', path, '--output', 'SOURCE,FSTYPE'))['filesystems'][0]
    if mount['fstype'] != 'vfat' or os.stat(mount['source']).st_rdev != os.stat(esp['node']).st_rdev:
        raise TargetError('Persist the installation plan on its Asahi EFI partition.')
    fd = os.open(device, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        if (not stat.S_ISBLK(os.fstat(fd).st_mode) or command('blockdev', '--getss', device) != '4096'
                or command('blockdev', '--getro', device) != '0'):
            raise TargetError('The planned disk is not a writable 4096-byte-sector block device.')
        lock_disk(fd)
        snapshot = read_table(device)
        verify_gpt(fd, int(command('blockdev', '--getsize64', device)), normalize(snapshot))
        missing = remaining(plan, snapshot)
        if missing and not allow_missing:
            raise TargetError('Prepare the planned Linux partitions before copying Harness.')
        if not allow_missing:
            verify_partition_devices(plan)
        yield plan, fd
    finally:
        os.close(fd)


def apply_plan(path):
    """Append only the persisted plan's missing entries; safe to resume after one write.

    Re-read firmware ownership on every attempt. The plan must be persisted on
    that ESP, mounted with private root-only permissions. This function does not
    create filesystems or update boot files.
    """
    with locked_plan(path, allow_missing=True) as (plan, fd):
        device = plan['original']['device']
        # Revalidate each time. Foreign changes must never be mistaken for
        # resumable progress. The lock also excludes cooperating disk tools.
        for part in plan['additions']:
            snapshot = read_table(device)
            verify_gpt(fd, int(command('blockdev', '--getsize64', device)), normalize(snapshot))
            if part not in remaining(plan, snapshot):
                continue
            number = partition_number(device, part['node'])
            command('sgdisk', f'--new={number}:{part["start"]}:{part["start"] + part["size"] - 1}',
                    f'--typecode={number}:{part["type"]}', f'--partition-guid={number}:{part["uuid"]}',
                    f'--change-name={number}:{part["name"]}', device)
        snapshot = read_table(device)
        verify_gpt(fd, int(command('blockdev', '--getsize64', device)), normalize(snapshot))
        if remaining(plan, snapshot):
            raise TargetError('The planned Linux partitions were not fully created.')
    # An ESP mounted for the journal can prevent a whole-table kernel reread.
    # Update only our two entries, never remove/re-add existing partitions.
    for part in plan['additions']:
        command('partx', '--update', '--nr', partition_number(device, part['node']), device)
    command('udevadm', 'settle', '--timeout=10')
    verify_partition_devices(plan)
    return plan
