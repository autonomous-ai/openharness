#!/usr/bin/env python3
"""Validate complete on-device transport benchmark blocks and retain all quantiles."""
import argparse
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser()
parser.add_argument('log', type=Path)
parser.add_argument('--json', type=Path, required=True)
args = parser.parse_args()
text = args.log.read_text().replace('\0', '')
result = {'units': 'microseconds', 'scope': 'Local CPU work only; excludes USB, queues and desktop'}
for tag, modes, sizes, chunks, samples in (
    ('transport-bench', ('bitwise91', 'nibble92', 'rom92'), (0, 4, 48, 84, 324, 1028, 4100, 8196), None, 1920),
    ('transport-decode', ('original91', 'rom-block93'), (48, 320, 1024, 4096, 8192), (1, 64, 512, 8200), 3200),
):
    lines = [line for line in text.splitlines() if tag + ':' in line]
    if not lines:
        continue
    assert sum('BEGIN ' in line for line in lines) == 1, (tag, 'expected one BEGIN')
    assert sum('END internal=' in line for line in lines) == 1, (tag, 'expected one END')
    rows = []
    for line in lines:
        match = re.search(r'pass=(\d) mode=(\S+) bytes=(\d+)(?: chunk=(\d+))? n=(\d+) min=(\d+) median=(\d+) p95=(\d+) max=(\d+)', line)
        if not match:
            continue
        row = {'pass': int(match[1]), 'mode': match[2], 'bytes': int(match[3]),
               'chunk': int(match[4]) if match[4] else None}
        row.update(zip(('n', 'min', 'median', 'p95', 'max'), (int(match[i]) for i in range(5, 10))))
        assert row['n'] == 40 and row['min'] <= row['median'] <= row['p95'] <= row['max'], row
        rows.append(row)
    expected = {(p, m, size, chunk) for p in range(2) for m in modes for size in sizes for chunk in (chunks or (None,))}
    seen = [(r['pass'], r['mode'], r['bytes'], r['chunk']) for r in rows]
    assert len(seen) == len(set(seen)) and set(seen) == expected, (tag, 'missing or duplicate block')
    assert sum(r['n'] for r in rows) == samples
    heap = re.search(r'END internal=(\d+)/(\d+)', '\n'.join(lines))
    assert heap and heap[1] == heap[2], (tag, 'heap changed')
    result[tag] = {'samples': samples, 'stable_internal_bytes': int(heap[1]), 'blocks': rows}
assert 'transport-bench' in result, 'No complete CRC run'
args.json.write_text(json.dumps(result, indent=2) + '\n')
for tag in ('transport-bench', 'transport-decode'):
    if tag in result:
        print(f"{tag}: {result[tag]['samples']} samples, complete two-pass blocks, stable heap PASS")
