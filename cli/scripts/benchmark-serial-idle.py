"""Matched idle serial measurements using owned PTYs, never real USB ports.

python3 cli/scripts/benchmark-serial-idle.py baseline.ts candidate.ts new-output-dir
Optionally pass --node /path/to/node and --sampler /path/to/process-usage-v2.
The output directory must not exist. All observations and source copies are kept.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import pty
import select
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('baseline', type=Path)
parser.add_argument('candidate', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--node', default=shutil.which('node'))
parser.add_argument('--sampler', type=Path)
args = parser.parse_args()
assert args.node, 'Node is required'
root = args.output.resolve()
root.mkdir()  # Refuse to overwrite existing evidence.
cli = Path(__file__).resolve().parents[1]
worker = Path(__file__).with_suffix('.mjs')
for variant in ('baseline', 'candidate'):
    source = root / f'{variant}.ts'
    shutil.copyfile(getattr(args, variant), source)
    subprocess.run([
        args.node, '-e',
        "require(process.argv[1]).buildSync({entryPoints:[process.argv[2]],"
        "outfile:process.argv[3],bundle:true,platform:'node',format:'esm',target:'node20'})",
        str(cli / 'node_modules/esbuild/lib/main.js'), str(source), str(root / f'{variant}.mjs'),
    ], check=True)

report = {
    'kind': 'owned_native_pty_idle_serial',
    'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'platform': platform.platform(),
    'baselineSourceSha256': hashlib.sha256((root / 'baseline.ts').read_bytes()).hexdigest(),
    'candidateSourceSha256': hashlib.sha256((root / 'candidate.ts').read_bytes()).hexdigest(),
    'runs': [],
}
output = root / 'results.json'
try:
    for count in (1, 3):
        for trial in range(3):
            variants = ('baseline', 'candidate') if trial % 2 == 0 else ('candidate', 'baseline')
            for variant in variants:
                handles, paths, child = [], [], None
                try:
                    for _ in range(count):
                        master, slave = pty.openpty()
                        handles.extend((master, slave))
                        paths.append(os.ttyname(slave))
                    child = subprocess.Popen(
                        [args.node, str(worker), str(root / f'{variant}.mjs'), json.dumps(paths)],
                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                        text=True, start_new_session=True,
                        env={**os.environ, 'UV_THREADPOOL_SIZE': '1'},
                    )
                    readable, _, _ = select.select([child.stdout], [], [], 8)
                    assert readable, 'Serial fixture did not become ready'
                    ready = json.loads(child.stdout.readline())
                    assert ready['ready'] and ready['pid'] == child.pid
                    usage = None
                    if args.sampler:
                        label = f'{variant}-{count}-ports-{trial}'
                        path = root / f'{label}-usage.json'
                        subprocess.run([
                            str(args.sampler.resolve()), str(child.pid), '10', label, str(path),
                        ], check=True, capture_output=True, text=True, timeout=12)
                        usage = json.loads(path.read_text())
                        assert usage['schema'] == 2 and usage['success'], 'Require calibrated native sampler'
                    stdout, stderr = child.communicate(timeout=15)
                    assert child.returncode == 0, stderr
                    result = json.loads(stdout)
                    result.update(variant=variant, trial=trial, runtime=ready)
                    if usage:
                        result['usage'] = usage
                    report['runs'].append(result)
                    print(json.dumps({k: result[k] for k in (
                        'variant', 'trial', 'ports', 'cpuPercentOneCore',
                    )}), flush=True)
                    output.write_text(json.dumps(report, indent=2) + '\n')
                finally:
                    if child is not None and child.poll() is None:
                        child.terminate()
                        try:
                            child.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            child.kill()
                            child.wait(timeout=3)
                    for descriptor in handles:
                        os.close(descriptor)
finally:
    report['endedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    output.write_text(json.dumps(report, indent=2) + '\n')
