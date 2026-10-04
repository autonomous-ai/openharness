#!/usr/bin/env bash
# Build as an ordinary user on native Linux, before the privileged image build.
set -euo pipefail
REPO_DIR=$(cd -- "$(dirname -- "$0")/../.." && pwd)
case $(uname -sm) in
    'Linux x86_64') harness_target=x86_64-unknown-linux-musl ;;
    'Linux aarch64') harness_target=aarch64-unknown-linux-musl ;;
    *) echo 'OS runtimes require a native x86_64 or aarch64 Linux build host.' >&2; exit 1 ;;
esac
cd "$REPO_DIR"
npm ci --prefix cli --no-audit --no-fund
(cd cli && node build-bundle.mjs)
cargo build --manifest-path tui/Cargo.toml --locked --release --target "$harness_target"
mkdir -p os/work/runtime
cp "tui/target/$harness_target/release/harness-tui" os/work/runtime/
cp cli/dist/cli.js cli/dist/notify.mjs os/work/runtime/
python3 - "$harness_target" <<'PY'
import json, pathlib, subprocess, sys, tomllib
def output(*args):
    return subprocess.check_output(args, text=True).strip()
data = {'source_commit': output('git', 'rev-parse', 'HEAD'),
        'dirty': bool(output('git', 'status', '--porcelain', '--untracked-files=no')),
        'node': output('node', '--version'), 'rust': output('rustc', '--version'),
        'target': sys.argv[1]}
with pathlib.Path('os/work/runtime/harness-tui').open('rb') as binary:
    header = binary.read(20)
machine = {'x86_64-unknown-linux-musl': 62, 'aarch64-unknown-linux-musl': 183}[data['target']]
assert header[:6] == b'\x7fELF\x02\x01' and int.from_bytes(header[18:20], 'little') == machine, 'Wrong runtime architecture'
expected_hn = tomllib.loads(pathlib.Path('tui/Cargo.toml').read_text())['package']['version']
expected_cli = json.loads(pathlib.Path('cli/package.json').read_text())['version']
assert output('os/work/runtime/harness-tui', '--version').startswith('hn ' + expected_hn + ' ')
assert output('node', 'cli/dist/cli.js', 'version') == expected_cli
data['versions'] = {'hn': expected_hn, 'cli': expected_cli}
pathlib.Path('os/work/runtime/source.json').write_text(json.dumps(data, indent=2) + '\n')
PY
