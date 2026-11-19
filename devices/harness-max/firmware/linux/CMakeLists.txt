# Harness Max as a Linux program, from the same sources as the ESP32-P4 build (../sources.cmake) over Linux drivers:
# a POSIX runtime for the FreeRTOS and ESP-IDF calls (esp/), the board table, the cable (the demo daemon or TCP), the
# display and the audio. Plain CMake, no ESP-IDF.
#
#   cmake -S devices/harness-max/firmware/linux -B build-sim                      # the macOS simulator: SDL, 480 high
#   cmake -S ... -B build-sim-415 -DMAX_GLASS_H=415                               # the bar's own shape, no black bars
#   cmake -S ... -B build-bar -DMAX_LINUX_OUTPUT=drm                              # the Orange Pi's bar: DRM/KMS, ALSA
#   cmake --build <dir> && ctest --test-dir <dir>
cmake_minimum_required(VERSION 3.16)
project(harness_max_linux C)

set(MAX_LINUX_OUTPUT sdl CACHE STRING "sdl: a window and the mouse (the macOS simulator); drm: DRM/KMS and evdev (the Orange Pi's bar)")
set_property(CACHE MAX_LINUX_OUTPUT PROPERTY STRINGS sdl drm)
# 480: the ESP32-P4's panel, exactly what the device draws; the 1480 x 320 bar shows it whole at 1280 x 320, black
# either side. 415: the bar's own shape at the device's width (1480 / 1920 = 320 / 415), drawn by no device.
set(MAX_GLASS_H 480 CACHE STRING "The glass height: 480 or 415")
set_property(CACHE MAX_GLASS_H PROPERTY STRINGS 480 415)
# A -dev version is never offered a firmware image (cli fwPush.ts), and the board name has no image either.
set(PROJECT_VER 0.0.99-dev CACHE STRING "The hello's fw version")
# cJSON from an ESP-IDF checkout, the copy the device compiles.
set(CJSON_DIR "$ENV{HOME}/esp/esp-idf-5.5.4/components/json/cJSON" CACHE PATH "ESP-IDF's components/json/cJSON")
if(NOT MAX_LINUX_OUTPUT MATCHES "^(sdl|drm)$")
    message(FATAL_ERROR "MAX_LINUX_OUTPUT is sdl or drm (got ${MAX_LINUX_OUTPUT})")
endif()
if(NOT MAX_GLASS_H MATCHES "^(415|480)$")
    message(FATAL_ERROR "MAX_GLASS_H is 415 or 480 (got ${MAX_GLASS_H})")
endif()
if(NOT EXISTS ${CJSON_DIR}/cJSON.c)
    message(FATAL_ERROR "cJSON not found in ${CJSON_DIR}: set -DCJSON_DIR to ESP-IDF's components/json/cJSON")
endif()

set(CMAKE_C_STANDARD 11)
find_package(Threads REQUIRED)
find_package(PkgConfig REQUIRED)
include(${CMAKE_CURRENT_LIST_DIR}/../sources.cmake)

set(PRO_FONTS_C ${CMAKE_BINARY_DIR}/pro_fonts.c)
max_bake_fonts(${PRO_FONTS_C})

add_executable(harness-max
    ${MAX_PORTABLE_SRCS}
    ${PRO_FONTS_C}
    ${CJSON_DIR}/cJSON.c
    main.c
    audio/bar_chime.c
    board_linux.c
    cable/cable_linux.c
    display/display_linux.c
    display/glass_fit.c
    esp/esp.c
    esp/nvs.c
    esp/rtos.c
)
target_include_directories(harness-max PRIVATE
    ${MAX_PORTABLE_INCLUDE_DIRS}
    ${CMAKE_CURRENT_LIST_DIR}
    ${CMAKE_CURRENT_LIST_DIR}/display
    ${CMAKE_CURRENT_LIST_DIR}/esp/include
    ${CJSON_DIR}
)
# The device's glass width, at this build's height: pro_display.h and terminal.h take these instead of their 720.
target_compile_definitions(harness-max PRIVATE
    HT_WIDTH=1920 HT_HEIGHT=${MAX_GLASS_H} PRO_DISPLAY_W=1920 PRO_DISPLAY_H=${MAX_GLASS_H}
    MAX_LINUX_OUTPUT_NAME="${MAX_LINUX_OUTPUT}")
set_source_files_properties(esp/esp.c PROPERTIES COMPILE_DEFINITIONS PROJECT_VER="${PROJECT_VER}")
target_compile_options(harness-max PRIVATE -O2 -g -Wall -Wextra -Werror)
# As the device's build: snprintf() truncates safely, and GCC's format-truncation analysis errors on same-size copies.
if(CMAKE_C_COMPILER_ID STREQUAL "GNU")
    target_compile_options(harness-max PRIVATE -Wno-format-truncation)
endif()
# ESP-IDF's cJSON is not ours to change: its warnings stay its own.
set_source_files_properties(${CJSON_DIR}/cJSON.c PROPERTIES COMPILE_OPTIONS "-w")
target_link_libraries(harness-max PRIVATE Threads::Threads m)

if(MAX_LINUX_OUTPUT STREQUAL "sdl")
    pkg_check_modules(SDL2 REQUIRED IMPORTED_TARGET sdl2)
    target_sources(harness-max PRIVATE display/out_sdl.c audio/audio_sdl.c)
    target_compile_definitions(harness-max PRIVATE MAX_OUTPUT_SDL)
    target_link_libraries(harness-max PRIVATE PkgConfig::SDL2)
else()
    pkg_check_modules(DRM REQUIRED IMPORTED_TARGET libdrm)
    pkg_check_modules(ALSA REQUIRED IMPORTED_TARGET alsa)
    target_sources(harness-max PRIVATE display/out_drm.c audio/audio_alsa.c)
    target_link_libraries(harness-max PRIVATE PkgConfig::DRM PkgConfig::ALSA)
endif()

# Host tests of the Linux layer: the picture and touch arithmetic, the settings file, the cable at each far end.
enable_testing()
function(max_host_test name)
    add_executable(${name} ${ARGN})
    target_include_directories(${name} PRIVATE ${CMAKE_CURRENT_LIST_DIR} display esp/include ${PRO_MAIN} ${MAX_FW}/main)
    target_compile_options(${name} PRIVATE -O1 -g -Wall -Wextra -Werror -fsanitize=undefined)
    target_link_options(${name} PRIVATE -fsanitize=undefined)
    target_link_libraries(${name} PRIVATE Threads::Threads)
endfunction()
max_host_test(test_glass_fit test/test_glass_fit.c display/glass_fit.c)
add_test(NAME glass_fit COMMAND test_glass_fit)
max_host_test(test_nvs test/test_nvs.c esp/nvs.c esp/esp.c ${PRO_MAIN}/sys/config_store.c)
add_test(NAME nvs COMMAND test_nvs)
max_host_test(test_cable_linux test/test_cable_linux.c cable/cable_linux.c esp/esp.c ${PRO_MAIN}/cable/cable_frame.c)
add_test(NAME cable_demo COMMAND test_cable_linux demo)
add_test(NAME cable_tcp COMMAND test_cable_linux tcp)
add_test(NAME cable_usb COMMAND test_cable_linux usb)
# The chimes' samples on both boards, the bar's padding of them, and which speaker plays them there.
max_host_test(test_chime test/test_chime.c ${MAX_FW}/main/audio/max_chime_pcm.c audio/bar_chime.c)
target_link_libraries(test_chime PRIVATE m)
add_test(NAME chime COMMAND test_chime)
set_tests_properties(glass_fit nvs cable_demo cable_tcp cable_usb chime PROPERTIES TIMEOUT 60)   # a hung link fails, not stalls
# The bar's microphone choice, where ALSA is: its null device stands in for a microphone.
if(MAX_LINUX_OUTPUT STREQUAL "drm")
    max_host_test(test_audio_alsa test/test_audio_alsa.c audio/audio_alsa.c audio/bar_chime.c
        ${MAX_FW}/main/audio/max_chime_pcm.c esp/esp.c)
    target_link_libraries(test_audio_alsa PRIVATE PkgConfig::ALSA m)
    add_test(NAME audio_alsa COMMAND test_audio_alsa)
    set_tests_properties(audio_alsa PROPERTIES TIMEOUT 60)
endif()
