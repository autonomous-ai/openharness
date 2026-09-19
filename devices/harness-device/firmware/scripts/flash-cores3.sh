#!/bin/bash
# Development-only: esptool-flash the CoreS3 image straight over USB.
#
#   . ~/esp/esp-idf/export.sh
#   ./scripts/flash-cores3.sh [PORT]      # e.g. /dev/cu.usbmodem1101
#
# For the normal path — install from the SD card through M5Launcher — see
# docs/PORT_CORES3.md. This script bypasses the Launcher entirely.
#
# Reliability notes (learned on macOS + USB-Serial-JTAG):
#   • 115200 baud: the transfer is a few seconds slower but has never dropped; 460800+
#     intermittently dies mid-packet ("chip stopped responding" / "serial noise").
#   • Stray readers (idf.py monitor, serial_dump, miniterm) holding the port corrupt
#     the transfer — they are found and killed first.
#   • Transient USB slips still happen (especially while a crashed/halted app churns the
#     port), so the flash retries and only a verified pass counts.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-}"
BAUD=115200
ATTEMPTS=3

if [ -z "$PORT" ]; then
    echo "usage: $0 /dev/cu.usbmodem* (or /dev/ttyACM0)" >&2
    exit 1
fi

# Anything else holding the port corrupts the transfer — find and stop it.
HOLDERS=$(lsof -t "$PORT" 2>/dev/null || true)
if [ -n "$HOLDERS" ]; then
    echo "Killing processes holding $PORT: $HOLDERS"
    kill $HOLDERS 2>/dev/null || true
    sleep 2
fi

# Build first so the artifacts always match the working tree (the flash below uses
# whatever build-cores3 contains — stale bins were silently flashed before this).
export IDF_PATH="${IDF_PATH:-$HOME/esp/esp-idf}"
. "$IDF_PATH/export.sh" > /dev/null
idf.py -B build-cores3 -DDEVICE_BOARD_M5CORES3=1 build || { echo "build failed" >&2; exit 1; }

FILES=(0x0 build-cores3/bootloader/bootloader.bin 0x8000 build-cores3/partition_table/partition-table.bin 0x20000 build-cores3/interns_commander.bin)
for i in $(seq 1 $ATTEMPTS); do
    echo "── flash attempt $i/$ATTEMPTS ──"
    if esptool.py --chip esp32s3 --port "$PORT" --baud $BAUD \
        --before default_reset --after hard_reset \
        write_flash -z "${FILES[@]}"; then
        echo "flash verified and device reset — safe to test"
        exit 0
    fi
    echo "attempt $i failed; retrying in 3 s (unplug/replug if it keeps failing)" >&2
    sleep 3
done
echo "flash failed after $ATTEMPTS attempts" >&2
exit 1
