#!/usr/bin/env bash
# Host tests for the scripted demo daemon (main/demo/max_demo.c), under the address and undefined-behaviour
# sanitizers. The demo parses what the device sends with ESP-IDF's cJSON, as the firmware does: CJSON_DIR, else
# $IDF_PATH or ~/esp/esp-idf-5.5.4 (as linux/deploy-orangepi.sh).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
pro="$(cd "$fw/../../harness-pro/firmware" && pwd)"
cjson="${CJSON_DIR:-${IDF_PATH:-$HOME/esp/esp-idf-5.5.4}/components/json/cJSON}"
if [[ ! -f "$cjson/cJSON.c" ]]; then
    echo "test_max_demo.sh: no cJSON.c in $cjson: set CJSON_DIR, or IDF_PATH to ESP-IDF" >&2
    exit 1
fi
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

san=(-fsanitize="${SANITIZERS:-undefined,address}" -fno-sanitize-recover=all -fno-omit-frame-pointer)
# The firmware's own flags; the frame limit is the cable_link task's budget, where the device build calls it.
cflags=(-std=c11 -D_DEFAULT_SOURCE -Wall -Wextra -Werror -O1 -g "${san[@]}"
        -I"$fw/main" -I"$pro/main" -I"$pro/main/display" -I"$cjson")

cc -std=c11 -D_DEFAULT_SOURCE -w -O1 -g "${san[@]}" -c -o "$out/cJSON.o" "$cjson/cJSON.c"
cc "${cflags[@]}" -Wframe-larger-than=1024 -c -o "$out/max_demo.o" "$fw/main/demo/max_demo.c"
cc "${cflags[@]}" -Wframe-larger-than=1024 -c -o "$out/cable_json_guard.o" "$pro/main/cable/cable_json_guard.c"
cc "${cflags[@]}" -o "$out/test_max_demo" "$here/test_max_demo.c" "$out/max_demo.o" "$out/cable_json_guard.o" "$out/cJSON.o"
"$out/test_max_demo"
