#!/usr/bin/env bash
# Build the shared Flutter app for the existing harness.autonomous.ai host.
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Usage: bash scripts/build-web-release.sh X.Y.Z' >&2
  exit 1
fi

cd "$(dirname "$0")/.."
if [[ -n "$(git status --porcelain -- .)" ]]; then
  echo 'Commit the Flutter source before building a release.' >&2
  exit 1
fi
source_commit="$(git rev-parse HEAD)"
"${FLUTTER_BIN:-flutter}" build web --release --no-wasm-dry-run \
  --no-web-resources-cdn --base-href=/harness-web/ \
  --output=build/web-release --build-name="$version"

python3 - "$version" "$source_commit" <<'PY'
import hashlib
import json
from pathlib import Path
import tarfile
import sys

version, commit = sys.argv[1:]
root = Path('build/web-release')
release = {
    'version': version,
    'sourceCommit': commit,
    'baseHref': '/harness-web/',
    'apiUrl': 'https://harness-api.autonomous.ai',
}
(root / 'release.json').write_text(json.dumps(release, indent=2) + '\n')
output = Path('build/web-dist')
output.mkdir(parents=True, exist_ok=True)
archive = output / f'harness-web-{version}.tar.gz'
with tarfile.open(archive, 'w:gz') as bundle:
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError(f'Release assets must be regular files: {path}')
        if path.is_file():
            bundle.add(path, arcname=path.relative_to(root), recursive=False)
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
(output / f'{archive.name}.sha256').write_text(f'{checksum}  {archive.name}\n')
release.update({
    'archiveUrl': f'https://github.com/autonomous-ai/openharness/releases/download/v{version}_web/{archive.name}',
    'sha256': checksum,
})
(output / 'harness-web-release.json').write_text(json.dumps(release, indent=2) + '\n')
print(json.dumps(release, indent=2))
PY
