#!/usr/bin/env bash
# Build natively as an ordinary Linux user, before the privileged platform build.
set -euo pipefail
REPO_DIR=$(cd -- "$(dirname -- "$0")/../.." && pwd)
case $(uname -sm) in
    'Linux x86_64') runtime_arch=x86_64 ;;
    'Linux aarch64') runtime_arch=aarch64 ;;
    *) echo 'OS runtimes require a native x86_64 or aarch64 Linux build host.' >&2; exit 1 ;;
esac
runtime_target="$runtime_arch-unknown-linux-musl"
cd "$REPO_DIR"
runtime_output=${HARNESS_OS_RUNTIME_DIR:-os/work/runtime}
[[ ! -e "$runtime_output" && ! -L "$runtime_output" ]] || { echo 'Use a fresh HARNESS_OS_RUNTIME_DIR; runtime artifacts are immutable.' >&2; exit 1; }
# Check ancestry before the expensive build. A source bundle can contain fixes
# newer than the public CLI even while package.json retains its development version.
python3 os/tools/runtime-baseline.py >/dev/null
npm ci --prefix cli --no-audit --no-fund
(cd cli && node build-bundle.mjs)
cargo build --manifest-path tui/Cargo.toml --locked --release --target "$runtime_target"
runtime_stage=$(mktemp -d "${TMPDIR:-/tmp}/harness-runtime.XXXXXX")
trap 'rm -rf -- "$runtime_stage"' EXIT
cp "tui/target/$runtime_target/release/harness-tui" "$runtime_stage/"
cp cli/dist/cli.js cli/dist/notify.mjs "$runtime_stage/"
HARNESS_RUNTIME_STAGE="$runtime_stage" HARNESS_RUNTIME_ARCH="$runtime_arch" python3 - <<'PY'
import hashlib, json, os, pathlib, subprocess, tomllib
def output(*args):
    return subprocess.check_output(args, text=True).strip()
folder = pathlib.Path(os.environ['HARNESS_RUNTIME_STAGE'])
architecture = os.environ['HARNESS_RUNTIME_ARCH']
node_arch, elf_machine = {'x86_64': ('x64', 62), 'aarch64': ('arm64', 183)}[architecture]
assert output('node', '-p', 'process.arch') == node_arch, 'Node must match the native build architecture'
with (folder / 'harness-tui').open('rb') as handle:
    header = handle.read(20)
assert header[:6] == b'\x7fELF\x02\x01' and int.from_bytes(header[18:20], 'little') == elf_machine, 'Wrong terminal ELF architecture'
data = {'source_commit': output('git', 'rev-parse', 'HEAD'),
        'dirty': bool(output('git', 'status', '--porcelain', '--untracked-files=no')),
        'node': output('node', '--version'), 'rust': output('rustc', '--version'),
        'architecture': architecture, 'target': architecture + '-unknown-linux-musl'}
assert not data['dirty'], 'Commit source changes before building a traceable runtime'
expected_hn = tomllib.loads(pathlib.Path('tui/Cargo.toml').read_text())['package']['version']
expected_cli = json.loads(pathlib.Path('cli/package.json').read_text())['version']
assert output(str(folder / 'harness-tui'), '--version').startswith('hn ' + expected_hn + ' ')
assert output('node', str(folder / 'cli.js'), 'version') == expected_cli
data['versions'] = {'hn': expected_hn, 'cli': expected_cli}
data['release_baselines'] = json.loads(output('python3', 'os/tools/runtime-baseline.py'))
data['files'] = {path.name: {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}
                 for path in sorted(folder.iterdir())}
(folder / 'source.json').write_text(json.dumps(data, indent=2) + '\n')
PY
mkdir -p -- "$(dirname -- "$runtime_output")"
mkdir -- "$runtime_output"
cp "$runtime_stage/harness-tui" "$runtime_stage/cli.js" "$runtime_stage/notify.mjs" "$runtime_output/"
cp "$runtime_stage/source.json" "$runtime_output/"
