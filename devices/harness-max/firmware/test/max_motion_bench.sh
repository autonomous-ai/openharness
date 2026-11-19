#!/usr/bin/env bash
# Builds and runs test/max_motion_bench.c on both glasses (1920 x 480 and 1920 x 415), at -O2 as the firmware is built,
# then again with the compiler's vectoriser off: the P4's compiler does not vectorise these loops, so that run's shares
# are the nearer guess of the chip's. Dev tool, not a test: it prints, it never fails on a number.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
pro="$(cd "$fw/../../harness-pro/firmware" && pwd)"
source "$here/max_tree.sh"
out="$here/out/bench"
mkdir -p "$out"
font_args=()
if [[ -n "${PRO_FONT:-}" ]]; then
    case "$PRO_FONT" in /*) ;; *) PRO_FONT="$pro/$PRO_FONT" ;; esac
    font_args=(--font "$PRO_FONT")
fi
python3 "$pro/scripts/gen_fonts.py" ${font_args[@]+"${font_args[@]}"} --out "$out/pro_fonts.c" >/dev/null
if cc --version 2>/dev/null | grep -q clang; then scalar=(-fno-vectorize -fno-slp-vectorize); else scalar=(-fno-tree-vectorize); fi
disp="$pro/main/display"
for mode in vector scalar; do
    flags=()
    [[ "$mode" == scalar ]] && flags=("${scalar[@]}")
    echo "== -O2 $mode"
    for h in 480 415; do
        exe="$out/max_motion_bench-$h-$mode"
        cc -std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O2 ${flags[@]+"${flags[@]}"} -DHT_WIDTH=1920 -DHT_HEIGHT="$h" \
           "${max_pro_flags[@]}" -I"$here" -I"$fw/main/app" -I"$pro/main" -I"$disp" -o "$exe" "$here/max_motion_bench.c" \
           "$fw"/main/app/max_ui_*.c "${max_compositor[@]}" "$pro"/main/pod/{pod_pet,pets,pets_ask,pets_codex,engine_logos}.c \
           "$out/pro_fonts.c"
        "$exe" "$@"
    done
done
