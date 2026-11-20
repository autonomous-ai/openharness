# Harness Max on the desk Harness Pro: a stopgap image of its own, until a P4 board with the 8.8" panel is on the bench.
# The Max's screens, cable and voice as ../ builds them, on the Pro's board: its ST7703 720 x 720 panel and GT911 touch,
# its ES7210 microphones and ES8311 speaker, read through the Pro's own drivers, compiled where they are. The 1920 x 480
# glass is shrunk by 3/8 into a 720 x 180 band across the middle of the square panel (main/max_shrink.h), so text is
# 37.5% of the 8.8" size. The product builds from ../ and never looks in here. README.md says how to build and load it.
cmake_minimum_required(VERSION 3.16)

if(NOT DEFINED IDF_TARGET AND NOT DEFINED ENV{IDF_TARGET})
    set(IDF_TARGET esp32p4)
endif()

# The product's chip, flash, PSRAM, console, watchdog and crash settings, then the one change this directory needs.
# ESP-IDF reads them only when it creates sdkconfig: delete on-pro/sdkconfig after a change to either.
set(SDKCONFIG_DEFAULTS "${CMAKE_CURRENT_LIST_DIR}/../sdkconfig.defaults;${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults")

# The Pro's USB-Serial-JTAG driver override, as ../CMakeLists.txt.
set(EXTRA_COMPONENT_DIRS ${CMAKE_CURRENT_LIST_DIR}/../../../harness-pro/firmware/components/esp_driver_usb_serial_jtag)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(harness_max_on_pro)
