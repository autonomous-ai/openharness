# The single "main" component: Harness Max's own board, display, audio and app, over the Pro's generic sources compiled
# where they are (devices/harness-pro/firmware/main), at the Max's glass size.
#
# HEADER ORDER MATTERS. A quoted include looks in the including file's own directory first, then in INCLUDE_DIRS in
# order. Max's directories come first, so the Pro's pro_cable.c finds Max's "board/board.h"; the Pro's board/ directory
# is never on the path, and no Pro source whose same-directory headers are Pro-only (pro_display.c, pro_app.c, the
# board files) is compiled here.
if(NOT IDF_TARGET STREQUAL "esp32p4")
    message(FATAL_ERROR "The Harness Max firmware builds for esp32p4 only (got ${IDF_TARGET})")
endif()

get_filename_component(PRO_FW ${CMAKE_CURRENT_LIST_DIR}/../../../harness-pro/firmware ABSOLUTE)
set(PRO_MAIN ${PRO_FW}/main)

idf_component_register(
    SRCS
        "app_main.c"
        "app/max_app.c"
        "app/max_ui_model.c"
        "app/max_ui_touch.c"
        "app/max_ui_view.c"
        "audio/max_audio.c"
        "board/board_max.c"
        "board/max_i2c.c"
        "display/max_display.c"
        "display/max_panel.c"
        "display/max_touch.c"
        "display/max_turn.c"
        "${PRO_MAIN}/app/pro_touch.c"
        "${PRO_MAIN}/audio/pro_recorder.c"
        "${PRO_MAIN}/audio/pro_voice.c"
        "${PRO_MAIN}/audio/voice_buffer.c"
        "${PRO_MAIN}/cable/cable_features.c"
        "${PRO_MAIN}/cable/cable_frame.c"
        "${PRO_MAIN}/cable/cable_json_guard.c"
        "${PRO_MAIN}/cable/cable_link.c"
        "${PRO_MAIN}/cable/cable_machines.c"
        "${PRO_MAIN}/cable/cable_scroll.c"
        "${PRO_MAIN}/cable/pro_cable.c"
        "${PRO_MAIN}/display/pro_canvas.c"
        "${PRO_MAIN}/display/pro_frame.c"
        "${PRO_MAIN}/display/scroll.c"
        "${PRO_MAIN}/display/terminal.c"
        "${PRO_MAIN}/pod/pod_draw.c"
        "${PRO_MAIN}/sys/config_store.c"
        "${PRO_MAIN}/sys/crash_record.c"
        "${PRO_MAIN}/sys/device_mac.c"
        "${PRO_MAIN}/sys/fw_update.c"
        "${PRO_MAIN}/sys/last_words.c"
        "${PRO_MAIN}/sys/ram_telemetry.c"
    INCLUDE_DIRS
        "."
        "board"
        "display"
        "${PRO_MAIN}"
        "${PRO_MAIN}/display"
        "${PRO_MAIN}/sys"
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

# Text atlases are baked at build time by the Pro's generator, from the Pro's fonts, with the Pro's font choice
# (-DPRO_FONT=/path/font.ttf, else macOS Helvetica when present, else the bundled Liberation Sans). See the Pro's
# main/CMakeLists.txt for why the choice is made once, here.
set(PRO_FONTS_C ${CMAKE_BINARY_DIR}/pro_fonts.c)
if(PRO_FONT)
    set(PRO_FONT_SRC ${PRO_FONT})
    set(PRO_FONT_WHY "-DPRO_FONT")
elseif(EXISTS /System/Library/Fonts/Helvetica.ttc)
    set(PRO_FONT_SRC /System/Library/Fonts/Helvetica.ttc)
    set(PRO_FONT_WHY "macOS system sans")
else()
    set(PRO_FONT_SRC ${PRO_FW}/fonts/LiberationSans-Regular.ttf)
    set(PRO_FONT_WHY "bundled Liberation Sans")
endif()
if(NOT EXISTS ${PRO_FONT_SRC})
    message(FATAL_ERROR "Pro font not found: ${PRO_FONT_SRC}")
endif()
message(STATUS "Max text font: ${PRO_FONT_SRC} (${PRO_FONT_WHY})")
# The IDF virtualenv has no Pillow, so pick the first interpreter that does (override: -DPRO_PYTHON=...).
if(NOT PRO_PYTHON)
    foreach(candidate ${PYTHON} /usr/local/bin/python3 /opt/homebrew/bin/python3 /usr/bin/python3 python3)
        if(NOT PRO_PYTHON)
            execute_process(COMMAND ${candidate} -c "import PIL" RESULT_VARIABLE _pil_rc
                            OUTPUT_QUIET ERROR_QUIET)
            if(_pil_rc EQUAL 0)
                set(PRO_PYTHON ${candidate})
            endif()
        endif()
    endforeach()
endif()
if(NOT PRO_PYTHON)
    message(FATAL_ERROR "Pillow is needed to bake the fonts: pip3 install pillow (or set -DPRO_PYTHON)")
endif()
add_custom_command(
    OUTPUT ${PRO_FONTS_C}
    COMMAND ${PRO_PYTHON} ${PRO_FW}/scripts/gen_fonts.py --font ${PRO_FONT_SRC} --out ${PRO_FONTS_C}
    DEPENDS ${PRO_FW}/scripts/gen_fonts.py ${PRO_FONT_SRC} ${PRO_FW}/fonts/Inter-SemiBold.ttf ${PRO_FW}/fonts/Inter-Bold.ttf
            ${PRO_FW}/fonts/Inter-Regular.ttf ${PRO_FW}/fonts/JetBrainsMono-Medium.ttf
    COMMENT "Baking Max text atlases"
    VERBATIM)
target_sources(${COMPONENT_LIB} PRIVATE ${PRO_FONTS_C})
