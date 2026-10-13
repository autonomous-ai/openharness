# The single "main" component. Board drivers live under board/, the panel and touch under display/, and
# the settings and boot diagnostics under sys/, and the app layer (Pod's glue, pro_app, the finger) under app/.
if(NOT IDF_TARGET STREQUAL "esp32p4")
    message(FATAL_ERROR "The Harness Pro firmware builds for esp32p4 only (got ${IDF_TARGET})")
endif()

idf_component_register(
    SRCS
        "app_main.c"
        "audio/audio_capture.c"
        "audio/pro_recorder.c"
        "audio/pro_voice.c"
        "audio/voice_buffer.c"
        "app/pod_glue.c"
        "app/pro_app.c"
        "app/pro_touch.c"
        "board/board_i2c.c"
        "board/board_pro.c"
        "board/power_pro.c"
        "board/ptt_pro.c"
        "cable/cable_features.c"
        "cable/cable_frame.c"
        "cable/cable_json_guard.c"
        "cable/cable_link.c"
        "cable/cable_machines.c"
        "cable/cable_scroll.c"
        "cable/pro_cable.c"
        "display/pro_display.c"
        "display/pro_panel_bus.c"
        "display/touch_gt911.c"
        "display/pro_frame.c"
        "display/pro_canvas.c"
        "display/terminal.c"
        "display/scroll.c"
        "pod/engine_logos.c"
        "pod/pets.c"
        "pod/pod_chrome.c"
        "pod/pod_draw.c"
        "pod/pod_model.c"
        "pod/pod_nav.c"
        "pod/pod_pet.c"
        "pod/pod_view.c"
        "pod/pod_view_agent.c"
        "pod/pod_view_inbox.c"
        "pod/pod_view_ota.c"
        "pod/pod_view_recap.c"
        "pod/pod_view_tab.c"
        "pod/pod_view_tabs.c"
        "pod/pod_view_talk.c"
        "sys/config_store.c"
        "sys/device_mac.c"
        "sys/fw_update.c"
        "sys/last_words.c"
        "sys/ram_telemetry.c"
    INCLUDE_DIRS
        "."
        "audio"
        "board"
        "display"
        "sys"
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
        esp_timer
        esp_psram
        json
        nvs_flash
        mbedtls
)

# POD_PANEL_TURN=180 turns picture and touch together (display/pro_display.c).
if(POD_PANEL_TURN)
    if(NOT POD_PANEL_TURN EQUAL 180)
        message(FATAL_ERROR "POD_PANEL_TURN must be 180")
    endif()
    target_compile_definitions(${COMPONENT_LIB} PRIVATE POD_PANEL_TURN=180)
endif()

# snprintf() is bounded (it truncates, never overflows), but -O2 enables a noisy format-truncation
# analysis that errors on safe same-size copies. Keep it as a warning, not error.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-format-truncation)

# Text atlases are baked at build time (never committed). The font is chosen HERE, once, exactly as scripts/gen_fonts.py
# would (-DPRO_FONT=/path/font.ttf, else macOS Helvetica when present, else the bundled Liberation Sans), then named in
# the configure output, passed to the generator explicitly and listed as a dependency: the build never re-decides.
set(PRO_FONTS_C ${CMAKE_BINARY_DIR}/pro_fonts.c)
if(PRO_FONT)
    set(PRO_FONT_SRC ${PRO_FONT})
    set(PRO_FONT_WHY "-DPRO_FONT")
elseif(EXISTS /System/Library/Fonts/Helvetica.ttc)
    set(PRO_FONT_SRC /System/Library/Fonts/Helvetica.ttc)
    set(PRO_FONT_WHY "macOS system sans")
else()
    set(PRO_FONT_SRC ${PROJECT_DIR}/fonts/LiberationSans-Regular.ttf)
    set(PRO_FONT_WHY "bundled Liberation Sans")
endif()
if(NOT EXISTS ${PRO_FONT_SRC})
    message(FATAL_ERROR "Pro font not found: ${PRO_FONT_SRC}")
endif()
message(STATUS "Pro text font: ${PRO_FONT_SRC} (${PRO_FONT_WHY})")
set(PRO_FONT_ARGS --font ${PRO_FONT_SRC})
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
    COMMAND ${PRO_PYTHON} ${PROJECT_DIR}/scripts/gen_fonts.py ${PRO_FONT_ARGS} --out ${PRO_FONTS_C}
    DEPENDS ${PROJECT_DIR}/scripts/gen_fonts.py ${PRO_FONT_SRC}
    COMMENT "Baking Pro text atlases"
    VERBATIM)
target_sources(${COMPONENT_LIB} PRIVATE ${PRO_FONTS_C})
