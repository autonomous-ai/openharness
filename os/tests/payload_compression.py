#!/usr/bin/env python3
"""Compare compression of one verified OS payload, without changing its contents."""
import argparse
from collections import Counter
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import stat
import statistics
import subprocess
import tempfile
import time


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def inventory(root):
    """Never follow symlinks; compare data and all persistent SquashFS metadata."""
    paths = [root]
    for folder, directories, files in os.walk(root, followlinks=False):
        paths.extend(Path(folder) / name for name in directories + files)
    entries, groups = {}, {}
    for path in sorted(paths):
        info = path.lstat()
        name = path.relative_to(root).as_posix()
        row = dict(mode=info.st_mode, uid=info.st_uid, gid=info.st_gid,
                   mtime=int(info.st_mtime), xattrs={})
        for attribute in sorted(os.listxattr(path, follow_symlinks=False)):
            value = os.getxattr(path, attribute, follow_symlinks=False)
            row['xattrs'][attribute] = hashlib.sha256(value).hexdigest()
        if stat.S_ISREG(info.st_mode):
            row.update(bytes=info.st_size, sha256=digest(path))
            groups.setdefault((info.st_dev, info.st_ino), []).append(name)
        elif stat.S_ISLNK(info.st_mode):
            row['target'] = os.readlink(path)
        elif stat.S_ISCHR(info.st_mode) or stat.S_ISBLK(info.st_mode):
            row['device'] = [os.major(info.st_rdev), os.minor(info.st_rdev)]
        entries[name] = row
    hardlinks = sorted(sorted(group) for group in groups.values() if len(group) > 1)
    return dict(entries=entries, hardlinks=hardlinks)


def compare(expected, actual):
    if expected == actual:
        return None
    names = expected['entries'].keys() | actual['entries'].keys()
    changed = [name for name in sorted(names)
               if expected['entries'].get(name) != actual['entries'].get(name)]
    return dict(changed_paths=changed[:100], changed_path_count=len(changed),
                hardlinks_changed=expected['hardlinks'] != actual['hardlinks'])


def measured(command, folder, label, timeout=900):
    """GNU time covers the command; timeouts stop only this owned process group."""
    metrics = folder / (label + '.time')
    started = time.monotonic()
    with (folder / (label + '.log')).open('wb') as output:
        child = subprocess.Popen(['/usr/bin/time', '-f', '%e %U %S %M', '-o', str(metrics),
                                  *map(str, command)], stdout=output, stderr=subprocess.STDOUT,
                                 start_new_session=True)
        try:
            status = child.wait(timeout=timeout)
        except BaseException:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            raise
    if status:
        detail = (folder / (label + '.log')).read_text(errors='replace')[-4000:]
        raise RuntimeError(f'{label} exited {status}; see {label}.log\n{detail}')
    elapsed, user, system, rss = map(float, metrics.read_text().splitlines()[-1].split())
    return dict(command=list(map(str, command)), wall_seconds=time.monotonic() - started,
                command_seconds=elapsed, user_seconds=user, system_seconds=system,
                peak_rss_kib=int(rss))


def extract(image, target, folder, label):
    # Upstream 4.7's -mem 64M sets each of these queues to 32 MiB. The explicit
    # form also works with Ubuntu 24.04's 4.6.1 tools; compare like with like.
    return measured(['unsquashfs', '-processors', '2', '-data-queue', '32',
                     '-frag-queue', '32', '-no-progress',
                     '-d', target, image], folder, label)


def package_sizes(root):
    result = []
    for desc in sorted((root / 'var/lib/pacman/local').glob('*/desc')):
        fields = {}
        for block in desc.read_text().strip().split('\n\n'):
            lines = block.splitlines()
            if len(lines) >= 2:
                fields[lines[0]] = lines[1:]
        # Installed sizes are ancillary evidence. A package without that field
        # must be reported as unknown, not as zero or a failed filesystem test.
        size = fields.get('%SIZE%') or fields.get('%ISIZE%')
        row = dict(name=fields['%NAME%'][0], bytes=int(size[0]) if size else None)
        if size is None:
            row.update(size_status='not recorded', database_fields=sorted(fields))
        result.append(row)
    return sorted(result, key=lambda row: (row['bytes'] is None, -(row['bytes'] or 0), row['name']))


def tool_versions():
    versions = {}
    for tool in ['mksquashfs', 'unsquashfs', 'xorriso']:
        # unsquashfs 4.6.1 prints its version and exits 1 without an input image.
        probe = subprocess.run([tool, '-version'], stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, timeout=10)
        if probe.returncode not in (0, 1) or not re.search(
                rf'(?im)^{re.escape(tool)} (?:version )?\d+\.\d+', probe.stdout):
            raise RuntimeError(f'Cannot identify {tool}: {probe.returncode}\n{probe.stdout}')
        versions[tool] = dict(output=probe.stdout.strip(), returncode=probe.returncode)
    return versions


def repack(iso, payload, destination, folder, label):
    """Keep the original boot layout while replacing only payload and checksum."""
    # xorriso's documented replay operation must follow file modifications:
    # https://www.gnu.org/software/xorriso/man_1_xorriso.html
    checksum = payload.with_suffix('.sha512')
    with payload.open('rb') as handle:
        checksum.write_text(hashlib.file_digest(handle, 'sha512').hexdigest() + '  airootfs.sfs\n')
    measured(['xorriso', '-no_rc', '-indev', iso, '-outdev', destination,
              '-map', payload, '/arch/x86_64/airootfs.sfs',
              '-map', checksum, '/arch/x86_64/airootfs.sha512',
              '-boot_image', 'any', 'replay'], folder, label)
    measured(['xorriso', '-no_rc', '-indev', destination, '-report_el_torito', 'plain',
              '-report_system_area', 'plain'], folder, label + '-boot-layout')
    return dict(bytes=destination.stat().st_size, sha256=digest(destination))


def compare_native(variants, folder):
    from compression_vm import run_trial
    # Alternate ordering to expose host drift; every row gets a new guest, disk,
    # USB overlay and guest page cache. Host caches remain uncontrolled.
    sequence = [('bios', n) for n in [6, 19, 19, 6, 6, 19]] + [('uefi', 6), ('uefi', 19)]
    result = dict(status='running', sequence=sequence, trials=[], summaries=[],
                  limits=['Fresh 1 GiB guests on one shared native CI host; not physical laptops.',
                          'Guest file caches are dropped after integrity checks, before installation.',
                          'Virtual USB is unthrottled; host page cache is uncontrolled.',
                          'Boot timings include fixture login and readiness probes.',
                          'No models are called; installation and shell input are offline.',
                          'No automatic adoption or publication.'])
    path = folder / 'native-comparison.json'
    try:
        for index, (firmware, level) in enumerate(sequence, 1):
            name = f'{index:02}-{firmware}-level-{level}'
            print('Measuring fresh 1 GiB USB installation: ' + name, flush=True)
            trial = run_trial(variants[level], folder / name, firmware)
            result['trials'].append(dict(level=level, **trial))
            path.write_text(json.dumps(result, indent=2) + '\n')
        for firmware in ['bios', 'uefi']:
            for level in [6, 19]:
                rows = [r for r in result['trials'] if r['firmware'] == firmware and r['level'] == level]
                result['summaries'].append(dict(firmware=firmware, level=level, repetitions=len(rows),
                    median_install_seconds=statistics.median(r['install_receipt']['duration_seconds'] for r in rows),
                    median_live_ready_seconds=statistics.median(r['live_harness_ready_seconds'] for r in rows),
                    median_installed_ready_seconds=statistics.median(r['installed_harness_ready_seconds_including_test_login'] for r in rows),
                    max_install_used_mib=max(r['installation']['peak_used_mib'] for r in rows),
                    max_install_swap_mib=max(r['installation']['peak_swap_used_mib'] for r in rows)))
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        raise
    finally:
        path.write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--output', type=Path, default=Path('os/test-results/compression'))
    parser.add_argument('--vm', action='store_true', help='Compare rebuilt 6/19 with fresh 1 GiB USB installs')
    args = parser.parse_args()
    if platform.system() != 'Linux' or os.geteuid() != 0:
        parser.error('Use root on a disposable native Linux runner to preserve filesystem metadata')
    iso = args.iso.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    if (iso.name != manifest['iso']['name'] or iso.stat().st_size != manifest['iso']['bytes']
            or digest(iso) != args.sha256 or args.sha256 != manifest['iso']['sha256']):
        parser.error('The ISO, manifest, and supplied trusted SHA-256 must all match')
    for tool in ['mksquashfs', 'unsquashfs', 'xorriso', '/usr/bin/time']:
        if not shutil.which(tool):
            parser.error('Missing required tool: ' + tool)
    if args.vm:
        if not os.access('/dev/kvm', os.R_OK | os.W_OK):
            parser.error('The native comparison requires accessible KVM')
        for tool in ['qemu-system-x86_64', 'qemu-img', 'tesseract']:
            if not shutil.which(tool):
                parser.error('Missing native VM tool: ' + tool)
    folder = args.output.resolve()
    folder.parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(folder.parent).free < 18 * 1024**3:
        parser.error('This assessment requires 18 GiB free space after the ISO download')
    folder.mkdir(parents=True, exist_ok=False)
    result = dict(status='running', started_at=time.time(), iso=manifest['iso'],
                  image_source_commit=manifest['source_commit'], profiles=[],
                  runner=dict(platform=platform.platform(), cpu_count=os.cpu_count(),
                              memory=Path('/proc/meminfo').read_text(),
                              cpu=subprocess.check_output(['lscpu'], text=True)),
                  conditions=dict(compression_processors=2, compression_memory='1G',
                                  block_size='1M', extraction_processors=2,
                                  extraction_memory='64M', data_queue_mib=32,
                                  fragment_queue_mib=32, repetitions=3,
                                  cache='Warm/uncontrolled host page cache; no cache flushing',
                                  source_date_epoch=os.environ.get('SOURCE_DATE_EPOCH')),
                  limits=['Host extraction is not a complete installation or boot test.',
                          'The 64 MiB SquashFS cache does not constrain total host memory.',
                          'Published payload may use a different toolchain; use rebuilt level 6 as control.',
                          'No candidate is promoted by this assessment.'])
    try:
        result['test_source_commit'] = subprocess.check_output(
            ['git', '-c', f'safe.directory={Path.cwd()}', 'rev-parse', 'HEAD'], text=True).strip()
        result['tools'] = tool_versions()
        if os.environ.get('SOURCE_DATE_EPOCH'):
            raise RuntimeError('Unset SOURCE_DATE_EPOCH: file timestamps must be preserved for this assessment')
        with tempfile.TemporaryDirectory(prefix='payload-', dir=folder) as temp:
            work = Path(temp)
            original = work / 'original.sfs'
            measured(['xorriso', '-no_rc', '-osirrox', 'on', '-indev', iso,
                      '-extract', '/arch/x86_64/airootfs.sfs', original], folder, 'payload')
            result['published_payload'] = dict(bytes=original.stat().st_size, sha256=digest(original))
            root = work / 'root'
            result['original_extract'] = extract(original, root, folder, 'source-extract')
            expected = inventory(root)
            encoded = canonical(expected)
            with gzip.open(folder / 'filesystem.json.gz', 'wb') as handle:
                handle.write(encoded)
            result['filesystem'] = dict(sha256=hashlib.sha256(encoded).hexdigest(),
                                        paths=len(expected['entries']),
                                        hardlink_groups=len(expected['hardlinks']),
                                        types=dict(Counter(str(stat.S_IFMT(row['mode']))
                                                           for row in expected['entries'].values())))
            result['package_installed_sizes'] = package_sizes(root)
            original.unlink()
            variants = {}
            for level in [6, 15, 19]:
                print(f'Compressing unchanged filesystem at zstd level {level}', flush=True)
                image = work / f'level-{level}.sfs'
                profile = dict(level=level, extractions=[])
                result['profiles'].append(profile)
                profile['compression'] = measured(
                    ['mksquashfs', root, image, '-noappend', '-no-progress', '-comp', 'zstd',
                     '-Xcompression-level', str(level), '-b', '1M', '-processors', '2', '-mem', '1G'],
                    folder, f'compress-{level}')
                profile.update(bytes=image.stat().st_size, sha256=digest(image))
                for repeat in range(1, 4):
                    target = work / f'extracted-{level}-{repeat}'
                    reading = extract(image, target, folder, f'extract-{level}-{repeat}')
                    profile['extractions'].append(reading)
                    difference = compare(expected, inventory(target))
                    reading['filesystem_matches'] = difference is None
                    if difference:
                        reading['difference'] = difference
                        raise RuntimeError(f'Filesystem changed at level {level}, repetition {repeat}')
                    shutil.rmtree(target)
                profile['median_extract_seconds'] = statistics.median(
                    row['command_seconds'] for row in profile['extractions'])
                profile['max_extract_rss_kib'] = max(row['peak_rss_kib'] for row in profile['extractions'])
                if args.vm and level in (6, 19):
                    variants[level] = work / f'level-{level}.iso'
                    profile['repacked_iso'] = repack(iso, image, variants[level], folder, f'iso-{level}')
                image.unlink()
                print(json.dumps({key: value for key, value in profile.items()
                                  if key not in ['compression', 'extractions']}), flush=True)
                (folder / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
            control = result['profiles'][0]
            for row in result['profiles']:
                row['saved_bytes_vs_control'] = control['bytes'] - row['bytes']
                row['saved_percent_vs_control'] = 100 * (1 - row['bytes'] / control['bytes'])
                row['extraction_ratio_vs_control'] = row['median_extract_seconds'] / control['median_extract_seconds']
            if args.vm:
                result['native_comparison'] = compare_native(variants, folder)
            result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        raise
    finally:
        result['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
