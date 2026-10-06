#!/usr/bin/env python3
"""One read-only memory snapshot in the marked disposable browser VM."""
import argparse
import json
import os
from pathlib import Path
import time


def read(path):
    try:
        return path.read_text(errors='replace')
    except OSError as error:
        return {'error': type(error).__name__, 'errno': error.errno}


def snapshot(proc=Path('/proc'), sys=Path('/sys')):
    started = time.monotonic()
    result = dict(at=time.time(), observer_pid=os.getpid(), processes=[],
                  meminfo=read(proc / 'meminfo'), vmstat=read(proc / 'vmstat'),
                  cpu=read(proc / 'stat'), uptime=read(proc / 'uptime'),
                  pressure={kind: read(proc / 'pressure' / kind) for kind in ['memory', 'cpu', 'io']},
                  swaps=read(proc / 'swaps'), zram={},
                  swappiness=read(proc / 'sys/vm/swappiness'),
                  zswap={p.name: read(p) for p in (sys / 'module/zswap/parameters').glob('*')})
    for device in (sys / 'block').glob('zram*'):
        result['zram'][device.name] = {name: read(device / name) for name in
            ['disksize', 'mm_stat', 'stat', 'io_stat', 'bd_stat', 'comp_algorithm']}
    for entry in sorted(proc.iterdir(), key=lambda item: item.name):
        if not entry.name.isdecimal():
            continue
        # Preserve the entire rollup, including Pss and SwapPss. RSS alone
        # can make a heavily swapped agent look like a small process.
        row = dict(pid=int(entry.name), comm=read(entry / 'comm'),
                   cmdline=read(entry / 'cmdline'), status=read(entry / 'status'),
                   stat=read(entry / 'stat'), cgroup=read(entry / 'cgroup'),
                   smaps_rollup=read(entry / 'smaps_rollup'))
        if isinstance(row['cmdline'], str):
            row['cmdline'] = row['cmdline'].replace('\0', ' ').rstrip()
        result['processes'].append(row)
    result['duration_seconds'] = time.monotonic() - started
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if (os.getuid() != 0 or Path('/etc/harness-live').exists() or
            not Path('/run/harness-browser-memory-disposable').is_file() or
            not Path('/var/lib/harness-os/install.json').is_file()):
        parser.error('Run only as root in the marked disposable installed VM')
    result = snapshot()
    result['phase'] = args.phase
    args.output.write_text(json.dumps(result) + '\n')


if __name__ == '__main__':
    main()
