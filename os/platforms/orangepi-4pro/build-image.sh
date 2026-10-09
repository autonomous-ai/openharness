#!/usr/bin/env bash
# Phase 2: Harness on a copy of the phase-1 base image (build-base.sh). This is the part that
# changes with the code: the session tree from this source, its runtime and the agents.
# Run as root on an aarch64 Debian 12 host, after os/tools/build-runtime.sh.
# Usage: build-image.sh HARNESS_BASE.img RUNTIME_DIR OUTPUT.img
# Nothing from the build host's accounts (sign-ins, SSH keys, sources) enters the image.
set -euo pipefail
BASE=${1:?base image from build-base.sh}
RUNTIME=${2:?runtime directory from os/tools/build-runtime.sh}
OUT=${3:?output image}
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
SOURCE=$(cd -- "$HERE/../../.." && pwd)
PREFIX=${HARNESS_WL_PREFIX:-/opt/harness-wl}
ACCOUNT=orangepi
[[ $EUID == 0 && $(uname -m) == aarch64 ]] || { echo 'Run as root on aarch64.' >&2; exit 1; }
OPENCODE=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$SOURCE/os/packaging/fedora/opencode.lock.json")
source "$HERE/image-lib.sh"

cp --sparse=always "$BASE" "$OUT"
attach_image "$OUT"
[[ -f $MNT/etc/harness-base.json && -x $MNT$PREFIX/bin/labwc ]] || { echo "$BASE is not a build-base.sh image." >&2; exit 1; }

HARNESS_WL_PREFIX=$PREFIX "$HERE/install-session.sh" "$MNT" "$RUNTIME" "$ACCOUNT"
# install-session.sh bundles OpenCode in /usr. Claude Code is preinstalled by hn's own recipe
# (cli/src/lib/engineInstall.ts), so the first Claude harness need not wait for a download;
# other agents install from hn when chosen.
chroot "$MNT" su - "$ACCOUNT" -c "npm_config_prefix=\$HOME/.local npm install -g --no-audit --no-fund @anthropic-ai/claude-code >/dev/null 2>&1"
CLAUDE=$(chroot "$MNT" su - "$ACCOUNT" -c '$HOME/.local/bin/claude --version' | cut -d' ' -f1)
python3 - "$MNT/etc/harness-image.json" "$MNT/etc/harness-base.json" "$SOURCE" "$OPENCODE" "$CLAUDE" <<'PY'
import json, subprocess, sys
from pathlib import Path
path, base, source, opencode, claude = sys.argv[1:]
commit = subprocess.check_output(['git', '-c', f'safe.directory={source}', '-C', source, 'rev-parse', 'HEAD'], text=True).strip()
info = json.loads(Path(base).read_text())
info.update(source_commit=commit, opencode=opencode, claude_code=claude)
Path(path).write_text(json.dumps(info, indent=2) + '\n')
PY

# Leave no build-host state behind.
rm -rf "$MNT/root/.npm" "$MNT/home/$ACCOUNT/.npm" "$MNT/tmp/"*
for leftover in "home/$ACCOUNT/.ssh/authorized_keys" "home/$ACCOUNT/.harness" "root/.ssh/authorized_keys"; do
    [[ ! -e $MNT/$leftover ]] || { echo "Unexpected build-host state: $leftover" >&2; exit 1; }
done
chroot "$MNT" /usr/lib/harness/hn --version
chroot "$MNT" su - "$ACCOUNT" -c '/usr/bin/opencode --version'
df -h "$MNT" | tail -1
release_image
