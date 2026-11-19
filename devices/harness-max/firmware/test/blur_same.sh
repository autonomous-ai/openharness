#!/usr/bin/env bash
# Does the layer built with MAX_BLUR_PERIOD4 (the bench's variant of the blur, off in the product: bench/main/
# CMakeLists.txt) paint every frame of every motion as the product's build does? Builds test/motion_hash.c over this
# tree with and without it, on both glasses, and compares what the two print.
#   test/blur_same.sh     exit 0 every frame the same, 1 one differs
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
pro="$(cd "$fw/../../harness-pro/firmware" && pwd)"
source "$here/max_tree.sh"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
python3 "$pro/scripts/gen_fonts.py" --out "$out/pro_fonts.c" >/dev/null

hashes() {   # hashes <plain|period4> <height>: build and run motion_hash, into $out/<side>-<height>.txt
    local side="$1" h="$2" flags=()
    [[ $side == period4 ]] && flags=(-DMAX_BLUR_PERIOD4)
    cc -std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O2 -DHT_WIDTH=1920 -DHT_HEIGHT="$h" ${flags[@]+"${flags[@]}"} \
       "${max_pro_flags[@]}" -I"$here" -I"$fw/main/app" -I"$pro/main" -I"$pro/main/display" -o "$out/hash-$side-$h" \
       "$here/motion_hash.c" "$fw"/main/app/max_ui_*.c "${max_compositor[@]}" \
       "$pro"/main/pod/{pod_pet,pets,pets_ask,pets_codex,engine_logos}.c "$out/pro_fonts.c"
    "$out/hash-$side-$h" > "$out/$side-$h.txt"
}
heights=(${MAX_HEIGHTS:-480 415})
pids=()
for h in "${heights[@]}"; do
    for side in plain period4; do hashes "$side" "$h" & pids+=($!); done
done
for pid in "${pids[@]}"; do wait "$pid"; done   # set -e: a build or run that failed fails the check

status=0
for h in "${heights[@]}"; do
    if cmp -s "$out/plain-$h.txt" "$out/period4-$h.txt"; then
        echo "blur_same: 1920 x $h, $(grep -vc '^#' "$out/plain-$h.txt") frames, every hash the same with MAX_BLUR_PERIOD4"
    else
        echo "blur_same: 1920 x $h differs with MAX_BLUR_PERIOD4:" >&2
        diff "$out/plain-$h.txt" "$out/period4-$h.txt" | head -20 >&2 || true
        status=1
    fi
done
exit "$status"
