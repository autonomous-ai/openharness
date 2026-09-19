#!/bin/bash
# Build the OpenHarness device firmware for the M5Stack CoreS3 (M5Launcher app image).
#
# Needs ESP-IDF >= 5.5 exported first:  . ~/esp/esp-idf/export.sh
# Output: build-cores3/interns_commander.bin  ← the file that goes on the Launcher SD card.
set -euo pipefail
cd "$(dirname "$0")/.."

idf.py -B build-cores3 -DDEVICE_BOARD_M5CORES3=1 set-target esp32s3
idf.py -B build-cores3 -DDEVICE_BOARD_M5CORES3=1 build
echo
echo "App image:  $(pwd)/build-cores3/interns_commander.bin   (copy to the CoreS3 SD card)"
