#!/usr/bin/env python3
"""Record published versions already contained in a source-built OS runtime."""
import json
from pathlib import Path
import re
import subprocess
import sys


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


def cli_version(source):
    """What the CLI built from this source calls itself: the newest published CLI it contains.

    package.json keeps a development version (0.0.1) and a release takes its number from its tag,
    so a CLI built for the OS from the same source said 0.0.1 everywhere — the phone, `harness
    version`, the account — while it carries every release up to that one. With none published
    yet (a fork, a test repository), the development version.
    """
    published = baselines(source).get('cli', {}).get('version')
    return published or json.loads((Path(source) / 'cli/package.json').read_text())['version']


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[2]
    if sys.argv[1:] == ['--cli-version']:
        print(cli_version(root))
    else:
        print(json.dumps(baselines(root)))
