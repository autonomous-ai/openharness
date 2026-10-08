#!/usr/bin/env python3
"""Prepare the OS project root and reserve a per-agent folder without collisions."""
import argparse
from datetime import datetime
import os
from pathlib import Path
import re
import stat
import tempfile
import unicodedata

CONNECTION_HINT = """<!-- harness-os-connections -->
## Connected accounts on this computer

Read `/usr/share/harness-os/connections.md` when a task involves connected
services. `harness connections list --json` discovers this user's accounts;
`harness connections` opens the local settings page. Any agent can use the
same helper. Keep credentials out of chat, project files and agent settings.
<!-- /harness-os-connections -->
"""


def connection_instructions(root):
    # A small pointer stays current with the packaged guide. Keep user-authored
    # instructions, including symlinked files, untouched except for an append.
    for name in ("AGENTS.md", "CLAUDE.md"):
        path = root / name
        if path.is_symlink():
            continue
        try:
            if path.exists() and (not stat.S_ISREG(path.stat().st_mode) or path.stat().st_size > 1024 * 1024):
                continue
            original = path.read_text() if path.exists() else ""
            if "<!-- harness-os-connections -->" in original:
                continue
            mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
            fd, temporary = tempfile.mkstemp(prefix=".harness-instructions-", dir=root)
            try:
                with os.fdopen(fd, "w") as handle:
                    handle.write(original.rstrip() + ("\n\n" if original else "") + CONNECTION_HINT)
                os.chmod(temporary, mode)
                # Do not replace an edit made while preparing this hint.
                if not path.is_symlink() and (path.read_text() if path.exists() else "") == original:
                    os.replace(temporary, path)
            finally:
                Path(temporary).unlink(missing_ok=True)
        except (OSError, UnicodeError):
            # A protected user instruction file must not prevent opening hn.
            continue


def prepare(home=None):
    home = Path.home() if home is None else Path(home)
    root, legacy = home / 'projects', home / 'Projects'
    # Keep old terminal/session paths working after the capitalization change.
    # Two existing directories are never silently merged or replaced.
    if not root.exists() and not root.is_symlink() and legacy.is_dir() and not legacy.is_symlink():
        legacy.rename(root)
        legacy.symlink_to('projects', target_is_directory=True)
    root.mkdir(parents=True, exist_ok=True)
    connection_instructions(root)
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
