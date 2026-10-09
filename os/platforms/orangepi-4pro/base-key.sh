#!/usr/bin/env bash
# Print the key of the phase-1 base image (build-base.sh): it changes exactly when the base
# image would. Inputs: Orange Pi's image and the files that decide what phase 1 installs.
# Usage: base-key.sh BASE.img   (uses BASE.img.sha when present instead of hashing 4 GB)
set -euo pipefail
BASE=${1:?official Orangepi4pro_*_debian_bookworm_server_*.img}
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
SOURCE=$(cd -- "$HERE/../../.." && pwd)
python3 - "$BASE" "$HERE" "$SOURCE" <<'PY'
import hashlib, sys
from pathlib import Path
base, here, source = map(Path, sys.argv[1:])
recorded = Path(str(base) + '.sha')
if recorded.is_file():
    base_digest = recorded.read_text().split()[0].lower()
else:
    with base.open('rb') as handle:
        base_digest = hashlib.file_digest(handle, 'sha256').hexdigest()
key = hashlib.sha256(b'harness-orangepi4pro-base\n' + base_digest.encode() + b'\n')
for path in [here / 'build-base.sh', here / 'image-lib.sh', here / 'build-compositor.sh',
             source / 'os/packaging/labwc/source.json',
             source / 'os/packaging/labwc/session-lock-presentation.patch']:
    key.update(path.relative_to(source).as_posix().encode() + b'\0' + path.read_bytes() + b'\0')
print(key.hexdigest()[:16])
PY
