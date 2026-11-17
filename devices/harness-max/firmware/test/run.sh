#!/usr/bin/env bash
# Host tests for Harness Max's screen (main/app/max_ui_*.c) over the Pro's compositor, and the strip turn
# (main/display/max_turn.c) when it is there. Needs no arguments and no board. Fonts are generated into a temp
# directory: PRO_FONT=/path/to/font.ttf overrides the generator's default, as the Pro's run.sh.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
pro="$(cd "$fw/../../harness-pro/firmware" && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

font_args=()
if [[ -n "${PRO_FONT:-}" ]]; then
    case "$PRO_FONT" in /*) ;; *) PRO_FONT="$pro/$PRO_FONT" ;; esac
    font_args=(--font "$PRO_FONT")
fi
python3 "$pro/scripts/gen_fonts.py" ${font_args[@]+"${font_args[@]}"} --out "$out/pro_fonts.c"

# The Pro's flags, on the 1920 x 480 glass. Stack guard as the Pro's: the feeds run on the cable_link task and the
# finger on the touch task (1 KB frames), the drawing on the render task (4 KB frames).
cflags=(-std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}"
        -DHT_WIDTH=1920 -DHT_HEIGHT=480 -I"$fw/main/app" -I"$pro/main" -I"$pro/main/display")
objs=()
build_obj() {   # build_obj <limit-bytes> <source>...
    local limit="$1"; shift
    local src o
    for src in "$@"; do
        o="$out/$(basename "$src" .c).o"
        cc "${cflags[@]}" -Wframe-larger-than="$limit" -c -o "$o" "$src"
        objs+=("$o")
    done
}
build_obj 1024 "$fw/main/app/max_ui_model.c" "$fw/main/app/max_ui_touch.c"
build_obj 4096 "$fw/main/app/max_ui_view.c"
build_obj 100000 "$pro/main/display/terminal.c" "$pro/main/display/pro_canvas.c" "$pro/main/pod/pod_draw.c" "$out/pro_fonts.c"

for t in test_max_model test_max_view test_max_touch; do
    cc "${cflags[@]}" -o "$out/$t" "$here/$t.c" "${objs[@]}"
    "$out/$t"
done

# Every golden screen draws within the run budget (max_render exits non-zero otherwise).
cc "${cflags[@]}" -o "$out/max_render" "$here/max_render.c" "${objs[@]}"
"$out/max_render" --check-all

# The app layer (main/app/max_app.c, the platform's) over the lanes model, with the device below it as host fakes. Its
# feeds run on the cable_link task and its finger on the touch task: the model's 1 KB frame budget.
cc "${cflags[@]}" -DPRO_DISPLAY_W=1920 -DPRO_DISPLAY_H=480 -I"$fw/main" -I"$pro/test/host_esp" -Wframe-larger-than=1024 \
    -o "$out/test_max_app" "$fw/main/app/max_app.c" "$here/test_max_app.c" "${objs[@]}"
"$out/test_max_app"

# The strip turn into the portrait panel (the platform's).
if [[ -f "$here/test_max_turn.c" ]]; then
    cc "${cflags[@]}" -I"$fw/main/display" -o "$out/test_max_turn" "$fw/main/display/max_turn.c" "$here/test_max_turn.c"
    "$out/test_max_turn"
fi
echo "max run.sh: all host tests passed"
