#!/usr/bin/env python3
"""Run real terminal route trials serially; preserve every attempt and its log."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', action='append', required=True, help='public-label=private-machine-id')
    parser.add_argument('--output-dir', required=True, type=Path)
    parser.add_argument('--node', default='node')
    parser.add_argument('--samples', type=int, default=200)
    parser.add_argument('--control-samples', type=int, default=30)
    parser.add_argument('--repetitions', type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.repetitions <= 10:
        parser.error('repetitions must be 1–10')
    if not 1 <= args.samples <= 2000 or not 1 <= args.control_samples <= 500:
        parser.error('sample counts out of range')
    targets = []
    for value in args.target:
        label, separator, machine = value.partition('=')
        if not separator or not re.fullmatch(r'[a-z][a-z0-9-]*', label) or not machine:
            parser.error('target must be a safe public-label=machine-id')
        if any(label == existing[0] for existing in targets):
            parser.error('target labels must be unique')
        targets.append((label, machine))
    cli = Path(__file__).resolve().parent.parent
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=cli, text=True).strip()
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD', '--',
                    'scripts/benchmark-terminal-latency.mts', 'scripts/benchmark-route.ts'],
                   cwd=cli, check=True, stdout=subprocess.DEVNULL)
    # Refuse reuse before opening any remote terminal. Logs may identify machines.
    args.output_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.umask(0o077)
    routes = ['p2p', 'turn', 'relay']
    plan = []
    for repetition in range(1, args.repetitions + 1):
        order = targets if repetition % 2 else list(reversed(targets))
        for label, machine in order:
            offset = (repetition - 1 + targets.index((label, machine))) % len(routes)
            for route in routes[offset:] + routes[:offset]:
                plan.append((label, machine, route, repetition))
    public_plan = [{'label': label, 'route': route, 'repetition': repetition,
                    'file': f'{label}-{route}-{repetition}.json'} for label, _, route, repetition in plan]
    (args.output_dir / 'plan.json').write_text(json.dumps({
        'schema': 1, 'sourceRevision': revision, 'samplesPerWorkload': args.samples,
        'controlSamples': args.control_samples, 'trials': public_plan,
    }, indent=2) + '\n')
    for index, (label, machine, route, repetition) in enumerate(plan):
        stem = f'{label}-{route}-{repetition}'
        output = args.output_dir / (stem + '.json')
        print(json.dumps({'event': 'start', 'trial': index + 1, 'of': len(plan), 'case': stem}), flush=True)
        command = [args.node, '--import', 'tsx', 'scripts/benchmark-terminal-latency.mts',
                   '--machine', machine, '--label', label, '--route', route,
                   '--samples', str(args.samples), '--control-samples', str(args.control_samples),
                   '--revision', revision, '--output', str(output)]
        with (args.output_dir / (stem + '.log')).open('x') as log:
            process = subprocess.Popen(command, cwd=cli, stdout=log, stderr=subprocess.STDOUT)
            try:
                code = process.wait(timeout=900)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                # Give the probe its full cleanup window; never kill other sessions.
                process.terminate()
                try:
                    process.wait(timeout=45)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                raise RuntimeError(f'{stem}: interrupted; inspect its private log and cleanup before continuing')
        if not output.exists():
            raise RuntimeError(f'{stem}: no artifact (exit {code}); inspect private log')
        result = json.loads(output.read_text())
        cleanup = result.get('cleanup', {})
        if cleanup.get('created') and not cleanup.get('deleted'):
            raise RuntimeError(f'{stem}: cleanup failed; stop before creating another terminal')
        if code not in (0, 1):
            raise RuntimeError(f'{stem}: unexpected exit {code}; inspect artifact')
        print(json.dumps({'event': 'finished', 'case': stem, 'success': result['success'],
                          'cleanupDeleted': cleanup.get('deleted', False),
                          'samples': sum(row['samples'] for row in result['summaries']),
                          'routeAtStart': result.get('routeAtStart', {}).get('route')}), flush=True)
    print(json.dumps({'event': 'complete', 'attempts': len(plan)}), flush=True)


if __name__ == '__main__':
    main()
