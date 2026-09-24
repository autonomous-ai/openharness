#!/usr/bin/env python3
"""Pool verified observations while retaining failed trials and censored timings."""
import argparse
from collections import defaultdict
import json
import math
from pathlib import Path


def distribution(values):
    values = sorted(values)
    result = {'samples': len(values)}
    for name, quantile in [('p50Ms', .5), ('p95Ms', .95), ('p99Ms', .99)]:
        result[name] = values[math.ceil(len(values) * quantile) - 1] if values else None
    result['maxMs'] = values[-1] if values else None
    for limit in (50, 100, 250, 1000):
        result[f'over{limit}Ms'] = sum(value > limit for value in values)
    return result


def verified(row, route):
    before, after = row['routeBefore'], row['routeAfter']
    wire, other = ('relay', 'p2p') if route == 'relay' else ('p2p', 'relay')
    if before['route'] != route or after['route'] != route:
        return False
    if before['migrating'] or after['migrating'] or before['pair'] != after['pair']:
        return False
    if route != 'relay':
        pair = before['pair']
        if not before['ready'] or not after['ready'] or not pair:
            return False
        actual = 'turn' if 'relay' in (pair['local']['type'], pair['remote']['type']) else 'p2p'
        if actual != route:
            return False
    return (after['sent'][wire] - before['sent'][wire] == 1
            and after['received'][wire] > before['received'][wire]
            and after['sent'][other] == before['sent'][other]
            and after['received'][other] == before['received'][other])


def summarize(directory):
    plan = json.loads((directory / 'plan.json').read_text())
    groups = defaultdict(lambda: {'trials': [], 'workloads': defaultdict(list),
                                 'controls': [], 'failedControls': 0, 'failedEchoes': defaultdict(int)})
    missing = []
    for trial in plan['trials']:
        path = directory / trial['file']
        if not path.exists():
            missing.append(path.name)
            continue
        data = json.loads(path.read_text())
        route = trial['route']
        if (data.get('schema') != 4 or data['requestedRoute'] != route
                or data['label'] != trial['label'] or data['sourceRevision'] != plan['sourceRevision']):
            raise ValueError(f'Metadata mismatch: {path.name}')
        if data['samplesPerWorkload'] != plan['samplesPerWorkload'] or data['controlSamples'] != plan['controlSamples']:
            raise ValueError(f'Workload mismatch: {path.name}')
        cleanup = data['cleanup']
        if (cleanup.get('created') or cleanup.get('agentId') or data['success']) and not cleanup.get('deleted'):
            raise ValueError(f'Unconfirmed cleanup: {path.name}')
        group = groups[(trial['label'], route)]
        successes = defaultdict(list)
        for row in data['observations']:
            if row['phase'] != 'measured':
                continue
            if row.get('success') and row.get('routeVerified'):
                if not verified(row, route) or not math.isfinite(row['elapsedMs']) or row['elapsedMs'] < 0:
                    raise ValueError(f'Invalid accepted observation: {path.name}')
                successes[row['load']].append(row['elapsedMs'])
                group['workloads'][row['load']].append(row['elapsedMs'])
            else:
                group['failedEchoes'][row['load']] += 1
        for row in data['controlObservations']:
            if row['phase'] != 'measured':
                continue
            if row['success']:
                group['controls'].append(row['elapsedMs'])
            else:
                group['failedControls'] += 1
        if data['success']:
            if any(len(successes[load]) != data['samplesPerWorkload'] for load in ['idle', 'redraw_20hz']):
                raise ValueError(f'Incomplete successful trial: {path.name}')
            controls = [row for row in data['controlObservations'] if row['phase'] == 'measured']
            if len(controls) != data['controlSamples'] or not all(row['success'] for row in controls):
                raise ValueError(f'Incomplete successful controls: {path.name}')
        group['trials'].append({
            'file': path.name, 'success': data['success'],
            'routeAvailable': data.get('routeAtStart', {}).get('route') == route,
            'cleanupDeleted': cleanup.get('deleted', False),
            'error': data.get('error'), 'stagesMs': data['stagesMs'],
            'reattach': data.get('reattach'),
            'workloads': {load: distribution(values) for load, values in successes.items()},
            'achieved': {load: data.get(load + 'Achieved') for load in ['idle', 'redraw_20hz']},
        })
    cells = []
    for (label, route), group in sorted(groups.items()):
        cells.append({
            'label': label, 'route': route, 'attempts': len(group['trials']),
            'completedTrials': sum(row['success'] for row in group['trials']),
            'routeAvailableTrials': sum(row['routeAvailable'] for row in group['trials']),
            'trials': group['trials'],
            'workloads': {load: {**distribution(group['workloads'][load]),
                                 'failedEchoes': group['failedEchoes'][load]}
                          for load in ['idle', 'redraw_20hz']},
            'controls': {**distribution(group['controls']), 'failures': group['failedControls']},
        })
    return {'sourceRevision': plan['sourceRevision'], 'plannedTrials': len(plan['trials']),
            'missingTrials': missing, 'cells': cells}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--allow-partial', action='store_true', help='Inspect progress without claiming a complete matrix')
    args = parser.parse_args()
    result = summarize(args.directory)
    if result['missingTrials'] and not args.allow_partial:
        parser.error('Incomplete matrix: ' + ', '.join(result['missingTrials']))
    print(json.dumps(result, indent=2))
