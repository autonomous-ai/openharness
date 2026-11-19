#!/usr/bin/env bash
# Where the renderer's time goes on this computer (bench/max_profile.c): every Harness Max screen rasterised whole at
# 1920 x 480, split by run kind. Built at -O2, the device's optimisation (CONFIG_COMPILER_OPTIMIZATION_PERF), into
# bench/build-host/. PRO_FONT=/path/font.ttf picks the text face as golden.sh does.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
pro="$(cd "$fw/../../harness-pro/firmware" && pwd)"
source "$fw/test/max_tree.sh"
out="$here/build-host"
mkdir -p "$out"
font_args=()
if [[ -n "${PRO_FONT:-}" ]]; then
    case "$PRO_FONT" in /*) ;; *) PRO_FONT="$pro/$PRO_FONT" ;; esac
    font_args=(--font "$PRO_FONT")
fi
python3 "$pro/scripts/gen_fonts.py" ${font_args[@]+"${font_args[@]}"} --out "$out/pro_fonts.c"
cc -std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O2 -g \
   -DHT_WIDTH=1920 -DHT_HEIGHT=480 -DPRO_DISPLAY_W=1920 -DPRO_DISPLAY_H=480 "${max_pro_flags[@]}" \
   -I"$here" -I"$fw/test" -I"$fw/main/app" -I"$fw/main/display" -I"$pro/main" -I"$pro/main/display" \
   -o "$out/max_profile" "$here/max_profile.c" "$here/bench_scenes.c" "$here/bench_raster.c" \
   "$fw/main/display/max_turn.c" "$fw"/main/app/max_ui_*.c "${max_compositor[@]}" \
   "$pro"/main/pod/{pod_pet,pets,pets_ask,pets_codex,engine_logos}.c "$out/pro_fonts.c"
"$out/max_profile"
