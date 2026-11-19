#!/usr/bin/env bash
# Host tests for Harness Max's screen (main/app/max_ui_*.c) over the Pro's compositor at both glass heights, and the
# strip turn (main/display/max_turn.c) when it is there. Needs no arguments and no board. Fonts are generated into a temp
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

# Every test runs on both glasses: the ESP32-P4's 1920 x 480 and the demo bar's 1920 x 415 (MAX_HEIGHTS narrows it).
# The Pro's flags. Stack guard as the Pro's: the feeds run on the cable_link task and the finger on the touch task (1 KB
# frames), the drawing on the render task (4 KB frames).
glass() {   # glass <height>: cflags for that glass
    cflags=(-std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}"
            -DHT_WIDTH=1920 -DHT_HEIGHT="$1" -I"$fw/main/app" -I"$pro/main" -I"$pro/main/display")
}
build_obj() {   # build_obj <height> <limit-bytes> <source>...
    local h="$1" limit="$2"; shift 2
    local src o
    for src in "$@"; do
        o="$out/$h-$(basename "$src" .c).o"
        cc "${cflags[@]}" -Wframe-larger-than="$limit" -c -o "$o" "$src"
        objs+=("$o")
    done
}
for h in ${MAX_HEIGHTS:-480 415}; do
    echo "== 1920 x $h"
    glass "$h"
    objs=()
    build_obj "$h" 1024 "$fw"/main/app/max_ui_{model,touch,ask,form,nav}.c
    build_obj "$h" 4096 "$fw"/main/app/max_ui_{view,card,pet,overview,agent,lists,icons}.c "$pro/main/pod/pod_pet.c"
    build_obj "$h" 100000 "$pro/main/display/terminal.c" "$pro/main/display/pro_canvas.c" "$pro/main/pod/pod_draw.c" \
        "$pro"/main/pod/{pets,pets_ask,pets_codex,engine_logos}.c "$out/pro_fonts.c"

    for t in test_max_model test_max_ask test_max_form test_max_view test_max_touch; do
        cc "${cflags[@]}" -o "$out/$h-$t" "$here/$t.c" "${objs[@]}"
        "$out/$h-$t"
    done

    # Every golden screen draws within the run budget (max_render exits non-zero otherwise).
    cc "${cflags[@]}" -o "$out/$h-max_render" "$here/max_render.c" "${objs[@]}"
    "$out/$h-max_render" --check-all

    # The app layer (main/app/max_app.c) over the lanes model, with the device below it as host fakes. Its feeds run on
    # the cable_link task and its finger on the touch task: the model's 1 KB frame budget.
    cc "${cflags[@]}" -DPRO_DISPLAY_W=1920 -DPRO_DISPLAY_H="$h" -I"$fw/main" -I"$pro/test/host_esp" \
        -Wframe-larger-than=1024 -o "$out/$h-test_max_app" "$fw/main/app/max_app.c" "$here/test_max_app.c" "${objs[@]}"
    "$out/$h-test_max_app"
done

# The strip turn into the portrait panel (the platform's), on the ESP32-P4's glass.
if [[ -f "$here/test_max_turn.c" ]]; then
    glass 480
    cc "${cflags[@]}" -I"$fw/main/display" -o "$out/test_max_turn" "$fw/main/display/max_turn.c" "$here/test_max_turn.c"
    "$out/test_max_turn"
fi

# The scripted demo daemon (main/demo/), under its own sanitizers.
bash "$here/test_max_demo.sh"
echo "max run.sh: all host tests passed"
