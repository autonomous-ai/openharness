#!/usr/bin/env python3
"""Build unpublished real runtimes for the private VM update feed. Never publish these."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

source = Path(__file__).resolve().parents[2]
output = source / 'os/work/fast-update-fixture'
output.mkdir(parents=True, exist_ok=False)
fixture_version = '999.0.1'
base_url = 'http://127.0.0.1:19447/'
runtime = source / 'os/work/runtime'
# Keep the production runtime/package already built from clean source untouched.
with tempfile.TemporaryDirectory(prefix='harness-update-fixture-') as temporary:
    project = Path(temporary) / 'tui'
    shutil.copytree(source / 'tui', project, ignore=shutil.ignore_patterns('target', '.git'))
    manifest = project / 'Cargo.toml'
    manifest.write_text(re.sub(r'(?m)^version = "[^"]+"', f'version = "{fixture_version}"', manifest.read_text(), count=1))
    lock = project / 'Cargo.lock'
    lock.write_text(re.sub(r'(name = "harness-tui"\nversion = ")[^"]+', r'\g<1>' + fixture_version, lock.read_text()))
    subprocess.run(['cargo', 'build', '--locked', '--release', '--target', 'x86_64-unknown-linux-musl',
                    '--manifest-path', str(manifest)], check=True,
                   env=dict(os.environ, CARGO_TARGET_DIR=str(source / 'tui/target')))
    shutil.copyfile(source / 'tui/target/x86_64-unknown-linux-musl/release/harness-tui', output / 'harness-tui')
subprocess.run(['node', 'build-bundle.mjs'], cwd=source / 'cli', check=True,
               env=dict(os.environ, ADAPTER_VERSION=fixture_version))
shutil.copyfile(source / 'cli/dist/cli.js', output / 'cli.mjs')
shutil.copyfile(source / 'cli/dist/notify.mjs', output / 'notify.mjs')
shutil.copyfile(runtime / 'cli.js', output / 'cli-current.mjs')
current_cli = subprocess.check_output(['node', str(output / 'cli-current.mjs'), 'version'], text=True).strip()

def ref(name):
    data = (output / name).read_bytes()
    return {'url': base_url + name, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}

baseline = json.loads((runtime / 'source.json').read_text())['release_baselines']['cli']['version']
documents = {
    'hn.json': {'version': fixture_version, 'builds': {'linux-x64': ref('harness-tui')}},
    'cli.json': {'cli': {'version': fixture_version, 'cli': ref('cli.mjs'), 'notify': ref('notify.mjs')}},
    'cli-current.json': {'cli': {'version': current_cli, 'cli': ref('cli-current.mjs'), 'notify': ref('notify.mjs')}},
    'cli-ancestor.json': {'cli': {'version': baseline, 'cli': ref('cli.mjs'), 'notify': ref('notify.mjs')}},
    'feeds-ancestor.json': {'cli': base_url + 'cli-ancestor.json'},
    'feeds-hn.json': {'hn': base_url + 'hn.json', 'cli': base_url + 'cli-current.json'},
    'feeds-both.json': {'hn': base_url + 'hn.json', 'cli': base_url + 'cli.json'},
}
for name, data in documents.items():
    (output / name).write_text(json.dumps(data) + '\n')
(output / 'fixture.json').write_text(json.dumps({'version': fixture_version, 'published': False,
    'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in output.iterdir() if p.is_file()}}, indent=2) + '\n')
