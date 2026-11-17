#!/usr/bin/env bash
# Golden hashes of every Harness Max screen max_render draws, on both glasses: 1920 x 480 and the demo bar's 1920 x 415.
#   test/golden.sh           writes the baselines: test/golden.txt and test/golden-415.txt, or test/golden-liberation.txt
#                            and test/golden-liberation-415.txt when PRO_FONT is Liberation
#   test/golden.sh --check   compares a fresh render with them: exit 0 all match, 1 one differs, 2 a baseline is missing
# Builds test/max_render.c into test/out/golden/, with the Pro's compositor and fonts.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
pro="$(cd "$fw/../../harness-pro/firmware" && pwd)"
out="$here/out/golden"
check=""
[[ "${1:-}" == "--check" ]] && check=1
case "${PRO_FONT:-}" in *Liberation*) stem="$here/golden-liberation" ;; *) stem="$here/golden" ;; esac
baseline() { [[ "$1" == 480 ]] && echo "$stem.txt" || echo "$stem-$1.txt"; }   # 480 keeps its first name
heights=(480 415)
if [[ -n "$check" ]]; then
    for h in "${heights[@]}"; do
        if [[ ! -f "$(baseline "$h")" ]]; then
            echo "golden: no baseline $(baseline "$h") (run test/golden.sh first)" >&2
            exit 2
        fi
    done
fi

mkdir -p "$out"
font_args=()
if [[ -n "${PRO_FONT:-}" ]]; then
    case "$PRO_FONT" in /*) ;; *) PRO_FONT="$pro/$PRO_FONT" ;; esac
    font_args=(--font "$PRO_FONT")
fi
python3 "$pro/scripts/gen_fonts.py" ${font_args[@]+"${font_args[@]}"} --out "$out/pro_fonts.c"
disp="$pro/main/display"
status=0
for h in "${heights[@]}"; do
    exe="$out/max_render-$h" base="$(baseline "$h")" now="$out/now-$h.txt"
    cc -std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O1 -g -DHT_WIDTH=1920 -DHT_HEIGHT="$h" \
       -I"$fw/main/app" -I"$pro/main" -I"$disp" -o "$exe" "$here/max_render.c" "$fw"/main/app/max_ui_*.c \
       "$disp/terminal.c" "$disp/pro_canvas.c" "$pro/main/pod/pod_draw.c" "$out/pro_fonts.c"
    for s in $("$exe" --list); do
        "$exe" "$s" "$out/r.ppm" >/dev/null
        echo "$(shasum -a 256 < "$out/r.ppm" | cut -d' ' -f1)  $s"
    done | LC_ALL=C sort > "$now"

    if [[ -z "$check" ]]; then
        cp "$now" "$base"
        echo "golden: wrote $(wc -l < "$base" | tr -d ' ') screens at $h to $base"
    elif diff "$base" "$now" > "$out/diff-$h.txt"; then
        echo "golden: $(wc -l < "$base" | tr -d ' ') screens at $h match"
    else
        echo "golden: differing screens at $h:" >&2
        grep '^>' "$out/diff-$h.txt" | awk '{print "  " $3}' >&2
        status=1
    fi
done
exit "$status"
