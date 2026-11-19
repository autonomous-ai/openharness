# The bench's one component: bench_main.c, the bench's portable timing code (../bench_*.c, also built on the host by
# ../profile.sh), and from the product what draws and turns the glass: Max's screens (../../main/app/max_ui*.c) and their
# demo scenes (../../test/max_render.c), the Pro's compositor, and the strip turn (CPU and PPA).
include(${CMAKE_CURRENT_LIST_DIR}/../../sources.cmake)
set(BENCH ${CMAKE_CURRENT_LIST_DIR}/..)

idf_component_register(
    SRCS
        "bench_main.c"
        "${BENCH}/bench_raster.c"
        "${BENCH}/bench_scenes.c"
        "${MAX_FW}/main/display/max_turn.c"
        "${MAX_FW}/main/display/max_turn_ppa.c"
        ${MAX_UI_SRCS}
        "${PRO_MAIN}/display/terminal.c"
        "${PRO_MAIN}/display/pro_canvas.c"
        "${PRO_MAIN}/pod/pod_draw.c"
        "${PRO_MAIN}/pod/pod_pet.c"
        "${PRO_MAIN}/pod/pets.c"
        "${PRO_MAIN}/pod/pets_ask.c"
        "${PRO_MAIN}/pod/pets_codex.c"
        "${PRO_MAIN}/pod/engine_logos.c"
    INCLUDE_DIRS
        "${BENCH}"
        "${MAX_FW}/test"
        "${MAX_FW}/main/app"
        "${MAX_FW}/main/display"
        "${PRO_MAIN}"
        "${PRO_MAIN}/display"
    REQUIRES
        esp_driver_ppa
        esp_hw_support
        esp_mm
        esp_psram
        esp_rom
        esp_timer
        heap
)

# The product's glass and flags (../../main/CMakeLists.txt).
target_compile_definitions(${COMPONENT_LIB} PRIVATE HT_WIDTH=1920 HT_HEIGHT=480 PRO_DISPLAY_W=1920 PRO_DISPLAY_H=480)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-format-truncation)

set(PRO_FONTS_C ${CMAKE_BINARY_DIR}/pro_fonts.c)
max_bake_fonts(${PRO_FONTS_C})
target_sources(${COMPONENT_LIB} PRIVATE ${PRO_FONTS_C})
