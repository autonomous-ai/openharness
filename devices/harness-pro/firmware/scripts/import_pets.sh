#!/usr/bin/env bash
# Copies the round dial's generated pet scenes into main/pod/ (pets.c, pets.h). A one-way copy, run only when the
# owner asks; there is no build-time link to the round's tree. Idempotent.
#
#   scripts/import_pets.sh <round-habitat-dir>
#
# <round-habitat-dir> is the directory that holds the round dial's pets.c and pets.h.
set -euo pipefail
if [[ $# -ne 1 || ! -f "$1/pets.c" || ! -f "$1/pets.h" ]]; then
    echo "usage: $0 <round-habitat-dir>   (the directory holding pets.c and pets.h)" >&2
    exit 2
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$here/../main/pod"
src="$1"
mkdir -p "$dest"
sed 's|#include "terminal.h"|#include "pod_types.h"|' "$src/pets.h" > "$dest/pets.h"
cp "$src/pets.c" "$dest/pets.c"   # includes only pets.h
python3 "$here/prune_pets.py" "$dest/pets.c"   # drops the scenes and frames Pod never plays
# The engine logos are not copied from the round: scripts/pod_gen_logos.py pre-renders them from the repo art.
