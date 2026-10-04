#!/usr/bin/env bash
# Build as an ordinary user on x86_64 Linux, before the privileged image build.
set -euo pipefail
REPO_DIR=$(cd -- "$(dirname -- "$0")/../.." && pwd)
[[ $(uname -sm) == 'Linux x86_64' ]] || { echo 'OS runtimes require an x86_64 Linux build host.' >&2; exit 1; }
cd "$REPO_DIR"
# Check ancestry before the expensive build. A source bundle can contain fixes
# newer than the public CLI even while package.json retains its development version.
python3 os/tools/runtime-baseline.py >/dev/null
npm ci --prefix cli --no-audit --no-fund
(cd cli && node build-bundle.mjs)
cargo build --manifest-path tui/Cargo.toml --locked --release --target x86_64-unknown-linux-musl
mkdir -p os/work/runtime
cp tui/target/x86_64-unknown-linux-musl/release/harness-tui os/work/runtime/
cp cli/dist/cli.js cli/dist/notify.mjs os/work/runtime/
python3 - <<'PY'
import json, pathlib, subprocess, tomllib
def output(*args):
    return subprocess.check_output(args, text=True).strip()
data = {'source_commit': output('git', 'rev-parse', 'HEAD'),
        'dirty': bool(output('git', 'status', '--porcelain', '--untracked-files=no')),
        'node': output('node', '--version'), 'rust': output('rustc', '--version'),
        'target': 'x86_64-unknown-linux-musl'}
expected_hn = tomllib.loads(pathlib.Path('tui/Cargo.toml').read_text())['package']['version']
expected_cli = json.loads(pathlib.Path('cli/package.json').read_text())['version']
assert output('os/work/runtime/harness-tui', '--version').startswith('hn ' + expected_hn + ' ')
assert output('node', 'cli/dist/cli.js', 'version') == expected_cli
data['versions'] = {'hn': expected_hn, 'cli': expected_cli}
data['release_baselines'] = json.loads(output('python3', 'os/tools/runtime-baseline.py'))
pathlib.Path('os/work/runtime/source.json').write_text(json.dumps(data, indent=2) + '\n')
PY
