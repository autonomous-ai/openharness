# The one component: the Max's portable sources (../../sources.cmake), and below them the Pro's board as the Pro's
# firmware drives it: its panel and backlight (pro_panel_bus.c), its touch (touch_gt911.c), its shared I2C bus, its
# power latch and its audio (audio_capture.c: the ES7210 microphones and the ES8311 speaker), each compiled where it is,
# untouched. This directory adds the glass's shrink into the panel (max_shrink.c, display_on_pro.c), the board table,
# the chimes on the Pro's beep, the headers the Pro's drivers find beside them in the Pro's tree, and app_main.
include(${CMAKE_CURRENT_LIST_DIR}/../../sources.cmake)

idf_component_register(
    SRCS
        "app_main.c"
        "board_on_pro.c"
        "chime_on_pro.c"
        "display_on_pro.c"
        "max_shrink.c"
        "${PRO_MAIN}/audio/audio_capture.c"
        "${PRO_MAIN}/board/board_i2c.c"
        "${PRO_MAIN}/board/power_pro.c"
        "${PRO_MAIN}/cable/cable_link.c"
        "${PRO_MAIN}/display/pro_panel_bus.c"
        "${PRO_MAIN}/display/touch_gt911.c"
        ${MAX_PORTABLE_SRCS}
    INCLUDE_DIRS
        ${MAX_PORTABLE_INCLUDE_DIRS}
        "."
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
        esp_driver_ledc
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

# The Max's glass, flags and fonts, as ../../main/CMakeLists.txt.
target_compile_definitions(${COMPONENT_LIB} PRIVATE HT_WIDTH=1920 HT_HEIGHT=480 PRO_DISPLAY_W=1920 PRO_DISPLAY_H=480)
max_glass(${COMPONENT_LIB})
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-format-truncation)

set(PRO_FONTS_C ${CMAKE_BINARY_DIR}/pro_fonts.c)
max_bake_fonts(${PRO_FONTS_C})
target_sources(${COMPONENT_LIB} PRIVATE ${PRO_FONTS_C})
