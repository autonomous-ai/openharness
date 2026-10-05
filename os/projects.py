#!/usr/bin/env python3
"""Prepare the OS project root and reserve a per-agent folder without collisions."""
import argparse
from datetime import datetime
from pathlib import Path
import re
import unicodedata


def prepare(home=None):
    home = Path.home() if home is None else Path(home)
    root, legacy = home / 'projects', home / 'Projects'
    # Keep old terminal/session paths working after the capitalization change.
    # Two existing directories are never silently merged or replaced.
    if not root.exists() and not root.is_symlink() and legacy.is_dir() and not legacy.is_symlink():
        legacy.rename(root)
        legacy.symlink_to('projects', target_is_directory=True)
    root.mkdir(parents=True, exist_ok=True)
    return root


def new_project(label='opencode', home=None, at=None):
    root = prepare(home)
    at = at or datetime.now()
    # Match cli/src/lib/agentNames.ts: label-date-time; seconds on collision.
    label = re.sub(r'[^a-z0-9]+', '-', unicodedata.normalize('NFKD', label).lower()).strip('-') or 'harness'
    minute, precise = label + at.strftime('-%Y-%m-%d-%H-%M'), label + at.strftime('-%Y-%m-%d-%H-%M-%S')
    attempt = 0
    while True:
        name = minute if attempt == 0 else precise if attempt == 1 else f'{precise}-{attempt}'
        folder = root / name
        try:
            folder.mkdir()
            return folder
        except FileExistsError:
            attempt += 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'new'])
    parser.add_argument('label', nargs='?', default='opencode')
    args = parser.parse_args()
    print(new_project(args.label) if args.action == 'new' else prepare())
