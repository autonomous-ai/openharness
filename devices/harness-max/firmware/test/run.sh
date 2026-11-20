#!/usr/bin/env bash
# Host tests for Harness Max's screen (main/app/max_ui_*.c) over its compositor (main/pro_fork/, its copies of the Pro's)
# at both glass heights, its frame path on two tasks (main/display/max_present.c), the P4's strips
# (main/display/max_strips.c), the strip turn (main/display/max_turn.c) when it is there, and its cable. Needs no
# arguments and no board. Fonts are generated into a temp
# directory: PRO_FONT=/path/to/font.ttf overrides the generator's default, as the Pro's run.sh.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
pro="$(cd "$fw/../../harness-pro/firmware" && pwd)"
source "$here/max_tree.sh"
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
            -DHT_WIDTH=1920 -DHT_HEIGHT="$1" "${max_pro_flags[@]}" -I"$fw/main/app" -I"$pro/main" -I"$pro/main/display")
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
# test_max_present's FreeRTOS and ESP-IDF calls: the Linux build's (linux/esp/).
present=(-DPROJECT_VER='"host-test"' -DPRO_DISPLAY_W=1920 -I"$here" -I"$fw/main/display" -I"$fw/linux/esp/include")
linux_rtos=("$fw/linux/esp/rtos.c" "$fw/linux/esp/esp.c")
for h in ${MAX_HEIGHTS:-480 415}; do
    echo "== 1920 x $h"
    glass "$h"
    objs=()
    build_obj "$h" 1024 "$fw"/main/app/max_ui_{model,touch,ask,form,nav,row}.c
    build_obj "$h" 4096 "$fw"/main/app/max_ui_{view,card,pet,overview,agent,lists,icons,layer,warm}.c "$pro/main/pod/pod_pet.c"
    build_obj "$h" 100000 "${max_compositor[@]}" "$pro"/main/pod/{pets,pets_ask,pets_codex,engine_logos}.c "$out/pro_fonts.c"

    for t in test_max_model test_max_ask test_max_form test_max_view test_max_touch test_max_motion test_max_loops \
             test_max_warm; do
        cc "${cflags[@]}" -o "$out/$h-$t" "$here/$t.c" "${objs[@]}" -lm   # test_max_motion: its plain filter
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

    # Max's frame path (main/display/max_present.c), its render task and helper on the Linux build's FreeRTOS
    # (pthreads), over a fake panel: the glass is the scene's whichever task painted a strip. Render-task frames (4 KB).
    cc "${cflags[@]}" "${present[@]}" -DPRO_DISPLAY_H="$h" -Wframe-larger-than=4096 -o "$out/$h-test_max_present" \
        "$here/test_max_present.c" "$fw/main/display/max_present.c" "${linux_rtos[@]}" "${objs[@]}"
    "$out/$h-test_max_present"
done

# The same under ThreadSanitizer, on the ESP32-P4's glass: what the two tasks share, the compositor included.
glass 480
cflags=("${cflags[@]/-fsanitize=*/-fsanitize=thread}")
cc "${cflags[@]}" "${present[@]}" -DPRO_DISPLAY_H=480 -o "$out/test_max_present_tsan" "$here/test_max_present.c" \
    "$fw/main/display/max_present.c" "${linux_rtos[@]}" "$fw"/main/app/max_ui_*.c "${max_compositor[@]}" \
    "$pro"/main/pod/{pod_pet,pets,pets_ask,pets_codex,engine_logos}.c "$out/pro_fonts.c"
"$out/test_max_present_tsan"

# The strip turn into the portrait panel (the platform's), on the ESP32-P4's glass.
if [[ -f "$here/test_max_turn.c" ]]; then
    glass 480
    cc "${cflags[@]}" -I"$fw/main/display" -o "$out/test_max_turn" "$fw/main/display/max_turn.c" "$here/test_max_turn.c"
    "$out/test_max_turn"
fi

# The glass shrunk into a band of the desk Harness Pro's panel, for the stopgap image built in on-pro/ (max_shrink.c).
if [[ -f "$fw/on-pro/main/max_shrink.c" ]]; then
    glass 480
    cc "${cflags[@]}" -I"$fw/on-pro/main" -o "$out/test_max_shrink" "$fw/on-pro/main/max_shrink.c" \
        "$here/test_max_shrink.c" -lm
    "$out/test_max_shrink"
fi

# The ESP32-P4's strips (main/display/max_strips.c) over a fake PPA that lands a turn, leaves it waiting for the next,
# never lands it or refuses it, on the Linux build's FreeRTOS.
glass 480
cc "${cflags[@]}" "${present[@]}" -DPRO_DISPLAY_H=480 -o "$out/test_max_strips" "$here/test_max_strips.c" \
    "$fw/main/display/max_strips.c" "$fw/main/display/max_turn.c" "${linux_rtos[@]}"
"$out/test_max_strips"

# The Max's cable (main/pro_fork/cable/pro_cable.c): the daemon's JSON in, pro_app_* out, over the real cJSON (CJSON_DIR,
# else ESP-IDF's, as test_max_demo.sh), the Pro's cable helpers as they are, a recording stub of the Max's pro_app_api.h
# and a stub cable_link (test_max_cable.c). On the cable_link task: every frame capped at 1 KB, as the Pro's.
cjson="${CJSON_DIR:-${IDF_PATH:-$HOME/esp/esp-idf-5.5.4}/components/json/cJSON}"
if [[ ! -f "$cjson/cJSON.c" ]]; then
    echo "run.sh: no cJSON.c in $cjson: set CJSON_DIR, or IDF_PATH to ESP-IDF" >&2
    exit 1
fi
cable_flags=(-std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}"
             -DHT_WIDTH=1920 -DHT_HEIGHT=480 "${max_pro_flags[@]}" -I"$fw/main" -I"$pro/main" -I"$pro/main/display"
             -I"$pro/main/cable" -I"$pro/test/host_esp" -I"$cjson")
cable_objs=()
for src in "$fw/main/pro_fork/cable/pro_cable.c" "$fw/main/cable/max_cable_features.c" \
           "$pro"/main/cable/{cable_json_guard,cable_features,cable_machines,cable_scroll,cable_frame}.c; do
    cc "${cable_flags[@]}" -Wframe-larger-than=1024 -c -o "$out/cable-$(basename "$src" .c).o" "$src"
    cable_objs+=("$out/cable-$(basename "$src" .c).o")
done
cc -std=c11 -D_DEFAULT_SOURCE -w -O1 -g -c -o "$out/cJSON.o" "$cjson/cJSON.c"
cc "${cable_flags[@]}" -o "$out/test_max_cable" "$here/test_max_cable.c" "${cable_objs[@]}" "$out/cJSON.o" -lpthread -lm
"$out/test_max_cable"
# Its hello: the Pro's keys with the Max's board and capabilities (send_hello lifted out and run over stubs).
python3 "$here/test_max_hello.py"

# The scripted demo daemon (main/demo/), under its own sanitizers.
bash "$here/test_max_demo.sh"

# Has a Pro file the Max forks or leans on changed since it was copied (main/pro_fork/upstream.txt)? A report here, not a
# failure: the Pro's changes are its own, and scripts/check_pro_forks.py, which fails on one, is run at each merge of main.
python3 "$fw/scripts/check_pro_forks.py" --warn
echo "max run.sh: all host tests passed"
