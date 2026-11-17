#!/usr/bin/env bash
# Golden hashes of every Harness Max screen max_render draws.
#   test/golden.sh           writes the baseline: test/golden.txt, or test/golden-liberation.txt when PRO_FONT is Liberation
#   test/golden.sh --check   compares a fresh render with that baseline: exit 0 match, 1 differs, 2 no baseline
# Builds test/max_render.c into test/out/golden/, with the Pro's compositor and fonts.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
pro="$(cd "$fw/../../harness-pro/firmware" && pwd)"
out="$here/out/golden"
check=""
[[ "${1:-}" == "--check" ]] && check=1
case "${PRO_FONT:-}" in *Liberation*) base="$here/golden-liberation.txt" ;; *) base="$here/golden.txt" ;; esac
if [[ -n "$check" && ! -f "$base" ]]; then
    echo "golden: no baseline $base (run test/golden.sh first)" >&2
    exit 2
fi

mkdir -p "$out"
font_args=()
if [[ -n "${PRO_FONT:-}" ]]; then
    case "$PRO_FONT" in /*) ;; *) PRO_FONT="$pro/$PRO_FONT" ;; esac
    font_args=(--font "$PRO_FONT")
fi
python3 "$pro/scripts/gen_fonts.py" ${font_args[@]+"${font_args[@]}"} --out "$out/pro_fonts.c"
disp="$pro/main/display"
cc -std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O1 -g -DHT_WIDTH=1920 -DHT_HEIGHT=480 \
   -I"$fw/main/app" -I"$pro/main" -I"$disp" -o "$out/max_render" "$here/max_render.c" "$fw"/main/app/max_ui_*.c \
   "$disp/terminal.c" "$disp/pro_canvas.c" "$pro/main/pod/pod_draw.c" "$out/pro_fonts.c"

for s in $("$out/max_render" --list); do
    "$out/max_render" "$s" "$out/r.ppm" >/dev/null
    echo "$(shasum -a 256 < "$out/r.ppm" | cut -d' ' -f1)  $s"
done | LC_ALL=C sort > "$out/now.txt"

if [[ -z "$check" ]]; then
    cp "$out/now.txt" "$base"
    echo "golden: wrote $(wc -l < "$base" | tr -d ' ') screens to $base"
elif diff "$base" "$out/now.txt" > "$out/diff.txt"; then
    echo "golden: $(wc -l < "$base" | tr -d ' ') screens match"
else
    echo "golden: differing screens:" >&2
    grep '^>' "$out/diff.txt" | awk '{print "  " $3}' >&2
    exit 1
fi
