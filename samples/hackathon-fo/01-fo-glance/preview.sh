#!/usr/bin/env bash
# Render the round device's Working, Recap and Glance screens to PNG on this Mac — no device, no ESP-IDF.
#
#   ./preview.sh            the default colours
#   ./preview.sh --fo       the Fo colours (-DDEVICE_HABITAT_FO=1, the warm-up)
#
# It runs the firmware's own host renderer (devices/harness-device/firmware/test/test_touch_ui.py) with
# HABITAT_PREVIEW_DIR set: the test compiles the real UI code (focus.c, ui_habitat.c, ...) for the host,
# drives it through its states and writes one PPM per screen. This script keeps three of them and turns
# them into PNG with ppm2png.py (Python standard library only). Needs: cc (Xcode command line tools), python3.
#
# Output: $OUT_DIR (default /tmp/fo-glance-preview)/{working,recap,glance}.png
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
firmware="${FIRMWARE_DIR:-$repo/devices/harness-device/firmware}"   # FIRMWARE_DIR: another checkout
out="${OUT_DIR:-/tmp/fo-glance-preview}"
raw="$out/raw"

theme=()
case "${1:-}" in
    --fo) theme=(HABITAT_TEST_FO=1) ;;
    "") ;;
    *) echo "usage: $0 [--fo]" >&2; exit 2 ;;
esac

rm -rf "$raw"
mkdir -p "$raw"
echo "Rendering with the host renderer (about 15 s)..."
(cd "$firmware" && env ${theme[@]+"${theme[@]}"} HABITAT_PREVIEW_DIR="$raw" python3 test/test_touch_ui.py >"$out/test.log" 2>&1) || {
    echo "test_touch_ui.py failed — the last lines of $out/test.log:" >&2
    tail -20 "$out/test.log" >&2
    exit 1
}

# The design export draws every state for Claude (and Codex); Claude's are the ones kept here.
status=0
for screen in working recap glance; do
    ppm="$raw/design-claude-$screen.ppm"
    if [[ -f "$ppm" ]]; then
        python3 "$here/ppm2png.py" "$ppm" "$out/$screen.png"
        echo "  $out/$screen.png"
    else
        echo "  $screen: no $ppm — add the glance case to test_touch_ui.py (README, step 3), or apply solution.patch" >&2
        status=1
    fi
done
[[ "$(uname)" == Darwin && $status == 0 && -z "${NO_OPEN:-}" ]] && open "$out/working.png" "$out/recap.png" "$out/glance.png"
exit $status
