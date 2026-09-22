# Single "main" component holding all app sources. Board drivers live under board/
# and the LVGL UI under ui/.
# CoreS3 port (DEVICE_BOARD_M5CORES3) additionally links the ILI9341 panel + FT5x06 touch
# drivers (managed components; declared in idf_component.yml, unused/link-pruned on the dial).
set(CORES3_PRIV_REQUIRES "")
if(DEVICE_BOARD_M5CORES3)
    set(CORES3_PRIV_REQUIRES espressif__esp_lcd_ili9341 espressif__esp_lcd_touch_ft5x06 espressif__mdns)
endif()
# Geist on every board. CoreS3 briefly aliased these names to Montserrat while the
# compositor was packing panel rows wrong; that looked like a font bug. The packed
# flush is fixed, and Montserrat does not contain the UI symbols (› ✓ ✗ …) Geist does.
set(GEIST_SRCS
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
)
idf_component_register(
    SRCS
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
        "ui/touch.c"
        "ui/ui_screens.c"
        "ui/carousel_ring.c"
        ${GEIST_SRCS}
        "ui/icons_settings.c"
        "ui/spinner_spokes.c"
        "ui/icons_engine.c"
        "ui/icons_voice.c"
    INCLUDE_DIRS
        "."
        "ui"
        "board"
    REQUIRES
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
    PRIV_REQUIRES
        ${CORES3_PRIV_REQUIRES}
)

# CoreS3 port (DEVICE_BOARD_M5CORES3): swap the panel driver in, add the board bring-up and its native
# 320x240 flush, the 0.6x Geist faces (ui_fonts.h maps the dial's names onto them), and pull the
# ILI9341/FT5x06 drivers the round dial doesn't use.
# Build:  . ~/esp/esp-idf/export.sh && scripts/build-cores3.sh
if(DEVICE_BOARD_M5CORES3)
    target_compile_definitions(${COMPONENT_LIB} PUBLIC DEVICE_BOARD_M5CORES3=1)
    target_sources(${COMPONENT_LIB} PRIVATE
        "board/cores3_board.c"
        "board/cores3_clock.c"
        "ui/display_cores3.c"
        "ui/icons_c3.c"
        "wifi_sta.c"
        "wifi_cable.c"
        "ui/geist_c3_reg_10.c" "ui/geist_c3_reg_12.c" "ui/geist_c3_reg_15.c" "ui/geist_c3_reg_18.c" "ui/geist_c3_reg_20.c"
        "ui/geist_c3_reg_21.c" "ui/geist_c3_reg_23.c" "ui/geist_c3_med_17.c" "ui/geist_c3_med_20.c"
        "ui/geist_c3_med_23.c" "ui/geist_c3_med_29.c" "ui/geist_c3_med_39.c" "ui/geist_c3_sem_15.c"
    )
endif()

# snprintf() is bounded (it truncates, never overflows), but -O2 enables a noisy
# format-truncation analysis that errors on safe same-size copies. Keep it as a warning, not error.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-format-truncation)

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
if(BOARD_PROBE)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE BOARD_PROBE=1)
    target_sources(${COMPONENT_LIB} PRIVATE "board/board_probe.c")
endif()
