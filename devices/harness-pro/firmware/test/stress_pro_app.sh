#!/usr/bin/env bash
# Build and run test/stress_pro_app.c (the 03:28 freeze replay) under ASan+UBSan. Args: [steps] [seed].
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fw="$(cd "$here/.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
python3 "$fw/scripts/gen_fonts.py" --out "$out/pro_fonts.c" >/dev/null
cc -std=c11 -D_DEFAULT_SOURCE -w -O1 -g -fsanitize=address,undefined -fno-sanitize-recover=undefined -DHT_FACE_PX=720 \
   -I"$fw/main/app" -I"$fw/main" -I"$fw/main/display" -I"$here/host_esp" -I"$here/host_stubs" -I"$fw/main/pod" \
   "$here/stress_pro_app.c" "$fw"/main/pod/*.c "$fw/main/app/pod_glue.c" "$fw/main/app/pro_app.c" "$fw/main/app/pro_touch.c" \
   "$fw/main/display/scroll.c" "$fw/main/display/pro_canvas.c" "$fw/main/display/terminal.c" "$out/pro_fonts.c" \
   -lpthread -o "$out/stress"
"$out/stress" "$@"
