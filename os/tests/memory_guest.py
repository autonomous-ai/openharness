#!/usr/bin/env python3
"""Measure candidate Node flags only inside an installed disposable OS guest."""
import json
import os
from pathlib import Path
import statistics
import subprocess
import time
from urllib.request import urlopen


ROOT = Path.home() / 'memory-assessment'
OVERRIDE = Path.home() / '.config/systemd/user/harness-daemon.service.d/memory-assessment.conf'
PROFILES = [('default', []), ('small', ['--optimize-for-size', '--max-semi-space-size=1'])]


def run(*args, timeout=180):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    with (ROOT / 'commands.log').open('a') as log:
        log.write(json.dumps(args) + '\n' + result.stdout + result.stderr + '\n')
    result.check_returncode()
    return result.stdout.strip()


def api():
    start = time.perf_counter()
    with urlopen('http://127.0.0.1:18473/api/status', timeout=5) as response:
        value = json.load(response)
    assert value.get('discoveryReady'), value
    return (time.perf_counter() - start) * 1000


def process(pid):
    memory = {}
    for line in Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines():
        parts = line.split()
        if parts[0] in ('Rss:', 'Pss:', 'Private_Clean:', 'Private_Dirty:'):
            memory[parts[0][:-1] + '_kib'] = int(parts[1])
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    memory['cpu_ticks'] = int(fields[11]) + int(fields[12])
    return memory


def survivor_pids():
    return {p.name: int(p.read_text()) for p in ROOT.glob('survivor-*.pid')}


def main():
    assert os.getuid() != 0 and not Path('/etc/harness-live').exists()
    assert Path('/var/lib/harness-os/install.json').is_file()
    ROOT.mkdir(exist_ok=True)
    assert not OVERRIDE.exists(), 'Never replace an existing user override'
    result = {'status': 'running', 'started_at': time.time(), 'rounds': [],
              'node': run('node', '--version'), 'clock_ticks_per_second': os.sysconf('SC_CLK_TCK'),
              'scope': 'Daemon memory, local status latency and persistent terminal streams; not full agent throughput'}
    # Keep terminal processes and output moving while the daemon is replaced.
    (ROOT / 'survivor.py').write_text('''import os,sys,time
from pathlib import Path
root=Path.home()/'memory-assessment'
n=sys.argv[1]
(root/('survivor-'+n+'.pid')).write_text(str(os.getpid()))
for i in range(10000):
    (root/('survivor-'+n+'.count')).write_text(str(i))
    print('terminal '+n+' output '+str(i)+' '+('x'*120),flush=True)
    time.sleep(.25)
''')
    run('systemctl', '--user', 'stop', 'harness-update.timer')
    for n in range(4):
        run('hn', 'new-window', '-d', '-n', f'memory-{n}', f'python3 -u {ROOT}/survivor.py {n}')
    deadline = time.monotonic() + 15
    while len(survivor_pids()) != 4:
        assert time.monotonic() < deadline, 'Terminal streams did not start'
        time.sleep(.25)
    original = survivor_pids()
    try:
        # Interleave the baseline to expose cache/load drift in one VM.
        for repetition in range(2):
            for name, flags in PROFILES:
                OVERRIDE.parent.mkdir(parents=True, exist_ok=True)
                OVERRIDE.write_text('[Service]\nExecStart=\nExecStart=/usr/bin/node ' +
                    ' '.join(flags) + ' /usr/lib/harness/cli.mjs start --foreground\n')
                run('systemctl', '--user', 'daemon-reload')
                start = time.monotonic()
                run('systemctl', '--user', 'restart', 'harness-daemon')
                ready_seconds = time.monotonic() - start
                pid = int(run('systemctl', '--user', 'show', 'harness-daemon', '-p', 'MainPID', '--value'))
                command = Path(f'/proc/{pid}/cmdline').read_bytes().replace(b'\0', b' ').decode()
                assert '/usr/bin/node' in command and all(flag in command for flag in flags)
                for _ in range(10):
                    api()
                    time.sleep(1)
                before = process(pid)
                start = time.monotonic()
                samples, latencies = [], []
                for _ in range(10):
                    latencies.extend(api() for _ in range(20))
                    samples.append(process(pid))
                    time.sleep(3)
                elapsed = time.monotonic() - start
                assert survivor_pids() == original, 'A terminal owner was replaced'
                for child in original.values():
                    os.kill(child, 0)
                ticks = process(pid)['cpu_ticks'] - before['cpu_ticks']
                ordered = sorted(latencies)
                row = {'profile': name, 'repetition': repetition, 'flags': flags,
                       'pid': pid, 'command': command, 'ready_seconds': ready_seconds,
                       'samples': samples, 'rss_median_kib': statistics.median(s['Rss_kib'] for s in samples),
                       'pss_median_kib': statistics.median(s['Pss_kib'] for s in samples),
                       'api_median_ms': statistics.median(latencies), 'api_p95_ms': ordered[int(len(ordered)*.95)],
                       'api_max_ms': max(latencies), 'cpu_seconds': ticks / os.sysconf('SC_CLK_TCK'),
                       'measured_seconds': elapsed, 'survivor_pids': original}
                result['rounds'].append(row)
                (ROOT / 'receipt.json').write_text(json.dumps(result, indent=2)+'\n')
                print('HN_MEMORY_ROUND=' + json.dumps({k:v for k,v in row.items() if k!='samples'}), flush=True)
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        raise
    finally:
        OVERRIDE.unlink(missing_ok=True)
        run('systemctl', '--user', 'daemon-reload')
        run('systemctl', '--user', 'restart', 'harness-daemon')
        result['default_restored'] = '--optimize-for-size' not in run('systemctl', '--user', 'show', 'harness-daemon', '-p', 'ExecStart', '--value')
        result['finished_at'] = time.time()
        (ROOT / 'receipt.json').write_text(json.dumps(result, indent=2)+'\n')
        print('HN_MEMORY_RESULT=' + json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
