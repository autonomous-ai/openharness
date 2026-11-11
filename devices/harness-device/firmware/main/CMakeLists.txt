# The single "main" component. ONE board, ONE renderer.
#
# The device is the round 466 dial on an ESP32-S3, and what it draws with is habitat — the
# allocation-free text compositor under ui/habitat/. There is no second renderer and no second board
# in this repository any more:
#
#   * the LVGL UI (ui/ui_screens.c, thirteen Geist faces at 4 bpp, the raster icons and the spinner)
#     is gone. Measured before it went: 3,184,848 B against habitat's 788,704 B, and ~2,032 KB of the
#     difference was the typefaces alone. Nothing about LVGL was heavy; the way it was fed was.
#   * the ESP32-P4 Pro is gone with it. That board gets its own firmware, written by the team that
#     owns it. What crossed between them was a protocol, not a build — see cable_client.c — so a Pro
#     speaking it still works with this daemon without a line of its code living here.
#
# Both deletions removed a flag as well as files: there is no DEVICE_HABITAT and no HT_FACE_PX. A
# single firmware needs neither, and a flag that is always set is a flag that will one day be wrong.

set(BOARD_SRCS
    # the portable half: the cable protocol, storage, OTA, audio
    "app_main.c"
    "ram_telemetry.c"
    "config_store.c"
    "device_mac.c"
    "cable_frame.c"
    "cable_link.c"
    "cable_client.c"
    "cable_machines.c"
    "cable_scroll.c"
    "cable_json_guard.c"
    "cable_features.c"
    "last_words.c"
    "fw_update.c"
    "pet_store.c"
    "elapsed.c"
    "audio_capture.c"
    "audio_client_habitat.c"
    "audio_probe.c"
    "voice_buffer.c"
    "ptt.c"
    # the board
    "board/board_i2c.c"
    "board/board.c"
    "board/board_table.c"
    "board/power.c"
    # the renderer: panel bring-up, touch and the compositor, all its own
    "ui/ui_perf.c"
    "ui/habitat/display_habitat.c"
    "ui/habitat/touch_habitat.c"
    "ui/habitat/ui_habitat.c"
    "ui/habitat/terminal.c"
    "ui/habitat/scroll.c"
    "ui/habitat/workspace.c"
    "ui/habitat/supertab.c"
    "ui/habitat/selection.c"
    "ui/habitat/carry.c"
    "ui/habitat/visit.c"
    "ui/habitat/form.c"
    "ui/habitat/draft.c"
    "ui/habitat/gestures.c"
    "ui/habitat/character.c"
    "ui/habitat/character_motion.c"
    "ui/habitat/character_layout.c"
    "ui/habitat/focus.c"
    "ui/habitat/command_face.c"
    "ui/habitat/fonts.c"
    "ui/habitat/lvgl_fonts.c"
    "ui/habitat/lvgl_icons.c"
    "ui/habitat/focus_marks.c"
    "ui/habitat/focus_faces.c"
    "ui/habitat/pets.c"
)

set(BOARD_REQUIRES
    nvs_flash
    app_update
    esp_partition
    mbedtls
    esp_lcd
    esp_lcd_touch
    esp_codec_dev
    esp_timer
    driver
    json
)

idf_component_register(
    SRCS ${BOARD_SRCS}
    INCLUDE_DIRS
        "."
        "ui"
        "board"
    REQUIRES ${BOARD_REQUIRES}
)

# snprintf() is bounded (it truncates, never overflows), but -O2 enables a noisy
# format-truncation analysis that errors on safe same-size copies. Keep it as a warning, not error.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-format-truncation)

if(DEVICE_HABITAT_ORANGE)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_HABITAT_ORANGE=1)
endif()

if(DEVICE_PERF_BENCH)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_PERF_BENCH=1)
endif()

# BRING-UP PROBE: `idf.py -DBOARD_PROBE=1 build` (separate build dir recommended). app_main runs
# board/board_probe.c before the display comes up and prints what is on the I2C bus, which reset pins
# do what, and what each touch driver reads idle. Never set for a release image.
if(BOARD_PROBE)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE BOARD_PROBE=1)
    target_sources(${COMPONENT_LIB} PRIVATE "board/board_probe.c")
endif()

if(DEVICE_TRANSPORT_BENCH)
    if(DEVICE_LAYOUT_BENCH)
        message(FATAL_ERROR "DEVICE_TRANSPORT_BENCH requires the normal renderer")
    endif()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_TRANSPORT_BENCH=1)
    target_sources(${COMPONENT_LIB} PRIVATE "ui/habitat/transport_bench.c"
        "../test/reference91/cable_frame_ref.c")
endif()

# One-boot layout CPU profiling. Never enabled in the daily device image.
if(DEVICE_LAYOUT_BENCH)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_LAYOUT_BENCH=1)
    target_sources(${COMPONENT_LIB} PRIVATE "ui/habitat/layout_bench.c" "ui/habitat/scroll_bench.c")
    if(DEVICE_LAYOUT_BASELINE STREQUAL "82")
        target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_LAYOUT_BASELINE82=1)
    elseif(DEVICE_LAYOUT_BASELINE STREQUAL "79")
        target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_LAYOUT_BASELINE79=1)
        target_sources(${COMPONENT_LIB} PRIVATE "../test/reference79/terminal_ref.c")
    else()
        target_sources(${COMPONENT_LIB} PRIVATE "../test/reference48/terminal_ref.c")
    endif()
    target_include_directories(${COMPONENT_LIB} PRIVATE
        "${CMAKE_CURRENT_LIST_DIR}/../test" "${CMAKE_CURRENT_LIST_DIR}/ui/habitat")
endif()

# One-shot fault injection, omitted from daily builds. A retained marker makes
# the reboot after the injected stall resume normal operation instead of looping.
if(DEVICE_RENDER_FAULT)
    if(DEVICE_LAYOUT_BENCH)
        message(FATAL_ERROR "DEVICE_RENDER_FAULT requires the normal renderer")
    endif()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_RENDER_FAULT=1)
endif()

if(DEVICE_RENDER_STRESS)
    if(DEVICE_LAYOUT_BENCH OR DEVICE_RENDER_FAULT)
        message(FATAL_ERROR "DEVICE_RENDER_STRESS requires the normal renderer without fault injection")
    endif()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_RENDER_STRESS=1)
endif()
