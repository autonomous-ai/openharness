#!/usr/bin/env bash
# Host tests for the Harness Pro Pod (main/ui/habitat/pod). Needs the generated Pro fonts, like run-pro.sh.
# host_stubs/ stands in for ESP-IDF headers the model includes but never calls (cJSON, through cable_client.h).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
generated="$here/../../prototype/pro-companion/generated"
if [[ ! -f "$generated/pro_fonts.c" ]]; then
    printf '%s\n' 'Missing generated Pro asset: pro_fonts.c' >&2
    printf '%s\n' 'From the repository root, run the documented generate_fonts.py command in devices/harness-device/prototype/pro-companion/README.md.' >&2
    exit 1
fi
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
hab="$here/../main/ui/habitat"

# Stack guard. Pod's model, nav and glue run on the cable_link task (6 KB stack, under display_lock); the render
# task (24 KB) draws. A frame over the limit overflows the small stack on the device ("Stack protection fault"),
# so every function frame is capped at compile time: -Wframe-larger-than with -Werror fails the suite.
cflags=(-std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}"
        -DDEVICE_PRO_COMPANION -DDEVICE_POD -DHT_FACE_PX=720 -I"$hab" -I"$here/../main" -I"$here/host_stubs")
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
cable_task=("$hab/pod/pod_model.c" "$hab/pod/pod_nav.c" "$hab/pod_glue.c")
render_task=("$hab/pod/pod_draw.c" "$hab/pod/pod_pet.c" "$hab/pod/pod_chrome.c" "$hab"/pod/pod_view*.c)
other=()
for f in "$hab"/pod/*.c; do
    case " ${cable_task[*]} ${render_task[*]} " in *" $f "*) ;; *) other+=("$f") ;; esac
done
build_obj 1024 "${cable_task[@]}"
build_obj 4096 "${render_task[@]}"
build_obj 100000 "${other[@]}" "$hab/scroll.c" "$hab/pro_canvas.c" "$hab/terminal.c" "$hab/fonts.c" "$generated/pro_fonts.c"

shopt -s nullglob
for t in "$here"/test_pod_*.c; do
    name="$(basename "$t" .c)"
    cc "${cflags[@]}" -o "$out/$name" "$t" "${objs[@]}"
    "$out/$name"
done
python3 "$here/test_pod_hello.py"
python3 "$here/test_pod_voice_gate.py"
