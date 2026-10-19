#!/usr/bin/env bash
# Pets render-time check: the host time of every Pets screen (the whole 720 x 720 frame rasterised in 24-row strips,
# like the panel, -O2, best of many runs) must be at most 85% of its pre-change value in test/ph_perf_baseline.txt.
#   PH_PERF=1 test/test_ph_perf.sh   check. Opt-in: run.sh skips it otherwise, because absolute microseconds recorded on a developer
#                                     Mac (default font) mean little on shared or Linux CI machines
#   PH_PERF_RECORD=1              print fresh numbers in the baseline's format instead of checking
#   PH_PERF_RUNS=N                tool runs per screen (default 7; the tool itself takes the best of 50 passes in each)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
if [[ "${PH_PERF:-}" != 1 && "${PH_PERF_RECORD:-}" != 1 ]]; then echo "perf check skipped (set PH_PERF=1)"; exit 0; fi
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
disp="$fw/main/display"
font_args=()
if [[ -n "${PRO_FONT:-}" ]]; then
    case "$PRO_FONT" in /*) ;; *) PRO_FONT="$fw/$PRO_FONT" ;; esac
    font_args=(--font "$PRO_FONT")
fi
python3 "$fw/scripts/gen_fonts.py" ${font_args[@]+"${font_args[@]}"} --out "$out/pro_fonts.c"
cc -std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O2 -DHT_FACE_PX=720 -I"$disp" -I"$fw/main" \
   -o "$out/pod_render" "$here/pod_render.c" "$fw"/main/pod/*.c "$fw"/main/pod/home/*.c \
   "$disp/pro_canvas.c" "$disp/terminal.c" "$out/pro_fonts.c"

screens=(tabs:working tabs:working:codex tabs tabs:2 tabs:notices agent:fw agent:cli recap:desk talk:fw talk:fw:send inbox agent:fw:toast@2500 recap:desk:toast@2500 agent:be talk:be talk:be:send)
runs="${PH_PERF_RUNS:-7}"
measure() {   # measure <screen>: the best strips24 time over $runs runs
    local best=999999999 i us
    for ((i = 0; i < runs; i++)); do
        us="$("$out/pod_render" "time:$1" /dev/null | sed -n 's/.*strips24 best \([0-9]*\) us.*/\1/p')"
        (( us < best )) && best=$us
    done
    echo "$best"
}
if [[ "${PH_PERF_RECORD:-}" == 1 ]]; then
    for s in "${screens[@]}"; do echo "$s $(measure "$s")"; done
    exit 0
fi
fail=0
for s in "${screens[@]}"; do
    base="$(awk -v s="$s" '$1 == s { print $2 }' "$here/ph_perf_baseline.txt")"
    [[ -n "$base" ]] || { echo "cs perf: no baseline for $s" >&2; exit 1; }
    now="$(measure "$s")"
    limit=$(( base * 85 / 100 ))
    if (( now > limit )); then echo "cs perf: $s took $now us, limit $limit us (0.85 x $base)" >&2; fail=1
    else echo "cs perf: $s $now us <= $limit us (was $base)"; fi
done
exit $fail
