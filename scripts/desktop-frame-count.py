"""Counts the frames a Harness Desktop log received, by type.

Usage: python3 -I scripts/desktop-frame-count.py ~/.harness/logs/app-YYYYMMDD.log

Reads lines like `[YYYY-MM-DD HH:MM:SS] DEBUG ws      ↓ <type> {...}` and prints the window, the total of received
(↓) frames and, per type, its count, share and logged bytes (values in the log are cut, so bytes understate large
payloads); then the median gap between `swarm_changed` frames, and each `agent_synced` against the one before it for
the same agent: first, identical, differing only in `activity`, or other. Measures
docs/plans/2026-10-31-live-events-relay-design.md before and after.
"""
import collections
import re
import statistics
import sys
from datetime import datetime

LINE = re.compile(r'^\[(\S+ \S+)\] DEBUG ws\s+(\S)\s+([a-z_]+)\s?(.*)$')
AGENT_ID = re.compile(r'^\{agent: \{id: ([^,}]+)')


ACTIVITY = re.compile(r'(?:(?<=\{)|(?<=, ))activity: ')


def without_activity(text):
    """The logged agent with its `activity: …` entry removed (a value is `null` or one `{…}`, possibly nested). Only an
    entry's own key matches: a title like "Reactivity: tests" does not."""
    found = ACTIVITY.search(text)
    if not found:
        return text
    at = found.start()
    end = found.end()
    if text.startswith('{', end):
        depth = 0
        while end < len(text):
            depth += {'{': 1, '}': -1}.get(text[end], 0)
            end += 1
            if depth == 0:
                break
    else:
        while end < len(text) and text[end] not in ',}':
            end += 1
    if text.startswith(', ', end):
        end += 2
    return text[:at] + text[end:]


def main(path):
    count, size, directions = collections.Counter(), collections.Counter(), collections.Counter()
    changed_at, synced = [], collections.Counter()
    last_agent = {}
    first = last = None
    with open(path, 'rb') as log:
        for raw in log:
            match = LINE.match(raw.decode('utf-8', 'replace').rstrip('\n'))
            if not match:
                continue
            at, direction, kind, rest = match.groups()
            directions[direction] += 1
            if direction != '↓':
                continue
            first = first or at
            last = at
            count[kind] += 1
            size[kind] += len(rest.encode())
            if kind == 'swarm_changed':
                changed_at.append(datetime.strptime(at, '%Y-%m-%d %H:%M:%S'))
            elif kind == 'agent_synced':
                agent = AGENT_ID.match(rest)
                key = agent.group(1) if agent else None
                before = last_agent.get(key)
                if before is None:
                    synced['first'] += 1
                elif before == rest:
                    synced['identical'] += 1
                elif without_activity(before) == without_activity(rest):
                    synced['activity only'] += 1
                else:
                    synced['other'] += 1
                last_agent[key] = rest
    total, total_bytes = sum(count.values()), sum(size.values())
    print('window', first, '->', last, '| directions', dict(directions))
    print('received frames', total, 'logged bytes (cut)', total_bytes)
    for kind, n in count.most_common(25):
        print(f'{n:8d} {100 * n / total:5.1f}%  {size[kind]:10d}B  {kind}')
    if len(changed_at) > 1:
        gaps = [(b - a).total_seconds() for a, b in zip(changed_at, changed_at[1:])]
        print(f'swarm_changed: median gap {statistics.median(gaps):.2f} s (log times are whole seconds)')
    if synced:
        print('agent_synced:', ', '.join(f'{kind} {synced[kind]}' for kind in ('first', 'identical', 'activity only', 'other')))


if __name__ == '__main__':
    main(sys.argv[1])
