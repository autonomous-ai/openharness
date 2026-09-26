#!/bin/bash
# Bring the CoreS3 port up to date with upstream openharness, then rebuild.
#
#   git remote add upstream https://github.com/autonomous-ai/openharness.git   # once
#   . ~/esp/esp-idf/export.sh
#   ./scripts/update-upstream.sh
set -euo pipefail
FW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$FW_DIR/../../.." && pwd)"   # devices/harness-device/firmware → repo root

cd "$REPO_DIR"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "cores3" ]; then
    echo "Not on the cores3 branch (on '$BRANCH') — refusing to rebase." >&2
    exit 1
fi
git fetch upstream
echo "Upstream is at: $(git rev-parse --short upstream/main) $(git log -1 --format=%s upstream/main)"
echo "Port is at:     $(git rev-parse --short HEAD)"
if git merge-base --is-ancestor upstream/main HEAD; then
    echo "cores3 already contains upstream/main — nothing to do."
else
    echo "Rebasing cores3 onto upstream/main…"
    git rebase upstream/main
fi

cd "$FW_DIR"
if [ -f build-cores3/interns_commander.bin ] || [ "${REBUILD:-1}" = "1" ]; then
    bash scripts/build-cores3.sh
fi
