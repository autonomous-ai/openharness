# Harness Max firmware: one ESP-IDF project for one board, the ESP32-P4 bar (1920 x 480 OTA7290B panel turned
# landscape, GT9271 touch, ES8311 audio). It compiles the Pro's generic sources where they are (main/CMakeLists.txt).
# Build:
#
#   . ~/esp/esp-idf-5.5.4/export.sh
#   idf.py -B build -DPROJECT_VER=0.0.99-dev build
#
# Dev builds are safe from the daemon's OTA: a `-dev` version fails its plain X.Y.Z rule, so it is never offered an image.
cmake_minimum_required(VERSION 3.16)

# The target is part of the project: default it so a bare `idf.py build` does the right thing.
if(NOT DEFINED IDF_TARGET AND NOT DEFINED ENV{IDF_TARGET})
    set(IDF_TARGET esp32p4)
endif()

# ESP-IDF reads sdkconfig.defaults ONLY when creating sdkconfig; after that sdkconfig decides the build.
# Stamp the hash of the defaults beside sdkconfig and, when they disagree, set the old sdkconfig aside so
# IDF re-seeds it. A deliberate tweak belongs in sdkconfig.defaults, where it is reviewable.
if(DEFINED SDKCONFIG)
    get_filename_component(_sdkcfg "${SDKCONFIG}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_LIST_DIR}")
else()
    set(_sdkcfg "${CMAKE_CURRENT_LIST_DIR}/sdkconfig")
endif()
set(_stamp "${_sdkcfg}.defaults.stamp")
file(SHA256 "${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults" _defaults_hash)
set(_prev_hash "")
if(EXISTS "${_stamp}")
    file(READ "${_stamp}" _prev_hash)
    string(STRIP "${_prev_hash}" _prev_hash)
endif()
if(EXISTS "${_sdkcfg}" AND NOT _prev_hash STREQUAL _defaults_hash)
    message(WARNING
        "sdkconfig.defaults changed since ${_sdkcfg} was generated -- regenerating it.\n"
        "Previous config saved as ${_sdkcfg}.superseded.")
    file(RENAME "${_sdkcfg}" "${_sdkcfg}.superseded")
endif()
file(WRITE "${_stamp}" "${_defaults_hash}")

# The Pro's USB-Serial-JTAG driver override (its RX counters feed the cable's heartbeat), used where it is. A component
# in EXTRA_COMPONENT_DIRS replaces IDF's of the same name.
set(EXTRA_COMPONENT_DIRS ${CMAKE_CURRENT_LIST_DIR}/../../harness-pro/firmware/components/esp_driver_usb_serial_jtag)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(harness_max)
