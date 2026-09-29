# Single "main" component holding all app sources. Board drivers live under board/
# and the LVGL UI under ui/.
#
# TWO BOARDS, ONE COMPONENT. What each one builds is chosen by IDF_TARGET, because the difference is the
# SoC and nothing about an ESP32-S3 image can run on an ESP32-P4. See ../CMakeLists.txt for the pair.
#
# The Pro's list is deliberately short while the board is being brought up. The portable half of this
# firmware — the cable protocol, the config store, OTA, the screens — is not board-dependent and joins
# the list a file at a time as each is proved on the new hardware, rather than all at once against a
# panel that has never lit up. board/pro_bringup.c carries its own app_main for exactly that window,
# and goes away when the shared one takes over.

if(IDF_TARGET STREQUAL "esp32p4")

    set(BOARD_SRCS
        # the portable half, shared verbatim with the dial
        "app_main.c"
        "ram_telemetry.c"
        "config_store.c"
        "device_mac.c"
        "cable_frame.c"
        "cable_link.c"
        "last_words.c"
        "cable_client.c"
        "cable_machines.c"
        "fw_update.c"
        "audio_client.c"
        "audio_capture.c"
        # this board's own
        "board/board_i2c.c"
        "board/board_pro.c"
        "board/ptt_pro.c"
        "board/power_pro.c"
        "ui/display.c"
        "ui/panel_pro.c"
        "ui/pro_panel_bus.c"
        "ui/touch.c"
        "ui/touch_gt911.c"
        # the screens, and the faces they are drawn in — identical files on both boards
        "ui/ui_screens.c"
        "ui/carousel_ring.c"
        "ui/geist_reg_16.c"
        "ui/geist_reg_20.c"
        "ui/geist_reg_24.c"
        "ui/geist_reg_25.c"
        "ui/geist_med_28.c"
        "ui/geist_med_32.c"
        "ui/geist_reg_32.c"
        "ui/geist_reg_34.c"
        "ui/geist_reg_38.c"
        "ui/geist_med_38.c"
        "ui/geist_med_48.c"
        "ui/geist_med_64.c"
        "ui/geist_sem_24.c"
        "ui/icons_settings.c"
        "ui/icons_engine.c"
        "ui/icons_voice.c"
        "ui/spinner_spokes.c"
    )
    set(BOARD_REQUIRES
        esp_driver_i2c
        esp_driver_gpio
        esp_driver_ledc
        esp_lcd
        esp_lcd_touch
        esp_timer
        driver
        lvgl
        esp_psram
        json
        nvs_flash
        app_update
        esp_partition
        mbedtls
        esp_adc
        esp_codec_dev
        esp_driver_i2s
    )

else()   # esp32s3 — the round dial

    set(BOARD_SRCS
        "app_main.c"
        "ram_telemetry.c"
        "config_store.c"
        "device_mac.c"
        "cable_frame.c"
        "cable_link.c"
        "last_words.c"
        "cable_client.c"
        "cable_machines.c"
        "fw_update.c"
        "audio_capture.c"
        "audio_client.c"
        "ptt.c"
        "board/board_i2c.c"
        "board/board.c"
        "board/board_table.c"
        "board/power.c"
        "ui/display.c"
        "ui/panel_dial.c"
        "ui/touch.c"
        "ui/touch_cst.c"
        "ui/ui_screens.c"
        "ui/carousel_ring.c"
        "ui/geist_reg_20.c"
        "ui/geist_reg_25.c"
        "ui/geist_med_28.c"
        "ui/geist_med_32.c"
        "ui/geist_reg_34.c"
        "ui/geist_reg_38.c"
        "ui/geist_reg_16.c"
        "ui/geist_reg_24.c"
        "ui/geist_reg_32.c"
        "ui/geist_med_48.c"
        "ui/geist_med_64.c"
        "ui/geist_sem_24.c"
        "ui/geist_med_38.c"
        "ui/icons_settings.c"
        "ui/spinner_spokes.c"
        "ui/icons_engine.c"
        "ui/icons_voice.c"
    )
    set(BOARD_REQUIRES
        nvs_flash
        esp_wifi
        esp_netif
        esp_event
        esp_http_server
        esp_http_client
        esp_https_ota
        app_update
        esp_partition
        mbedtls
        libsodium
        esp_websocket_client
        esp-tls
        esp_lcd
        esp_lcd_touch
        esp_codec_dev
        esp_timer
        driver
        json
        lvgl
    )

endif()

# Shared protocol/audio guards are also used by the stock renderer on both boards.
list(APPEND BOARD_SRCS "cable_scroll.c" "cable_json_guard.c" "cable_features.c"
    "voice_buffer.c" "audio_probe.c" "ui/ui_perf.c")

# Habitat replaces the board's LVGL renderer with the text compositor. BOTH boards can build it now:
# the dial at 466 and the Pro at 720. What differs is only what sits under the compositor —
#
#   the panel   the dial is a CO5300 over QSPI, the Pro an ST7703 over MIPI-DSI. Both are pushed with
#               esp_lcd_panel_draw_bitmap, which is why display_habitat.c can branch on bring-up alone
#               and share the whole damage/strip loop. The Pro's bring-up is ui/pro_panel_bus.c, the
#               same file its LVGL renderer uses, so the two cannot drift apart.
#   the touch   CST816S/CST9217 against GT911, behind touch_ctrl_open() — an interface that already
#               existed for exactly this split (see ui/touch_ctrl.h).
#   the face    HT_FACE_PX below. The compositor itself has no opinion about resolution.
if(DEVICE_HABITAT)
    if(NOT IDF_TARGET STREQUAL "esp32s3" AND NOT IDF_TARGET STREQUAL "esp32p4")
        message(FATAL_ERROR "DEVICE_HABITAT builds for the ESP32-S3 dial or the ESP32-P4 Pro")
    endif()
    list(FILTER BOARD_SRCS EXCLUDE REGEX "^ui/")
    list(REMOVE_ITEM BOARD_SRCS "audio_client.c")
    # The Pro's panel bring-up and its touch driver are under ui/, so the filter above took them.
    if(IDF_TARGET STREQUAL "esp32p4")
        list(APPEND BOARD_SRCS "ui/pro_panel_bus.c" "ui/touch_gt911.c")
    endif()
    list(APPEND BOARD_SRCS "audio_client_habitat.c" "ui/ui_perf.c"
        "ui/habitat/display_habitat.c"
        "ui/habitat/touch_habitat.c"
        "ui/habitat/ui_habitat.c"
        "ui/habitat/terminal.c"
        "ui/habitat/scroll.c"
        "ui/habitat/workspace.c"
        "ui/habitat/selection.c"
        "ui/habitat/carry.c"
        "ui/habitat/visit.c"
        "ui/habitat/form.c"
        "ui/habitat/draft.c"
        "ui/habitat/gestures.c"
        "ui/habitat/tim.c"
        "ui/habitat/character.c"
        "ui/habitat/character_motion.c"
        "ui/habitat/character_layout.c"
        "ui/habitat/tux.c"
        "ui/habitat/octopus.c"
        "ui/habitat/ascii_clip.c"
        "ui/habitat/octopus_font.c"
        "ui/habitat/command_face.c"
        "ui/habitat/fonts.c"
    )
    # Desktop Companion currently has the round dial's artwork and touch layout.
    if(IDF_TARGET STREQUAL "esp32s3")
        list(APPEND BOARD_SRCS "ui/habitat/companion.c")
    endif()
endif()

idf_component_register(
    SRCS ${BOARD_SRCS}
    INCLUDE_DIRS
        "."
        "ui"
        "board"
    REQUIRES ${BOARD_REQUIRES}
)

# The face the text compositor is drawing on. See HT_FACE_PX in ui/habitat/terminal.h for why this is a
# build definition rather than a #if on the target.
if(DEVICE_HABITAT AND IDF_TARGET STREQUAL "esp32p4")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE HT_FACE_PX=720)
endif()

# snprintf() is bounded (it truncates, never overflows), but -O2 enables a noisy
# format-truncation analysis that errors on safe same-size copies. Keep it as a warning, not error.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-format-truncation)

if(DEVICE_PERF_BENCH)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_PERF_BENCH=1)
endif()

# Event-tagged A/B profiling of the connected octopus. Never part of a daily image.
if(DEVICE_OCTOPUS_BENCH)
    if(NOT DEVICE_PERF_BENCH OR NOT DEVICE_HABITAT OR DEVICE_CREATURE_GALLERY)
        message(FATAL_ERROR "DEVICE_OCTOPUS_BENCH requires Habitat + PERF, without the gallery")
    endif()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_OCTOPUS_BENCH=1)
    target_sources(${COMPONENT_LIB} PRIVATE "ui/habitat/perf_bench.c")
endif()

# PROD build override: `idf.py -DDEVICE_FORCE_PROD=1 build` (into a separate build dir) forces the
# production backend and ignores any local provisioned_config.h — no need to move the header, so the LOCAL
# and PROD build dirs both stay warm (no CMake-reconfigure churn). See app_main.c's DEVICE_FORCE_PROD.
if(DEVICE_FORCE_PROD)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_FORCE_PROD=1)
endif()

# LOCAL BACKEND override: `idf.py -DDEVICE_BACKEND_URL="ws://<laptop-ip>:8085" build` points the device
# at a backend on your machine. The URL is otherwise hardcoded to production AND re-forced over whatever
# NVS holds on every boot (app_main.c), so it is not a setting the device can be talked into — a local
# build is the only way. Only the URL changes: the device keeps its provisioned WiFi and SDS credential,
# so there is no need to bake credentials in or re-run setup just to move the socket.
if(DEVICE_BACKEND_URL)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_PROD_BACKEND_URL="${DEVICE_BACKEND_URL}")
endif()

# BRING-UP PROBE: `idf.py -DBOARD_PROBE=1 build` (separate build dir recommended). app_main runs
# board/board_probe.c before the display comes up and prints what is on the I2C bus, which reset pins
# do what, and what each touch driver reads idle. Never set for a release image.
# PANEL BISECT: `idf.py -DPRO_PANEL_DIAG=1 build` on the Pro. No UI, no LVGL — the panel shows its own
# colour bars while the backlight sweeps its whole range, so "the screen is blank" splits into "no video"
# and "no light" without guessing. See board/pro_bringup.c.
if(PRO_PANEL_DIAG)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE PRO_PANEL_DIAG=1)
endif()

# The dial's own probe. The Pro does not need a flag for this: board/pro_bringup.c IS the probe until
# the shared app_main takes the board over.
if(BOARD_PROBE AND NOT IDF_TARGET STREQUAL "esp32p4")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE BOARD_PROBE=1)
    target_sources(${COMPONENT_LIB} PRIVATE "board/board_probe.c")
endif()

if(DEVICE_HABITAT)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_HABITAT=1)
    if(IDF_TARGET STREQUAL "esp32s3")
        target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_DESKTOP_COMPANION=1)
    endif()
    if(DEVICE_HABITAT_ORANGE)
        target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_HABITAT_ORANGE=1)
    endif()
    if(DEVICE_DEFAULT_CHARACTER STREQUAL "tux")
        target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_DEFAULT_CHARACTER_TUX=1)
    elseif(DEFINED DEVICE_DEFAULT_CHARACTER AND NOT DEVICE_DEFAULT_CHARACTER STREQUAL "tim")
        message(FATAL_ERROR "DEVICE_DEFAULT_CHARACTER must be tim or tux")
    endif()
endif()

if(DEVICE_TRANSPORT_BENCH)
    if(NOT DEVICE_HABITAT OR DEVICE_CREATURE_GALLERY OR DEVICE_LAYOUT_BENCH)
        message(FATAL_ERROR "DEVICE_TRANSPORT_BENCH requires the normal Habitat renderer")
    endif()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_TRANSPORT_BENCH=1)
    target_sources(${COMPONENT_LIB} PRIVATE "ui/habitat/transport_bench.c"
        "../test/reference91/cable_frame_ref.c")
endif()

# Opt-in, local-only ASCII visual study. Omitted entirely from normal firmware.
if(DEVICE_CREATURE_GALLERY)
    if(NOT DEVICE_HABITAT)
        message(FATAL_ERROR "DEVICE_CREATURE_GALLERY requires DEVICE_HABITAT")
    endif()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_CREATURE_GALLERY=1)
    target_sources(${COMPONENT_LIB} PRIVATE
        "ui/habitat/creature_gallery.c"
        "ui/habitat/creature_font.c")
endif()

# One-boot layout CPU profiling. Never enabled in the daily device image.
if(DEVICE_LAYOUT_BENCH)
    if(NOT DEVICE_HABITAT OR DEVICE_CREATURE_GALLERY OR DEVICE_OCTOPUS_BENCH)
        message(FATAL_ERROR "DEVICE_LAYOUT_BENCH requires the connected Habitat UI only")
    endif()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_LAYOUT_BENCH=1)
    target_sources(${COMPONENT_LIB} PRIVATE "ui/habitat/layout_bench.c" "ui/habitat/scroll_bench.c")
    if(DEVICE_LAYOUT_BASELINE STREQUAL "82")
        target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_LAYOUT_BASELINE82=1)
    elseif(DEVICE_LAYOUT_BASELINE STREQUAL "79")
        target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_LAYOUT_BASELINE79=1)
        target_sources(${COMPONENT_LIB} PRIVATE "../test/reference79/terminal_ref.c")
    else()
        target_sources(${COMPONENT_LIB} PRIVATE
            "../test/reference48/terminal_ref.c" "../test/reference48/octopus_ref.c")
    endif()
    target_include_directories(${COMPONENT_LIB} PRIVATE
        "${CMAKE_CURRENT_LIST_DIR}/../test" "${CMAKE_CURRENT_LIST_DIR}/ui/habitat")
endif()

# One-shot fault injection, omitted from daily builds. A retained marker makes
# the reboot after the injected stall resume normal operation instead of looping.
if(DEVICE_RENDER_FAULT)
    if(NOT DEVICE_HABITAT OR DEVICE_CREATURE_GALLERY OR DEVICE_LAYOUT_BENCH OR DEVICE_OCTOPUS_BENCH)
        message(FATAL_ERROR "DEVICE_RENDER_FAULT requires the normal Habitat renderer")
    endif()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_RENDER_FAULT=1)
endif()

if(DEVICE_RENDER_STRESS)
    if(NOT DEVICE_HABITAT OR DEVICE_CREATURE_GALLERY OR DEVICE_LAYOUT_BENCH OR DEVICE_OCTOPUS_BENCH OR DEVICE_RENDER_FAULT)
        message(FATAL_ERROR "DEVICE_RENDER_STRESS requires the normal Habitat renderer without fault injection")
    endif()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DEVICE_RENDER_STRESS=1)
endif()
