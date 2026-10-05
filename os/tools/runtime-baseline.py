#!/usr/bin/env python3
"""Record published versions already contained in a source-built OS runtime."""
import json
from pathlib import Path
import re
import subprocess


def baselines(source):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(source), *args], text=True).strip()
    if git('rev-parse', '--is-shallow-repository') != 'false':
        raise ValueError('Runtime builds require full Git history and release tags (fetch-depth: 0).')
    result = {}
    for component, suffix in [('hn', 'tui'), ('cli', 'cli')]:
        tags = git('tag', '--merged', 'HEAD', '--list', f'v*_{suffix}').splitlines()
        candidates = []
        for tag in tags:
            match = re.fullmatch(r'v(\d{1,8}\.\d{1,8}\.\d{1,8})_' + suffix, tag)
            if match:
                candidates.append((tuple(map(int, match[1].split('.'))), tag, match[1]))
        if candidates:
            _, tag, version = max(candidates)
            result[component] = {'version': version, 'commit': git('rev-parse', tag + '^{commit}')}
    return result


if __name__ == '__main__':
    print(json.dumps(baselines(Path(__file__).resolve().parents[2])))
