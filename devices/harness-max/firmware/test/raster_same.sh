#!/usr/bin/env bash
# Does the Max's compositor still paint every pixel as it did at <git-ref>? For work on its speed, which must not
# change one. Builds test/raster_dump.c over this tree's terminal.c, pro_canvas.c and pod_draw.c (the Max's copies in
# main/pro_fork/) and again over those three files at <git-ref>: the Max's copies when <git-ref> has them, else the
# Pro's own, from before the Max had copies (everything else, the headers included, is this tree's). On both glasses,
# it compares what the two print: every Max screen and random scenes of the reworked kinds, through many clips.
#   test/raster_same.sh <git-ref>     exit 0 every hash the same, 1 one differs
set -euo pipefail
ref="${1:?usage: test/raster_same.sh <git-ref>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
pro="$(cd "$fw/../../harness-pro/firmware" && pwd)"
source "$here/max_tree.sh"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

mkdir -p "$out/old/display" "$out/old/pod"
for f in display/terminal.c display/pro_canvas.c pod/pod_draw.c; do
    git -C "$fw" show "$ref:./main/pro_fork/$f" > "$out/old/$f" 2>/dev/null || git -C "$pro" show "$ref:./main/$f" > "$out/old/$f"
done
python3 "$pro/scripts/gen_fonts.py" --out "$out/pro_fonts.c" >/dev/null
# The Max's screen asks its pod_draw.c for a bake a band of rows at a time (pod_cell_bake_some, only while it paints
# ahead, which raster_dump does not); one from before that has none, so there it is always "no room".
old_extra=()
if ! grep -q pod_cell_bake_some "$out/old/pod/pod_draw.c"; then
    printf '%s\n' '#include "max_ui_draw.h"' \
        'int pod_cell_bake_some(const ht_run_t *r, int px) { (void)r; (void)px; return -1; }' > "$out/old/bake_some.c"
    old_extra=("$out/old/bake_some.c")
fi

dump() {   # dump <old|new> <height>: build and run raster_dump over that compositor, into $out/<side>-<height>.txt
    local side="$1" h="$2" compositor
    if [[ $side == old ]]; then
        compositor=("$out/old/display/terminal.c" "$out/old/display/pro_canvas.c" "$out/old/pod/pod_draw.c" ${old_extra[@]+"${old_extra[@]}"})
    else compositor=("${max_compositor[@]}"); fi
    # The Pro's main/pod/ on the path: a Pro file from before the copies names its pod_draw.h from beside it.
    cc -std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O1 -g -fsanitize=undefined,bounds -DHT_WIDTH=1920 -DHT_HEIGHT="$h" \
       "${max_pro_flags[@]}" -I"$fw/main/app" -I"$pro/main" -I"$pro/main/display" -I"$pro/main/pod" -o "$out/dump-$side-$h" \
       "$here/raster_dump.c" "$fw"/main/app/max_ui_*.c "${compositor[@]}" \
       "$pro"/main/pod/{pod_pet,pets,pets_ask,pets_codex,engine_logos}.c "$out/pro_fonts.c"
    "$out/dump-$side-$h" > "$out/$side-$h.txt"
}
heights=(${MAX_HEIGHTS:-480 415})
pids=()
for h in "${heights[@]}"; do
    for side in old new; do dump "$side" "$h" & pids+=($!); done
done
for pid in "${pids[@]}"; do wait "$pid"; done   # set -e: a build or run that failed fails the check

status=0
for h in "${heights[@]}"; do
    if cmp -s "$out/old-$h.txt" "$out/new-$h.txt"; then
        echo "raster_same: 1920 x $h, $(($(wc -l < "$out/new-$h.txt") - 1)) scenes x 5 clip sets, every hash as at $ref"
    else
        echo "raster_same: 1920 x $h differs from $ref:" >&2
        diff "$out/old-$h.txt" "$out/new-$h.txt" | head -20 >&2 || true
        status=1
    fi
done
exit "$status"
