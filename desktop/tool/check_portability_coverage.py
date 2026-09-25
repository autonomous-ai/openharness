#!/usr/bin/env python3
"""Require 100% LCOV line coverage of desktop production changes against --base.

Run flutter test --coverage first. In CI, pass the merge base as --base; during
development the default HEAD compares the working tree. Missing file records
fail the check rather than silently shrinking the coverage denominator.
"""
import argparse
from collections import defaultdict
from pathlib import Path
import re
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='HEAD')
    parser.add_argument('--lcov', type=Path, default=Path('desktop/coverage/lcov.info'))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    coverage = defaultdict(dict)
    source = None
    for line in (root / args.lcov).read_text().splitlines():
        if line.startswith('SF:'):
            source = line[3:]
            if source.startswith(str(root / 'desktop') + '/'):
                source = source[len(str(root / 'desktop')) + 1:]
        elif line.startswith('DA:'):
            number, count, *_ = line[3:].split(',')
            coverage[source][int(number)] = coverage[source].get(int(number), 0) + int(count)
    changes = defaultdict(set)
    diff = subprocess.check_output(['git', 'diff', '--no-ext-diff', '--unified=0', args.base, '--', 'desktop/lib'], cwd=root, text=True)
    for line in diff.splitlines():
        if line.startswith('+++ b/desktop/'):
            source = line[len('+++ b/desktop/'):]
        elif line.startswith('@@'):
            match = re.search(r'\+(\d+)(?:,(\d+))?', line)
            start, count = int(match[1]), int(match[2] or 1)
            changes[source].update(range(start, start + count))
    for name in subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard', 'desktop/lib'], cwd=root, text=True).splitlines():
        if name.endswith('.dart'):
            changes[name[len('desktop/'):]].update(range(1, len((root / name).read_text().splitlines()) + 1))
    failed = False
    hit = total = 0
    for source, changed in sorted(changes.items()):
        if not changed:
            continue
        if source not in coverage:
            print(f'MISSING COVERAGE: {source}')
            failed = True
            continue
        executable = changed & coverage[source].keys()
        missing = sorted(number for number in executable if coverage[source][number] == 0)
        total += len(executable)
        hit += len(executable) - len(missing)
        print(f'{source}: {len(executable) - len(missing)}/{len(executable)}' + (f' missing {missing}' if missing else ''))
        failed |= bool(missing)
    print(f'Desktop changed executable lines: {hit}/{total}' + (' (100%)' if total and not failed else ''))
    return 1 if failed or not total else 0


if __name__ == '__main__':
    sys.exit(main())
