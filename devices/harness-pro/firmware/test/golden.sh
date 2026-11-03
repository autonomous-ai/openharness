#!/usr/bin/env bash
# Golden hashes of every Pets screen pod_render draws (dev tool for refactors that must not change a pixel).
#   test/golden.sh           writes the baseline: test/golden.txt, or test/golden-liberation.txt when PRO_FONT is Liberation
#   test/golden.sh --check   compares a fresh render with that baseline: exit 0 match, 1 differs, 2 no baseline
#   --skin pets              accepted and ignored (Pets is the only interface)
# Builds test/pod_render.c the way pod_render.py does, into test/out/golden/.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
out="$here/out/golden"
disp="$fw/main/display"
check=""
while [[ $# -gt 0 ]]; do
    case "$1" in --skin) shift ;; --check) check=1 ;; esac
    shift
done
case "${PRO_FONT:-}" in *Liberation*) base="$here/golden-liberation.txt" ;; *) base="$here/golden.txt" ;; esac
if [[ -n "$check" && ! -f "$base" ]]; then
    echo "golden: no baseline $base (run test/golden.sh first)" >&2
    exit 2
fi

mkdir -p "$out"
font_args=()
if [[ -n "${PRO_FONT:-}" ]]; then
    case "$PRO_FONT" in /*) ;; *) PRO_FONT="$fw/$PRO_FONT" ;; esac
    font_args=(--font "$PRO_FONT")
fi
python3 "$fw/scripts/gen_fonts.py" ${font_args[@]+"${font_args[@]}"} --out "$out/pro_fonts.c"
cc -std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O1 -g -DHT_FACE_PX=720 -I"$disp" -I"$fw/main" \
   -o "$out/pod_render" "$here/pod_render.c" "$fw"/main/pod/*.c "$fw"/main/pod/home/*.c "$disp/pro_canvas.c" "$disp/terminal.c" "$out/pro_fonts.c"

screens=(tabs tabs:bell tabs:mock tabs:0+2 tabs:2+2 tabs:long tabs:9 tabs:linkdown tabs:1 tabs:3 tabs:5 tabs:seven tabs:single tabs:notices tabs:working tabs:none home:swarm:p1 home:swarm:p2 home:swarm:stuck home:swarm:done home:swarm:many home:swarm:remote lead:loaded lead:ask lead:loading lead:none lead:remote lead:group lead:pm
    agent:fw agent:cli agent:be agent:desk agent:kilo agent:fw:long agent:cli:long agent:be:offline agent:fw:banner agent:cli:banner tabs:banner agent:fw:toast@0 agent:fw:toast@200 agent:fw:toast@2500 agent:fw:toast@4900
    agent:fw:toast:decision@2500 agent:fw:toast:stuck@9000
    recap:desk:toast@200 recap:desk:toast@2500 recap:docs:toast@4900
    recap:desk recap:desk:unread recap:desk:long recap:desk:viet recap:desk:short recap:desk:medium recap:docs:long recap:docs:unreadfail agent:fw:unread recap:docs recap:kilo recap:desk:testfail recap:desk:extreme recap:desk:banner
    talk:fw talk:fw:quiet talk:fw:send talk:cur talk:cur:send talk:be talk:be:send
    inbox inbox:viet inbox:quiet inbox:failed inbox:supertab inbox:swarm toast:swarm@0 toast:swarm@200 toast:swarm@2500 toast:swarm@4900 ota:0 ota:62 ota:100 ota:restart)
for s in "${screens[@]}"; do
    for now in 0 600 1234 2500 5000; do
        "$out/pod_render" "$s" "$out/r.ppm" "$now" >/dev/null
        echo "$(shasum -a 256 < "$out/r.ppm" | cut -d' ' -f1)  $s@$now"
    done
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
