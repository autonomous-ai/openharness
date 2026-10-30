#!/usr/bin/env bash
# Host tests for the Harness Pro firmware's pure C (main/pod and the compositor in main/display).
# Needs no arguments and no board. Fonts are generated into a temp directory: set PRO_FONT=/path/to/font.ttf
# to override the generator's default (macOS Helvetica when present, else the bundled Liberation Sans).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
disp="$fw/main/display"
pod="$fw/main/pod"

# Plain python3 with Pillow, not the ESP-IDF virtualenv (it has none): the generator needs PIL.
font_args=()
if [[ -n "${PRO_FONT:-}" ]]; then
    case "$PRO_FONT" in /*) ;; *) PRO_FONT="$fw/$PRO_FONT" ;; esac
    font_args=(--font "$PRO_FONT")
fi
python3 "$fw/scripts/gen_fonts.py" ${font_args[@]+"${font_args[@]}"} --out "$out/pro_fonts.c"
python3 "$fw/scripts/gen_ph_spark.py" --check   # the voice sparkle baked from the round's glyph
python3 "$fw/scripts/gen_pro_codex.py" --check
python3 "$here/test_pro_codex.py"
python3 "$fw/scripts/gen_pro_ask.py" --check   # the asking look: the "?" bubble and Claude's raised hand
python3 "$here/test_pro_ask.py"
python3 "$here/codex_size.py"   # Codex's on-screen size against the pre-change baseline

# Stack guard. Pod's model, nav and glue run on the cable_link task (STACK_CABLE_LINK, 12 KB, under pro_app_lock); the
# render task (24 KB) draws. A frame over the limit overflows the stack on the device ("Stack protection fault"), so
# every function frame is capped at compile time: -Wframe-larger-than with -Werror fails the suite. The caps (1 KB for
# the cable task's code) predate the 12 KB stack and are kept: a tighter cap than the stack needs is only margin.
# -D_DEFAULT_SOURCE: glibc hides POSIX calls (strnlen, strcasecmp) under a strict -std=c11; newlib and macOS do not.
cflags=(-std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}"
        -DHT_FACE_PX=720 -I"$disp" -I"$fw/main")
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
cable_task=("$pod/pod_model.c" "$pod/pod_nav.c")
cable_task+=("$fw/main/app/pod_glue.c")
render_task=("$pod/pod_draw.c" "$pod/pod_pet.c" "$pod/pod_view.c" "$pod/pod_shared.c" "$pod/pod_time.c" "$pod"/home/*.c)
other=()
for f in "$pod"/*.c; do
    case " ${cable_task[*]} ${render_task[*]} " in *" $f "*) ;; *) other+=("$f") ;; esac
done
build_obj 1024 "${cable_task[@]}"
build_obj 4096 "${render_task[@]}"
build_obj 100000 "${other[@]}" "$disp/scroll.c" "$disp/pro_canvas.c" "$disp/terminal.c" "$out/pro_fonts.c"

shopt -s nullglob
for t in "$here"/test_pod_*.c; do
    name="$(basename "$t" .c)"
    cc "${cflags[@]}" -o "$out/$name" "$t" "${objs[@]}"
    "$out/$name"
done

cc "${cflags[@]}" -o "$out/test_ph_views" "$here/test_ph_views.c" "${objs[@]}"
"$out/test_ph_views"
cc "${cflags[@]}" -o "$out/test_ph_glue" "$here/test_ph_glue.c" "${objs[@]}"
"$out/test_ph_glue"
cc "${cflags[@]}" -o "$out/test_ph_talk" "$here/test_ph_talk.c" "${objs[@]}"
"$out/test_ph_talk"

# Pets Home paints the whole canvas PH_HOME_BG (#151413); pod_render is the entry the golden uses.
cc "${cflags[@]}" -o "$out/pod_render" "$here/pod_render.c" "${objs[@]}"
"$out/pod_render" tabs "$out/pets.ppm" >/dev/null
px="$(dd if="$out/pets.ppm" bs=1 skip=$(( 15 + (690 * 720 + 10) * 3 )) count=3 2>/dev/null | od -An -tx1 | tr -d ' \n')"
# #151413 through RGB565 and back to the PPM's 8 bits is 101410.
[[ "$px" == "101410" ]] || { echo "run.sh: pets pixel (10,690) is $px, want 101410 (#151413 in RGB565)" >&2; exit 1; }
echo "pets home: pixel (10,690) = #151413"

# Pets render time: every screen within 85% of its pre-change host time (test_ph_perf.sh; opt-in: runs only with PH_PERF=1, since absolute host microseconds are flaky on CI machines).
bash "$here/test_ph_perf.sh"

# pro_frame: the strip math against a fake 720 x 720 panel. Same objects
# as the Pod tests (terminal.c, pro_canvas.c, the fonts).
cc "${cflags[@]}" -Wframe-larger-than=2048 -I"$fw/test/host_esp" -c -o "$out/pro_frame.o" "$disp/pro_frame.c"
cc "${cflags[@]}" -I"$fw/test/host_esp" -o "$out/test_pro_frame" "$fw/test/test_pro_frame.c" "$out/pro_frame.o" "${objs[@]}"
"$out/test_pro_frame"

# pro_cable: the daemon's JSON in, pro_app_* out. Real cJSON from the ESP-IDF checkout (CI has the sparse one at
# $IDF_PATH), a recording stub of pro_app_api.h and a stub cable_link (test_pro_cable.c).
IDF_PATH="${IDF_PATH:-$HOME/esp/esp-idf-5.5.4}"
cjson="$IDF_PATH/components/json/cJSON"
if [[ ! -f "$cjson/cJSON.c" ]]; then
    echo "run.sh: cJSON not found at $cjson (set IDF_PATH to an ESP-IDF checkout that has components/json)" >&2
    exit 1
fi
cable="$fw/main/cable"
cc_flags=(-std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}"
          -I"$fw/main" -I"$cable" -I"$here/host_esp" -I"$cjson")
cobjs=()
cable_obj() {   # cable_obj <limit-bytes> <source>...  (every frame capped at 1 KB, as the cable_link task's stack wants)
    local limit="$1"; shift
    local src o
    for src in "$@"; do
        o="$out/cable_$(basename "$src" .c).o"
        cc "${cc_flags[@]}" -Wframe-larger-than="$limit" -c -o "$o" "$src"
        cobjs+=("$o")
    done
}
cable_obj 1024 "$cable/pro_cable.c" "$cable/cable_json_guard.c" "$cable/cable_features.c" "$cable/cable_machines.c" \
               "$cable/cable_scroll.c" "$cable/cable_frame.c"
cc -std=c11 -D_DEFAULT_SOURCE -w -O1 -g -c -o "$out/cJSON.o" "$cjson/cJSON.c"
cc "${cc_flags[@]}" -o "$out/test_pro_cable" "$here/test_pro_cable.c" "${cobjs[@]}" "$out/cJSON.o" \
   -lpthread -lm
"$out/test_pro_cable"

# cable_link: the reader's partial-frame timeout and counters. The test includes cable_link.c (to drive its static
# reader step on a fake clock) with the USB driver and FreeRTOS as stubs; the file itself is also built stack-capped.
cc "${cc_flags[@]}" -I"$fw/main/sys" -Wframe-larger-than=1024 -c -o "$out/cable_link.o" "$cable/cable_link.c"
cc "${cc_flags[@]}" -I"$fw/main/sys" -o "$out/test_cable_link" "$here/test_cable_link.c" "$cable/cable_frame.c"
"$out/test_cable_link"

# fw_update: the OTA receiver over an in-memory partition (host_esp has the esp_ota_ops / partition / sha256 stand-ins;
# the cable and UI hooks are recorded by the test). Stack-capped like the rest of the cable task's code.
cc "${cc_flags[@]}" -DFW_UPDATE_HOST_TEST -Wframe-larger-than=1024 -c -o "$out/fw_update.o" "$fw/main/sys/fw_update.c"
cc "${cc_flags[@]}" -I"$fw/main/sys" -o "$out/test_fw_update" "$here/test_fw_update.c" "$out/fw_update.o"
"$out/test_fw_update"

# crash_record: the RTC breadcrumb record's phases and text (the pure half of last_words.c).
cc "${cc_flags[@]}" -Wframe-larger-than=1024 -c -o "$out/crash_record.o" "$fw/main/sys/crash_record.c"
cc "${cc_flags[@]}" -I"$fw/main/sys" -o "$out/test_crash_record" "$here/test_crash_record.c" "$out/crash_record.o"
"$out/test_crash_record"
# wdt_pc: the bootloader hook that saves each core's PC and SP after a watchdog reset, on a fake register file.
cc "${cc_flags[@]}" -I"$fw/main/sys" -o "$out/test_wdt_pc_hook" "$here/test_wdt_pc_hook.c" "$fw/bootloader_components/wdt_pc/wdt_pc.c"
"$out/test_wdt_pc_hook"

# The app layer: pro_app.c, pod_glue.c and pro_touch.c with the cable, the recorder and the clock as host stubs,
# replayed. It builds its own fonts and objects.
python3 "$here/test_pro_app.py"

python3 "$here/test_pro_hello.py"

python3 "$here/test_logos.py"

# The voice path: pro_app's gate and effects over the real audio/pro_voice.c state machine, with the recorder, the
# cable and the clock as host fakes (the 9 replays of the round firmware plus the link-drop and timer cases).
python3 "$here/test_pro_voice_gate.py"
