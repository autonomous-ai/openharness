# The single "main" component: Harness Max's portable sources (../sources.cmake, shared with the Linux build) and, on
# top of them, the ESP32-P4 drivers: the board, the panel, touch, backlight and turn behind the Pro's pro_display.h, the
# ES8311 behind the Pro's audio/audio_capture.h, the Pro's USB-Serial-JTAG transport behind cable_link.h, and app_main.
if(NOT IDF_TARGET STREQUAL "esp32p4")
    message(FATAL_ERROR "The Harness Max firmware builds for esp32p4 only (got ${IDF_TARGET})")
endif()

include(${CMAKE_CURRENT_LIST_DIR}/../sources.cmake)

idf_component_register(
    SRCS
        "app_main.c"
        "audio/max_audio.c"
        "board/board_max.c"
        "board/max_i2c.c"
        "display/max_display.c"
        "display/max_panel.c"
        "display/max_touch.c"
        "display/max_turn.c"
        "display/max_turn_ppa.c"
        "${PRO_MAIN}/cable/cable_link.c"
        ${MAX_PORTABLE_SRCS}
    INCLUDE_DIRS
        ${MAX_PORTABLE_INCLUDE_DIRS}
        "board"
        "display"
    REQUIRES
        app_update
        bootloader_support
        esp_app_format
        esp_partition
        esp_system
        hal
        esp_driver_i2c
        esp_driver_gpio
        esp_driver_i2s
        esp_driver_ppa
        esp_driver_usb_serial_jtag
        esp_lcd
        esp_lcd_touch
        esp_hw_support
        esp_mm
        esp_timer
        esp_psram
        json
        nvs_flash
        mbedtls
)

# The compositor and every shared caller at the Max's glass: 1920 x 480, landscape. pro_display.h and terminal.h take
# these instead of their 720 defaults.
target_compile_definitions(${COMPONENT_LIB} PRIVATE HT_WIDTH=1920 HT_HEIGHT=480 PRO_DISPLAY_W=1920 PRO_DISPLAY_H=480)

# As the Pro: snprintf() truncates safely, and -O2's format-truncation analysis errors on same-size copies.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-format-truncation)

set(PRO_FONTS_C ${CMAKE_BINARY_DIR}/pro_fonts.c)
max_bake_fonts(${PRO_FONTS_C})
target_sources(${COMPONENT_LIB} PRIVATE ${PRO_FONTS_C})
