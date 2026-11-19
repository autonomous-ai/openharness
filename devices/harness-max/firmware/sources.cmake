# Harness Max's portable C: everything that runs unchanged on the ESP32-P4 and as a Linux program, one list for both
# builds. main/CMakeLists.txt (ESP-IDF) adds the ESP32-P4 drivers on top of it, linux/CMakeLists.txt the Linux ones:
# the panel, touch, audio, the cable's transport, the board table and the entry point. A board change is a build target.
#
# The Pro's generic sources are compiled where they are (devices/harness-pro/firmware/main), at the Max's glass size.
#
# HEADER ORDER MATTERS. A quoted include looks in the including file's own directory first, then in the include
# directories in order. Max's main/ comes first, so the Pro's pro_cable.c finds Max's "board/board.h"; the Pro's board/
# directory is never on the path, and no Pro source whose same-directory headers are Pro-only (pro_display.c,
# pro_app.c, the board files) is compiled here.
get_filename_component(MAX_FW ${CMAKE_CURRENT_LIST_DIR} ABSOLUTE)
get_filename_component(PRO_FW ${MAX_FW}/../../harness-pro/firmware ABSOLUTE)
set(PRO_MAIN ${PRO_FW}/main)

# Globbed so a new screen or demo file needs no edit here; CONFIGURE_DEPENDS re-globs on every build. ESP-IDF also
# reads this file in script mode (its component requirements pass), which refuses the flag.
if(CMAKE_SCRIPT_MODE_FILE)
    set(MAX_GLOB_FLAGS)
else()
    set(MAX_GLOB_FLAGS CONFIGURE_DEPENDS)
endif()
file(GLOB MAX_UI_SRCS ${MAX_GLOB_FLAGS} ${MAX_FW}/main/app/max_ui*.c)
file(GLOB MAX_DEMO_SRCS ${MAX_GLOB_FLAGS} ${MAX_FW}/main/demo/*.c)

set(MAX_PORTABLE_SRCS
    ${MAX_FW}/main/app/max_app.c
    ${MAX_FW}/main/audio/max_chime_pcm.c
    ${MAX_UI_SRCS}
    ${MAX_DEMO_SRCS}
    ${PRO_MAIN}/app/pro_touch.c
    ${PRO_MAIN}/audio/pro_recorder.c
    ${PRO_MAIN}/audio/pro_voice.c
    ${PRO_MAIN}/audio/voice_buffer.c
    ${PRO_MAIN}/cable/cable_features.c
    ${PRO_MAIN}/cable/cable_frame.c
    ${PRO_MAIN}/cable/cable_json_guard.c
    ${PRO_MAIN}/cable/cable_machines.c
    ${PRO_MAIN}/cable/cable_scroll.c
    ${PRO_MAIN}/cable/pro_cable.c
    ${PRO_MAIN}/display/pro_canvas.c
    ${PRO_MAIN}/display/pro_frame.c
    ${PRO_MAIN}/display/scroll.c
    ${PRO_MAIN}/display/terminal.c
    ${PRO_MAIN}/pod/engine_logos.c
    ${PRO_MAIN}/pod/pets.c
    ${PRO_MAIN}/pod/pets_ask.c
    ${PRO_MAIN}/pod/pets_codex.c
    ${PRO_MAIN}/pod/pod_draw.c
    ${PRO_MAIN}/pod/pod_pet.c
    ${PRO_MAIN}/sys/config_store.c
    ${PRO_MAIN}/sys/crash_record.c
    ${PRO_MAIN}/sys/device_mac.c
    ${PRO_MAIN}/sys/fw_update.c
    ${PRO_MAIN}/sys/last_words.c
    ${PRO_MAIN}/sys/ram_telemetry.c
)

set(MAX_PORTABLE_INCLUDE_DIRS
    ${MAX_FW}/main
    ${PRO_MAIN}
    ${PRO_MAIN}/display
    ${PRO_MAIN}/sys
)

# The text atlases, baked at build time by the Pro's generator from the Pro's fonts, with the Pro's font choice
# (-DPRO_FONT=/path/font.ttf, else macOS Helvetica when present, else the bundled Liberation Sans). See the Pro's
# main/CMakeLists.txt for why the choice is made once. max_bake_fonts(<out.c>) adds the command that writes <out.c>.
function(max_bake_fonts out)
    if(PRO_FONT)
        set(font ${PRO_FONT})
        set(why "-DPRO_FONT")
    elseif(EXISTS /System/Library/Fonts/Helvetica.ttc)
        set(font /System/Library/Fonts/Helvetica.ttc)
        set(why "macOS system sans")
    else()
        set(font ${PRO_FW}/fonts/LiberationSans-Regular.ttf)
        set(why "bundled Liberation Sans")
    endif()
    if(NOT EXISTS ${font})
        message(FATAL_ERROR "Pro font not found: ${font}")
    endif()
    message(STATUS "Max text font: ${font} (${why})")
    # The IDF virtualenv has no Pillow, so pick the first interpreter that does (override: -DPRO_PYTHON=...).
    set(python ${PRO_PYTHON})
    if(NOT python)
        foreach(candidate ${PYTHON} /usr/local/bin/python3 /opt/homebrew/bin/python3 /usr/bin/python3 python3)
            if(NOT python)
                execute_process(COMMAND ${candidate} -c "import PIL" RESULT_VARIABLE pil_rc OUTPUT_QUIET ERROR_QUIET)
                if(pil_rc EQUAL 0)
                    set(python ${candidate})
                endif()
            endif()
        endforeach()
    endif()
    if(NOT python)
        message(FATAL_ERROR "Pillow is needed to bake the fonts: pip3 install pillow (or set -DPRO_PYTHON)")
    endif()
    add_custom_command(
        OUTPUT ${out}
        COMMAND ${python} ${PRO_FW}/scripts/gen_fonts.py --font ${font} --out ${out}
        DEPENDS ${PRO_FW}/scripts/gen_fonts.py ${font} ${PRO_FW}/fonts/Inter-SemiBold.ttf ${PRO_FW}/fonts/Inter-Bold.ttf
                ${PRO_FW}/fonts/Inter-Regular.ttf ${PRO_FW}/fonts/JetBrainsMono-Medium.ttf
        COMMENT "Baking Max text atlases"
        VERBATIM)
endfunction()
