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

# lucide_icons_flutter lists seven fonts and the browser fetches every one on first load, but
# the app draws only weight 400 (lib/shared/theme/app_icons.dart): the other six are 1.5 MB
# compressed. Dropped here, not in pubspec.yaml, so the Desktop bundle is unchanged.
python3 - <<'PY'
import json
from pathlib import Path
import sys

package = 'packages/lucide_icons_flutter/'
used = package + 'Lucide400'
assets = Path('build/web-release/assets')
manifest_path = assets / 'FontManifest.json'
manifest = json.loads(manifest_path.read_text())
if used not in {entry['family'] for entry in manifest}:
    sys.exit(f'{used} is not in the font manifest; update the unused-font step in build-web-release.sh.')
unused = [e for e in manifest if e['family'].startswith(package) and e['family'] != used]
for entry in unused:
    for font in entry['fonts']:
        (assets / font['asset']).unlink()
manifest_path.write_text(json.dumps([e for e in manifest if e not in unused], separators=(',', ':')))
print(f"Dropped {len(unused)} unused icon fonts from the web release.")
PY

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
