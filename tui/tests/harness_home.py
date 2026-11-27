"""Harness's folders in a fixture's home, by the rule hn follows (src/harness_home.rs).

The fixtures lay out and read what an install on this computer has: on Linux the XDG data and
state folders, but ~/.harness for both while it exists and the XDG data folder holds no .harness-root
file; elsewhere ~/.harness. The full table of entries is the CLI's (cli/src/config/harnessHome.ts).

    python3 tests/harness_home.py <home> <entry>   prints the entry's folder for this environment
"""
import os
from pathlib import Path
import sys

# Only the entries the fixtures use.
ENTRIES = {'bin': 'data', 'cli': 'data', 'tui': 'data', 'runtime': 'state', 'shell-requests': 'state'}


def roots(home, env):
    """(data, state) for `home`, with `env` the environment the program under test is given."""
    home = Path(home)
    legacy = home / '.harness'
    if not sys.platform.startswith('linux'):
        return legacy, legacy

    def xdg(variable, default):
        # An unset, empty or relative variable is ignored, as the XDG spec says.
        value = env.get(variable, '')
        return (Path(value) if os.path.isabs(value) else home / default) / 'harness'

    data = xdg('XDG_DATA_HOME', '.local/share')
    if not (data / '.harness-root').is_file() and legacy.exists():
        return legacy, legacy
    return data, xdg('XDG_STATE_HOME', '.local/state')


def path(home, env, entry):
    data, state = roots(home, env)
    return (data if ENTRIES[entry] == 'data' else state) / entry


if __name__ == '__main__':
    print(path(sys.argv[1], os.environ, sys.argv[2]))
