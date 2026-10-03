"""Acceptance fixtures independent of the model-written logscope tests."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

tool = Path(sys.argv[1]).resolve()
rows = '\n'.join([
    '{"level":"info","service":"api","latency_ms":10}',
    '{"level":"error","service":"api","latency_ms":90}',
    'not json',
    '{"level":"info","service":"worker","latency_ms":-1}',
    '{"level":"info","service":"api","latency_ms":20}',
]) + '\n'

def run(*args, text=None):
    return json.loads(subprocess.check_output([sys.executable, str(tool), *args], input=text, text=True, timeout=10))

with tempfile.TemporaryDirectory() as temp:
    source = Path(temp) / 'events.jsonl'
    source.write_text(rows)
    actual = run(str(source))
    assert actual == {'total': 4, 'malformed': 1, 'levels': {'info': 3, 'error': 1},
                      'services': {'api': 3, 'worker': 1}, 'p50': 20, 'p95': 90}, actual
    assert run(text=rows) == actual, 'stdin and file results differ'
    filtered = run('--level', 'error', str(source))
    assert filtered['total'] == 1 and filtered['p95'] == 90 and filtered['levels'] == {'error': 1}, filtered
    empty = run(text='')
    assert empty['total'] == 0 and empty['malformed'] == 0 and empty['p50'] is None and empty['p95'] is None, empty
print('Independent CLI acceptance passed: file, stdin, malformed data, filtering and empty input.')
