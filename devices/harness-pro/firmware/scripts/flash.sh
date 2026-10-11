#!/usr/bin/env bash
# Flash the Harness Pro (ESP32-P4 rev v3.2, MAC e8:f6:0a:e7:63:7d) over its USB port.
#
#   scripts/flash.sh [--build-dir DIR]     (default: build)
#
# The daemon holds the port, so it is stopped for the flash and started again afterwards, and the flasher
# flag tells it the port is busy on purpose. The chip and MAC are checked first: a different unit or
# silicon revision gets exit status 2 and nothing is written.
set -u

BUILD_DIR=build
while [ $# -gt 0 ]; do
    case "$1" in
        --build-dir) BUILD_DIR="${2:?--build-dir needs a directory}"; shift 2 ;;
        *) echo "usage: $0 [--build-dir DIR]" >&2; exit 64 ;;
    esac
done

PORT=/dev/cu.usbmodem21101
ESPTOOL="$HOME/.harness/flasher/esptool-v5.3.1-macos-amd64/esptool-macos-amd64/esptool"
FLAG="$HOME/.harness/flasher/flashing"
WANT_CHIP="ESP32-P4 (revision v3.2)"
WANT_MAC="e8:f6:0a:e7:63:7d"

cd "$(dirname "$0")/.." || exit 1
APP=$(ls "$BUILD_DIR"/harness_pro.bin 2>/dev/null | head -n 1)
for f in "$BUILD_DIR/bootloader/bootloader.bin" "$BUILD_DIR/partition_table/partition-table.bin" \
         "$BUILD_DIR/ota_data_initial.bin" "$APP"; do
    if [ -z "$f" ] || [ ! -f "$f" ]; then
        echo "missing build output: ${f:-$BUILD_DIR/harness_pro.bin} (build first)" >&2
        exit 1
    fi
done

mkdir -p "$(dirname "$FLAG")"
date +%s > "$FLAG"

status=0
finish() {
    rm -f "$FLAG"
    harness start
    exit "$status"
}

harness stop

info=$("$ESPTOOL" --port "$PORT" chip-id 2>&1)
echo "$info"
mac=$(printf '%s\n' "$info" | tr '[:upper:]' '[:lower:]' | grep -o 'mac: *[0-9a-f:]*' | head -n 1 | sed 's/mac: *//')
if ! printf '%s\n' "$info" | grep -qF "$WANT_CHIP" || [ "$mac" != "$WANT_MAC" ]; then
    echo "refusing to flash: expected $WANT_CHIP with MAC $WANT_MAC, got MAC '${mac:-none}'" >&2
    status=2
    finish
fi

"$ESPTOOL" --chip esp32p4 --port "$PORT" -b 921600 write-flash \
    --flash-mode dio --flash-freq 80m --flash-size 16MB \
    0x2000 "$BUILD_DIR/bootloader/bootloader.bin" \
    0x8000 "$BUILD_DIR/partition_table/partition-table.bin" \
    0xf000 "$BUILD_DIR/ota_data_initial.bin" \
    0x20000 "$APP"
status=$?
finish
