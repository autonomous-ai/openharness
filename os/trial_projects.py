#!/usr/bin/env python3
"""Copy saved USB projects as their owner, without copying the live account."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat


def walk_error(error):
    raise error


def transfer(source, destination):
    """Symlinks stay symlinks; special files and changing files stop the transfer."""
    if source.is_symlink() or not source.is_dir():
        raise ValueError('The USB Projects folder must be an ordinary directory.')
    entries, total = {}, 0
    for folder, directories, files in os.walk(source, followlinks=False, onerror=walk_error):
        parent = Path(folder)
        relative = parent.relative_to(source)
        target = destination / relative
        target.mkdir(parents=True, exist_ok=True)
        # Do not walk linked directories or follow links out of the project tree.
        for name in sorted(directories + files):
            path = parent / name
            info = path.lstat()
            key = path.relative_to(source).as_posix()
            output = target / name
            if stat.S_ISLNK(info.st_mode):
                link = os.readlink(path)
                output.symlink_to(link, target_is_directory=name in directories)
                entries[key] = {'link': link}
                if name in directories:
                    directories.remove(name)
            elif stat.S_ISDIR(info.st_mode):
                output.mkdir(exist_ok=True)
            elif stat.S_ISREG(info.st_mode):
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, 'rb') as reader:
                    before = os.fstat(reader.fileno())
                    if not stat.S_ISREG(before.st_mode):
                        raise ValueError(f'Project file changed type: {key}')
                    sha = hashlib.sha256()
                    with output.open('xb') as writer:
                        while chunk := reader.read(1024 * 1024):
                            writer.write(chunk)
                            sha.update(chunk)
                    after = os.fstat(reader.fileno())
                    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                        raise ValueError(f'Project is still changing; stop its writes and retry installation: {key}')
                output.chmod(stat.S_IMODE(before.st_mode) & 0o777)
                os.utime(output, ns=(before.st_atime_ns, before.st_mtime_ns))
                # Check what reached the new disk, not only the bytes read from USB.
                with output.open('rb') as written:
                    if hashlib.file_digest(written, 'sha256').hexdigest() != sha.hexdigest():
                        raise ValueError(f'Project verification failed: {key}')
                entries[key] = {'bytes': before.st_size, 'sha256': sha.hexdigest()}
                total += before.st_size
            else:
                raise ValueError(f'Close the service using this project before installing: {key}')
    # Apply directory metadata after populating them, including read-only directories.
    for folder, directories, _ in os.walk(source, topdown=False, followlinks=False, onerror=walk_error):
        path = Path(folder)
        output = destination / path.relative_to(source)
        info = path.stat()
        output.chmod(stat.S_IMODE(info.st_mode) & 0o777)
        os.utime(output, ns=(info.st_atime_ns, info.st_mtime_ns))
    encoded = json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()
    return {'files': len(entries), 'bytes': total, 'sha256': hashlib.sha256(encoded).hexdigest(), 'entries': entries}


def size(source):
    if source.is_symlink() or not source.is_dir():
        raise ValueError('The USB Projects folder must be an ordinary directory.')
    total = 0
    for folder, directories, files in os.walk(source, followlinks=False, onerror=walk_error):
        for name in directories + files:
            path = Path(folder) / name
            info = path.lstat()
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
            elif not (stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                raise ValueError('A trial project contains an active socket or special file. Stop that service before installing.')
    return total


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['size', 'copy'])
    parser.add_argument('source', type=Path)
    parser.add_argument('--destination-fd', type=int)
    args = parser.parse_args()
    if args.action == 'size':
        print(json.dumps({'bytes': size(args.source)}))
        return
    if args.destination_fd is None:
        parser.error('copy requires a destination directory descriptor')
    os.fchdir(args.destination_fd)
    os.close(args.destination_fd)
    print(json.dumps(transfer(args.source, Path('.'))))


if __name__ == '__main__':
    main()
