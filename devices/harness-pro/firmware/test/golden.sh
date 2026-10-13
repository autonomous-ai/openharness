#!/usr/bin/env bash
# Golden hashes of every Pod screen pod_render draws (dev tool for refactors that must not change a pixel).
#   test/golden.sh           writes the baseline: test/golden.txt, or test/golden-liberation.txt when PRO_FONT is Liberation
#   test/golden.sh --check   compares a fresh render with that baseline: exit 0 match, 1 differs, 2 no baseline
# Builds test/pod_render.c the way pod_render.py does, into test/out/golden/.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
out="$here/out/golden"
disp="$fw/main/display"
case "${PRO_FONT:-}" in *Liberation*) base="$here/golden-liberation.txt" ;; *) base="$here/golden.txt" ;; esac
if [[ "${1:-}" == "--check" && ! -f "$base" ]]; then
    echo "golden: no baseline $base (run test/golden.sh first)" >&2
    exit 2
fi

mkdir -p "$out"
font_args=()
if [[ -n "${PRO_FONT:-}" ]]; then
    case "$PRO_FONT" in /*) ;; *) PRO_FONT="$fw/$PRO_FONT" ;; esac
    font_args=(--font "$PRO_FONT")
fi
/usr/local/bin/python3 "$fw/scripts/gen_fonts.py" ${font_args[@]+"${font_args[@]}"} --out "$out/pro_fonts.c"
cc -std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O1 -g -DHT_FACE_PX=720 -I"$disp" -I"$fw/main" -I"$here/host_stubs" \
   -o "$out/pod_render" "$here/pod_render.c" "$fw"/main/pod/*.c "$disp/pro_canvas.c" "$disp/terminal.c" "$out/pro_fonts.c"

screens=(tabs tabs:1 tabs:mock default default:tab default:talk recent chrome chrome:talk tab:{0..5} ota:0 ota:42 ota:100 ota:restart notice:updated notice:failed)
for k in agent recap talk; do
    for id in fw ota be cli web desk docs vault site cur notes2 kilo; do screens+=("$k:$id"); done
done
for s in "${screens[@]}"; do
    for now in 0 600 1234 2500 5000; do
        "$out/pod_render" "$s" "$out/r.ppm" "$now" >/dev/null
        echo "$(shasum -a 256 < "$out/r.ppm" | cut -d' ' -f1)  $s@$now"
    done
done | LC_ALL=C sort > "$out/now.txt"

if [[ "${1:-}" != "--check" ]]; then
    cp "$out/now.txt" "$base"
    echo "golden: wrote $(wc -l < "$base" | tr -d ' ') screens to $base"
elif diff "$base" "$out/now.txt" > "$out/diff.txt"; then
    echo "golden: $(wc -l < "$base" | tr -d ' ') screens match"
else
    echo "golden: differing screens:" >&2
    grep '^>' "$out/diff.txt" | awk '{print "  " $3}' >&2
    exit 1
fi
