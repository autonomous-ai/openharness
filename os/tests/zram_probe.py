#!/usr/bin/env python3
"""Finite startup/end probes in the private zram acceptance VM."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess


def check_capacity(meminfo, disksize, swaps, page_bytes):
    memory = {key: int(value) for key, value in re.findall(r'^(\w+):\s+(\d+) kB$', meminfo, re.M)}
    expected = min(memory['MemTotal'] // 1024, 4096) * 1024 ** 2
    assert disksize == expected, (disksize, expected)
    rows = [line.split() for line in swaps.splitlines()[1:] if line.strip()]
    assert len(rows) == 1 and rows[0][0] == '/dev/zram0', rows
    assert int(rows[0][2]) == (expected - page_bytes) // 1024, rows
    return dict(memory_kib=memory, expected_disksize_bytes=expected,
                observed_disksize_bytes=disksize, swap_size_kib=int(rows[0][2]))


def identities():
    result = []
    for path in Path('/proc').iterdir():
        if not path.name.isdecimal():
            continue
        try:
            comm = (path / 'comm').read_text().strip()
            command = (path / 'cmdline').read_text().replace('\0', ' ').rstrip()
            if comm != 'opencode' and command != '/usr/bin/node /usr/lib/harness/cli.mjs start --foreground':
                continue
            stat = (path / 'stat').read_text()
            result.append(dict(pid=int(path.name), start_ticks=int(stat.rsplit(')', 1)[1].split()[19]),
                               role='OpenCode' if comm == 'opencode' else 'Harness daemon', command=command))
        except FileNotFoundError:
            continue
    return sorted(result, key=lambda row: row['pid'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config-sha256', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    assert os.geteuid() == 0
    serial = subprocess.check_output(['lsblk', '-dn', '-o', 'SERIAL', '/dev/vda'], text=True, timeout=5).strip()
    assert serial == 'HN_OS_TEST', 'Only the private VM is permitted'
    config = Path('/etc/systemd/zram-generator.conf').read_bytes()
    assert hashlib.sha256(config).hexdigest() == args.config_sha256
    units = {}
    for unit in ['systemd-zram-setup@zram0.service', 'dev-zram0.swap']:
        units[unit] = subprocess.check_output(['systemctl', 'is-active', unit], text=True, timeout=5).strip()
        assert units[unit] == 'active', units
    result = check_capacity(Path('/proc/meminfo').read_text(),
                            int(Path('/sys/block/zram0/disksize').read_text()),
                            Path('/proc/swaps').read_text(), os.sysconf('SC_PAGE_SIZE'))
    result.update(units=units, config_sha256=args.config_sha256, identities=identities(),
                  oom_kills=int(re.search(r'^oom_kill (\d+)$', Path('/proc/vmstat').read_text(), re.M)[1]))
    if Path('/etc/harness-live').exists():
        spec = importlib.util.spec_from_file_location('installer', '/usr/lib/harness-os/install.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result['preflight_argon_budget_kib'] = module.encryption_memory()
    args.output.write_text(json.dumps(result) + '\n')


if __name__ == '__main__':
    main()
