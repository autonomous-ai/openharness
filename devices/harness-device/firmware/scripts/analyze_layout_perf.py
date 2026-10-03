#!/usr/bin/env python3
"""Validate a complete two-renderer ESP32 layout run and retain every stage.

Input must contain one BEGIN/END run, filtered from the device's technical log.
No incomplete/watchdog-restarted run is silently presented as a benchmark.
"""
import argparse
import itertools
import json
import re
import statistics
from pathlib import Path


def parse(text, allow_region_change=False):
    lines = [line for line in text.splitlines() if 'layout-bench:' in line]
    if sum('BEGIN 4800' in line for line in lines) != 1 or sum('END complete' in line for line in lines) != 1:
        raise ValueError('Expected exactly one complete 4800-update run')
    if any('CANCEL' in line for line in lines):
        raise ValueError('Physical input cancelled this run')
    blocks, checks = [], []
    block = None
    stages = {'model_us', 'damage_us', 'raster_us', 'total_us', 'pixel_bytes'}
    for line in lines:
        match = re.search(r'BLOCK pass=(\d+) renderer=(\w+) path=(\w+) layout=(\w+) event=(\w+)', line)
        if match:
            block = dict(zip(['pass', 'renderer', 'path', 'layout', 'event'], match.groups()))
            block['pass'] = int(block['pass'])
            block['stages'] = {}
            blocks.append(block)
        match = re.search(r'(model_us|damage_us|raster_us|total_us|pixel_bytes) n=(\d+) min=(\d+) median=(\d+) p95=(\d+) max=(\d+)', line)
        if match:
            if block is None or match[1] in block['stages']:
                raise ValueError('Unpaired or duplicate measurement stage')
            values = dict(zip(['n', 'min', 'median', 'p95', 'max'], map(int, match.groups()[1:])))
            if values['n'] != 40 or not values['min'] <= values['median'] <= values['p95'] <= values['max']:
                raise ValueError('Invalid sample count or percentile ordering')
            block['stages'][match[1]] = values
        if re.search(r'(before|block|after) internal=', line):
            checks.append(line)
    modes = list(dict.fromkeys(b['renderer'] for b in blocks))
    layouts, events, paths = ['straight', 'curved', 'reading'], ['animation', 'name', 'status', 'gaze', 'recap'], ['CPU', 'DMA']
    keys = [(b['pass'], b['renderer'], b['path'], b['layout'], b['event']) for b in blocks]
    expected = set(itertools.product(range(2), modes, paths, layouts, events))
    if len(modes) != 2 or len(keys) != 120 or len(set(keys)) != 120 or set(keys) != expected:
        raise ValueError('Missing, duplicate or unexpected workload blocks')
    if any(set(b['stages']) != stages for b in blocks):
        raise ValueError('Incomplete measurement stages')
    if len(checks) != 6 or any('touches=0 failures=0' not in line for line in checks):
        raise ValueError('Missing memory checkpoints or physical input/read failure')
    memory = [re.search(r'internal=(\d+) largest=(\d+) psram=(\d+)', line).groups() for line in checks]
    if len(set(memory)) != 1:
        raise ValueError('Memory changed during the run; investigate before publishing')
    index = dict(zip(keys, blocks))
    comparisons = []
    for path, layout, event in itertools.product(paths, layouts, events):
        a = [index[(p, modes[0], path, layout, event)]['stages'] for p in range(2)]
        b = [index[(p, modes[1], path, layout, event)]['stages'] for p in range(2)]
        if not allow_region_change and any(a[p]['pixel_bytes'] != b[p]['pixel_bytes'] for p in range(2)):
            raise ValueError(f'Different transferred pixel workload: {path}/{layout}/{event}')
        am = [v['total_us']['median'] for v in a]
        bm = [v['total_us']['median'] for v in b]
        comparisons.append(dict(path=path, layout=layout, event=event,
            baseline_median_us=am, current_median_us=bm,
            baseline_pixel_bytes=[v['pixel_bytes']['median'] for v in a],
            current_pixel_bytes=[v['pixel_bytes']['median'] for v in b],
            less_time_percent=100 * (1 - statistics.mean(bm) / statistics.mean(am))))
    return dict(samples=4800, renderers=modes, blocks=blocks, comparisons=comparisons,
        memory_checkpoints=checks,
        region_change_permitted=allow_region_change,
        scope='Scene construction through final DMA fence, or CPU-only rendering. Excludes event queues, touch sensor, panel scanout and voice. Percentages compare the means of two block medians, not pooled medians; n=40, median midpoint ranks19/20, p95 rank37.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('log', type=Path)
    parser.add_argument('--json', type=Path, required=True)
    parser.add_argument('--allow-region-change', action='store_true',
                        help='Use only after native pixel-equivalence tests verify the smaller dirty regions')
    args = parser.parse_args()
    result = parse(args.log.read_text(), args.allow_region_change)
    args.json.write_text(json.dumps(result, indent=2) + '\n')
    print('baseline/current:', ' / '.join(result['renderers']))
    for row in result['comparisons']:
        if row['layout'] == 'straight':
            continue
        print(f"{row['path']:3} {row['layout']:7} {row['event']:9} "
              f"{row['baseline_median_us']} -> {row['current_median_us']} us; "
              f"{row['less_time_percent']:.1f}% less time")


if __name__ == '__main__':
    main()
