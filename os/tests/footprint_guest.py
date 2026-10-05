#!/usr/bin/env python3
"""Read-only footprint samples inside a disposable installed Harness guest."""
import argparse
import json
import os
from pathlib import Path
import statistics
import subprocess
import time


def fields(text):
    return {name.rstrip(':'): int(value.split()[0])
            for name, value in (line.split(':', 1) for line in text.splitlines() if ':' in line)}


def cpu(text):
    # guest/guest_nice are already included in user/nice; never count them twice.
    values = list(map(int, text.splitlines()[0].split()[1:9]))
    if len(values) != 8:
        raise ValueError('Incomplete aggregate CPU counters')
    return sum(values), values[3] + values[4]


def cpu_busy(before, after):
    total = after[0] - before[0]
    idle = after[1] - before[1]
    if total <= 0 or not 0 <= idle <= total:
        raise ValueError('Invalid CPU counter interval')
    return round(100 * (total - idle) / total, 3)


def memory(text):
    value = fields(text)
    total, available = value['MemTotal'], value['MemAvailable']
    if not 0 <= available <= total or not 0 <= value['SwapFree'] <= value['SwapTotal']:
        raise ValueError('Invalid memory counters')
    return dict(total_kib=total, available_kib=available, used_kib=total - available,
                swap_used_kib=value['SwapTotal'] - value['SwapFree'])


def process_groups():
    groups, vanished = {}, 0
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            name = (entry / 'comm').read_text().strip()
            # Aggregate equal names, including all OpenCode/browser children.
            data = fields((entry / 'smaps_rollup').read_text())
        except (FileNotFoundError, ProcessLookupError):
            vanished += 1
            continue
        row = groups.setdefault(name, dict(processes=0, rss_kib=0, pss_kib=0, swap_pss_kib=0))
        row['processes'] += 1
        row['rss_kib'] += data['Rss']
        row['pss_kib'] += data['Pss']
        row['swap_pss_kib'] += data.get('SwapPss', 0)
    return dict(groups=groups, processes_without_userspace_map=vanished)


def package_fields(text):
    result, key = {}, None
    for line in text.splitlines():
        if line.startswith('%') and line.endswith('%'):
            key = line[1:-1]
            result[key] = []
        elif line and key:
            result[key].append(line)
    return result


def package_row(text):
    value = package_fields(text)
    # SIZE is optional (notably for metapackages). Preserve an absent value as
    # unrecorded rather than inventing measured savings or rejecting the sample.
    # https://man.archlinux.org/man/alpm-db-desc.5.en#%SIZE%
    size = int(value['SIZE'][0]) if value.get('SIZE') else None
    if size is not None and size < 0:
        raise ValueError('Negative installed package size')
    row = dict(name=value['NAME'][0], version=value['VERSION'][0],
               uncompressed_bytes=size, explicit=value.get('REASON', ['0']) == ['0'],
               depends=value.get('DEPENDS', []))
    if size is None:
        row.update(size_status='not recorded', database_fields=sorted(value))
    return row


def inventory():
    packages = []
    for path in Path('/var/lib/pacman/local').glob('*/desc'):
        packages.append(package_row(path.read_text()))
    packages.sort(key=lambda row: (row['uncompressed_bytes'] is None,
                                   -(row['uncompressed_bytes'] or 0), row['name']))
    usage = os.statvfs('/')
    directories = subprocess.run(['du', '-x', '-B1', '-d', '2', '/usr', '/var', '/opt'],
                                 capture_output=True, text=True, timeout=120, check=True).stdout
    return dict(packages=packages, directory_allocated_bytes=directories,
                root_used_bytes_including_home_and_snapshots=(usage.f_blocks-usage.f_bfree)*usage.f_frsize,
                package_size_note='Pacman SIZE is logical/uncompressed; do not equate it with compressed Btrfs savings.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=['agent-workspace', 'terminal-only', 'browser'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if (os.getuid() != 0 or Path('/etc/harness-live').exists() or
            not Path('/run/harness-footprint-disposable').is_file() or
            not Path('/var/lib/harness-os/install.json').is_file()):
        parser.error('Run only as root in the marked disposable installed VM')
    result = dict(status='running', phase=args.phase, started_at=time.time(), samples=[],
                  observer_pid=os.getpid(), note='Observer and diagnostic serial login are included. PSS apportions shared pages.')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        # Match settling and sample duration across states; no cache dropping.
        time.sleep(20)
        previous = cpu(Path('/proc/stat').read_text())
        for _ in range(10):
            time.sleep(2)
            current = cpu(Path('/proc/stat').read_text())
            row = dict(at=time.time(), memory=memory(Path('/proc/meminfo').read_text()),
                       cpu_busy_percent=cpu_busy(previous, current), **process_groups())
            opencode = row['groups'].get('opencode', {}).get('processes', 0)
            browser = row['groups'].get('chromium', {}).get('processes', 0)
            if args.phase == 'agent-workspace' and not opencode:
                raise RuntimeError('OpenCode is absent from the working-state sample')
            if args.phase != 'agent-workspace' and opencode:
                raise RuntimeError('The agent is still running in an agent-free sample')
            if args.phase == 'browser' and not browser:
                raise RuntimeError('Chromium is absent from the browser sample')
            if args.phase != 'browser' and browser:
                raise RuntimeError('Unexpected browser in a terminal/agent sample')
            result['samples'].append(row)
            previous = current
        result.update(status='passed', median_used_mib=statistics.median(
            row['memory']['used_kib'] / 1024 for row in result['samples']),
            median_cpu_busy_percent=statistics.median(row['cpu_busy_percent'] for row in result['samples']),
            median_swap_used_mib=statistics.median(row['memory']['swap_used_kib'] / 1024 for row in result['samples']))
        if args.phase == 'terminal-only':
            result['inventory'] = inventory()
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        raise
    finally:
        result['finished_at'] = time.time()
        args.output.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
