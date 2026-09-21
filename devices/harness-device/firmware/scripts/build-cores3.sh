#!/bin/bash
# Build the OpenHarness device firmware for the M5Stack CoreS3 (M5Launcher app image).
#
# Needs ESP-IDF >= 5.5 exported first:  . ~/esp/esp-idf/export.sh
# Output: build-cores3/interns_commander.bin  ← the file that goes on the Launcher SD card.
set -euo pipefail
cd "$(dirname "$0")/.."

# Two things are pinned here, and both exist because the shared project `sdkconfig` cannot serve two
# boards at once:
#
#   SDKCONFIG_DEFAULTS  layers the CoreS3 overrides (quad PSRAM) over the shared defaults, which name
#                       the DIAL's octal PSRAM. Without it the image reset-loops before app_main —
#                       see the header of sdkconfig.defaults.cores3.
#   SDKCONFIG           keeps this board's generated config inside its own build dir, so building the
#                       dial afterwards cannot silently inherit CoreS3 settings, or the reverse.
IDF_ARGS=(-B build-cores3 -DDEVICE_BOARD_M5CORES3=1
          -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.cores3"
          -DSDKCONFIG=build-cores3/sdkconfig)

idf.py "${IDF_ARGS[@]}" set-target esp32s3
idf.py "${IDF_ARGS[@]}" build
echo
echo "App image:  $(pwd)/build-cores3/interns_commander.bin   (copy to the CoreS3 SD card)"
