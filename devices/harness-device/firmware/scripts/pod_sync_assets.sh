#!/usr/bin/env bash
# Copies the round dial's generated pet scenes from origin/main into
# main/ui/habitat/pod/ (pets.c, pets.h). Idempotent. Run `git fetch origin main` first.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$here/../main/ui/habitat/pod"
src="devices/harness-device/firmware/main/ui/habitat"
mkdir -p "$dest"
git -C "$here" show "origin/main:$src/pets.h" | sed 's|#include "terminal.h"|#include "pod_types.h"|' > "$dest/pets.h"
git -C "$here" show "origin/main:$src/pets.c" > "$dest/pets.c"   # includes only pets.h
# The engine logos are not copied from the dial: scripts/pod_gen_logos.py pre-renders them from the repo art.
