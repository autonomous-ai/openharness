#!/usr/bin/env python3
"""Private one-file ISO derivative and bounded normal-use zram acceptance."""
import argparse
import copy
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

from payload_compression import canonical, compare, digest, extract, inventory as payload_inventory, measured, repack, tool_versions

TARGET = 'etc/systemd/zram-generator.conf'
PAYLOAD = 'arch/x86_64/airootfs.sfs'
CHECKSUM = 'arch/x86_64/airootfs.sha512'


def inventory(root):
    result = payload_inventory(root)
    groups = {}
    for name in result['entries']:
        info = (root / name).lstat()
        if not stat.S_ISDIR(info.st_mode):
            groups.setdefault((info.st_dev, info.st_ino), []).append(name)
    result['hardlinks'] = sorted(sorted(group) for group in groups.values() if len(group) > 1)
    return result


def replace_config(root, candidate):
    path = root / TARGET
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'The configuration must be an ordinary unique file'
    path.write_bytes(candidate)
    os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns))


def expected_payload(before, data):
    expected = copy.deepcopy(before)
    expected['entries'][TARGET].update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
    return expected


def boot_image_digest(iso, lba, blocks):
    offset, remaining = lba * 2048, blocks * 2048
    assert lba >= 0 and blocks > 0 and offset + remaining <= iso.stat().st_size
    digest = hashlib.sha256()
    with iso.open('rb') as handle:
        handle.seek(offset)
        while remaining:
            data = handle.read(min(1024 ** 2, remaining))
            assert data, 'Truncated hidden boot image'
            digest.update(data)
            remaining -= len(data)
    return digest.hexdigest()


def boot_layout(report, iso=None):
    entries, paths, options, addresses, blocks = {}, {}, {}, {}, {}
    catalog = None
    for line in report.splitlines():
        if match := re.match(r'El Torito boot img\s*:\s+(\d+)\s+(.*)', line):
            # LBA changes when the ISO is written again; every other boot
            # entry property (platform, emulation, load segment/size) must not.
            values = match[2].split()
            entries[match[1]], addresses[match[1]] = values[:-1], int(values[-1])
        elif match := re.match(r'El Torito img path\s*:\s+(\d+)\s+(.*)', line):
            paths[match[1]] = match[2].strip().lstrip('/')
        elif match := re.match(r'El Torito img opts\s*:\s+(\d+)\s+(.*)', line):
            options[match[1]] = match[2].split()
        elif match := re.match(r'El Torito img blks\s*:\s+(\d+)\s+(\d+)', line):
            blocks[match[1]] = int(match[2])
        elif match := re.match(r'El Torito cat path\s*:\s+(.*)', line):
            catalog = match[1].strip().lstrip('/')
    assert any('BIOS' in row for row in entries.values()), entries
    assert any('UEFI' in row for row in entries.values()), entries
    hidden = entries.keys() - paths.keys()
    assert paths.keys() <= entries.keys() and hidden <= blocks.keys() and catalog
    assert not hidden or iso is not None, 'The ISO is required to verify hidden boot image bytes'
    hidden_images = {index: dict(blocks=blocks[index], sha256=boot_image_digest(iso, addresses[index], blocks[index]))
                     for index in sorted(hidden)}
    return dict(entries=entries, paths=paths, options=options, catalog=catalog, hidden_images=hidden_images)


def compare_iso(before, after, old_root, new_root, layout):
    assert before['entries'].keys() == after['entries'].keys(), 'ISO paths changed'
    assert before['hardlinks'] == after['hardlinks'], 'ISO hardlinks changed'
    changed = [name for name in before['entries'] if before['entries'][name] != after['entries'][name]]
    patches = {}
    for index, path in layout['paths'].items():
        options = layout['options'].get(index, [])
        ranges = []
        if 'boot-info-table' in options:
            ranges.append((8, 64))
        if 'grub2-boot-info' in options:
            ranges.append((2548, 2556))
        if ranges:
            patches[path] = ranges
    permitted = {PAYLOAD, CHECKSUM, layout['catalog'], *patches}
    assert set(changed) <= permitted, 'Unexpected ISO changes: ' + repr(sorted(set(changed) - permitted))
    assert {PAYLOAD, CHECKSUM} <= set(changed)
    for path in set(changed) & patches.keys():
        old, new = bytearray((old_root / path).read_bytes()), bytearray((new_root / path).read_bytes())
        assert len(old) == len(new)
        # xorriso's documented boot replay may patch only these address fields:
        # https://www.gnu.org/software/xorriso/man_1_xorriso.html
        for start, end in patches[path]:
            old[start:end] = new[start:end] = b'\0' * (end - start)
        assert old == new, 'Boot program changed outside its replay address fields: ' + path
        meta_before = {k: v for k, v in before['entries'][path].items() if k != 'sha256'}
        meta_after = {k: v for k, v in after['entries'][path].items() if k != 'sha256'}
        assert meta_before == meta_after, 'Boot program metadata changed: ' + path
    return dict(changed_paths=sorted(changed), permitted_replay_address_fields=patches,
                all_other_paths_content_and_metadata_identical=True)


def prepare(iso, manifest, candidate, folder, source):
    result = dict(status='running', base_iso=manifest['iso'], image_source_commit=manifest['source_commit'],
                  fixture_source_commit=source, candidate_sha256=digest(candidate), tools=tool_versions())
    path = folder / 'fixture-receipt.json'
    try:
        with tempfile.TemporaryDirectory(prefix='one-file-', dir=folder) as temp:
            work = Path(temp)
            old_iso = work / 'original-iso'
            measured(['xorriso', '-no_rc', '-osirrox', 'on', '-hardlinks', 'on', '-xattr', 'on',
                      '-indev', iso, '-extract', '/', old_iso], folder, 'iso-extract-original')
            original_inventory = inventory(old_iso)
            measured(['xorriso', '-no_rc', '-indev', iso, '-report_el_torito', 'plain',
                      '-report_system_area', 'plain'], folder, 'iso-original-boot-layout')
            original_layout = boot_layout((folder / 'iso-original-boot-layout.log').read_text(), iso)
            root = work / 'root'
            result['original_payload_sha256'] = digest(old_iso / PAYLOAD)
            extract(old_iso / PAYLOAD, root, folder, 'payload-extract')
            before = inventory(root)
            data = candidate.read_bytes()
            result['original_config_sha256'] = before['entries'][TARGET]['sha256']
            replace_config(root, data)
            expected = expected_payload(before, data)
            assert compare(expected, inventory(root)) is None, 'More than the target file content changed'
            payload = work / 'candidate.sfs'
            measured(['mksquashfs', root, payload, '-noappend', '-no-progress', '-comp', 'zstd',
                      '-Xcompression-level', '19', '-b', '1M', '-processors', '2', '-mem', '1G'],
                     folder, 'payload-compress')
            shutil.rmtree(root)
            extracted = work / 'verified-root'
            extract(payload, extracted, folder, 'payload-verify')
            difference = compare(expected, inventory(extracted))
            result['payload_difference'] = difference
            assert difference is None, difference
            for name, value in [('original-filesystem', before), ('candidate-filesystem', expected)]:
                with gzip.open(folder / (name + '.json.gz'), 'wb') as handle:
                    handle.write(canonical(value))
            result['payload'] = dict(sha256=digest(payload), bytes=payload.stat().st_size,
                                    changed_path=TARGET, metadata_unchanged=True,
                                    all_other_paths_and_hardlinks_unchanged=True)
            shutil.rmtree(extracted)
            destination = folder / 'candidate.iso'
            result['iso'] = dict(name=destination.name, **repack(iso, payload, destination, folder, 'iso-candidate'))
            candidate_layout = boot_layout((folder / 'iso-candidate-boot-layout.log').read_text(), destination)
            assert candidate_layout == original_layout, 'Boot entry topology changed'
            result['boot_layout'] = candidate_layout
            new_iso = work / 'candidate-iso'
            measured(['xorriso', '-no_rc', '-osirrox', 'on', '-hardlinks', 'on', '-xattr', 'on',
                      '-indev', destination, '-extract', '/', new_iso], folder, 'iso-extract-candidate')
            candidate_inventory = inventory(new_iso)
            result['iso_difference'] = compare_iso(original_inventory, candidate_inventory, old_iso, new_iso, original_layout)
            for name, value in [('original-iso-filesystem', original_inventory), ('candidate-iso-filesystem', candidate_inventory)]:
                with gzip.open(folder / (name + '.json.gz'), 'wb') as handle:
                    handle.write(canonical(value))
            assert digest(new_iso / PAYLOAD) == result['payload']['sha256']
            with (new_iso / PAYLOAD).open('rb') as handle:
                assert (new_iso / CHECKSUM).read_text() == hashlib.file_digest(handle, 'sha512').hexdigest() + '  airootfs.sfs\n'
        result['status'] = 'passed'
        return result
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        raise
    finally:
        path.write_text(json.dumps(result, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iso', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('os/test-results/zram'))
    args = parser.parse_args()
    assert sys.platform == 'linux' and os.geteuid() == 0, 'Use only the disposable native Linux runner'
    assert os.access('/dev/kvm', os.R_OK | os.W_OK)
    assert not os.environ.get('SOURCE_DATE_EPOCH'), 'Keep every existing filesystem timestamp'
    iso, candidate, folder = args.iso.resolve(), args.config.resolve(), args.output.resolve()
    manifest = json.loads(iso.with_name('manifest.json').read_text())
    assert digest(iso) == args.sha256 == manifest['iso']['sha256']
    assert iso.name == manifest['iso']['name'] and iso.stat().st_size == manifest['iso']['bytes']
    folder.parent.mkdir(parents=True, exist_ok=True)
    assert shutil.disk_usage(folder.parent).free >= 18 * 1024 ** 3
    folder.mkdir(parents=True, exist_ok=False)
    source = subprocess.check_output(['git', '-c', f'safe.directory={Path.cwd()}', 'rev-parse', 'HEAD'], text=True).strip()
    result = dict(status='running', started_at=time.time(), source=source, base_manifest=manifest,
                  scope='Private one-file zram acceptance; not release/publication evidence', trials=[])
    try:
        fixture = prepare(iso, manifest, candidate, folder, source)
        derived = copy.deepcopy(manifest)
        derived['iso'] = fixture['iso']
        derived['validation_fixture'] = dict(source=source, base_iso=manifest['iso'],
                                             base_image_source=manifest['source_commit'],
                                             changed_payload_file=TARGET, candidate_sha256=digest(candidate))
        (folder / 'manifest.json').write_text(json.dumps(derived, indent=2) + '\n')
        for firmware, memory in [('uefi', 1024), ('bios', 2048)]:
            trial = folder / (firmware + '-browser')
            measured([sys.executable, Path(__file__).with_name('browser_vm.py'),
                      '--iso', folder / 'candidate.iso', '--firmware', firmware, '--memory-mib', str(memory),
                      '--live-transport', 'usb', '--interactive-install', '--expected-zram-config', candidate,
                      '--wlrctl', '/usr/bin/wlrctl', '--browser-script', 'os/root/usr/bin/hn-browser',
                      '--compositor-config', 'os/root/usr/share/harness-os/labwc/rc.xml', '--output', trial],
                     folder, firmware + '-normal-browser', timeout=1200)
            result['trials'].append(json.loads((trial / 'receipt.json').read_text()))
            # Discard only this test's large private VM files, retaining evidence.
            for name in ['target.qcow2', 'live-usb.qcow2']:
                (trial / name).unlink()
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        raise
    finally:
        result['finished_at'] = time.time()
        (folder / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
