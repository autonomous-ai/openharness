#!/usr/bin/env python3
"""Read process and project identity in the disposable browser-suspend VM."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def browser_main(argv):
    # Chromium can replace its NUL-separated argv with one process title.
    # Keep the raw form for identity, but recognize child flags in either form.
    return bool(argv and argv[0]) and not any(re.search(r'(?:^|\s)--type=', arg) for arg in argv)


def process(pid):
    root = Path('/proc') / str(pid)
    fields = (root / 'stat').read_text().rsplit(')', 1)[1].split()
    assert fields[0] not in ('Z', 'X'), 'A preserved process is no longer running'
    return dict(pid=int(pid), start_ticks=fields[19], executable=str((root / 'exe').resolve(strict=True)),
                argv=(root / 'cmdline').read_bytes().rstrip(b'\0').decode().split('\0'))


def snapshot():
    agents, browsers = [], []
    for path in Path('/proc').iterdir():
        if not path.name.isdecimal():
            continue
        try:
            if path.stat().st_uid != os.getuid():
                continue
            name = (path / 'comm').read_text().strip()
            if name == 'opencode':
                agents.append(process(path.name))
            elif name == 'chromium':
                argv = (path / 'cmdline').read_bytes().rstrip(b'\0').decode().split('\0')
                if browser_main(argv):
                    browsers.append(process(path.name))
        except FileNotFoundError:
            continue
    assert len(agents) == 2, ('Expected both bundled OpenCode processes', agents)
    assert len(browsers) == 1, ('Expected one browser main process', browsers)
    daemon = subprocess.check_output(['systemctl', '--user', 'show', 'harness-daemon.service',
                                      '-p', 'MainPID', '--value'], text=True, timeout=5).strip()
    probe = Path('/tmp/harness-browser-probe')
    runtime = {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in {
        'harness-tui': '/usr/lib/harness/harness-tui', 'cli.mjs': '/usr/lib/harness/cli.mjs',
        'notify.mjs': '/usr/lib/harness/notify.mjs'}.items()}
    return dict(agents=sorted(agents, key=lambda item: item['pid']), browser=browsers[0],
                daemon=process(daemon), terminal=process((probe / 'terminal-pid').read_text().strip()),
                boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip(), runtime=runtime,
                project_sha256=hashlib.sha256((Path.home() / 'projects/browser-suspend/proof.txt').read_bytes()).hexdigest(),
                terminal_input=(probe / 'terminal-input').read_text(),
                pages=json.loads((probe / 'states.json').read_text()))


if __name__ == '__main__':
    print(json.dumps(snapshot()))
