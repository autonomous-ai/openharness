# Top-level ESP-IDF project file. ONE project, ONE board, ONE renderer.
#
#   dial  ESP32-S3R8 · 466x466 round AMOLED (CO5300, QSPI) · CST9217 or CST816S touch
#
# The ESP32-P4 Pro was built from this project until 2026-09-29 and now has its own firmware, owned by
# the team that owns the board. What the two shared was the CABLE PROTOCOL — see main/cable_client.c —
# which is a wire format rather than a build, so nothing had to stay here for a Pro to keep working with
# this daemon. The runtime probe in main/board/board.h still tells the two DIAL revisions apart; that is
# a different question and it remains.
#
# Requires ESP-IDF >= 5.5.
#
#   idf.py build           idf.py -p <port> flash
#
# No target and no flags: sdkconfig.defaults names the chip and there is one renderer. The
# `make dial-build` / `make pro-build` pair this comment used to advertise named Makefile targets
# that no longer existed anywhere in the repository.
cmake_minimum_required(VERSION 3.16)

# ── Keep sdkconfig honest about sdkconfig.defaults ───────────────────────────────────────────────────
# ESP-IDF reads sdkconfig.defaults ONLY when creating sdkconfig. After that sdkconfig is authoritative and
# defaults are ignored outright — no merge, no warning. That is deliberate (so `idf.py menuconfig` edits
# survive), but it means the file we track states the intent while the file we gitignore decides the build.
#
# On 2026-07-30 that cost two weeks: commit 1f6c5be (2026-07-16) raised ESP_MAIN_TASK_STACK_SIZE to 10240,
# moved BSS to PSRAM and re-shaped the LVGL pool, but every build on a checkout whose sdkconfig predated it
# silently kept the old values. It surfaced as a broken build (a new font was referenced) and, worse, as
# published firmware that overflowed the main stack mid-OTA and could never update itself.
#
# So: stamp the hash of the defaults beside sdkconfig. When they disagree, delete sdkconfig and let IDF
# re-seed it. Day-to-day menuconfig still works; a pull that changes defaults re-applies automatically.
# A deliberate local tweak belongs in sdkconfig.defaults, where it is reviewable and reaches everyone.
#
# TWO BOARDS, TWO SDKCONFIGS. Each build passes its own (`idf.py -D SDKCONFIG=sdkconfig.pro`), so the
# stamp has to follow that file rather than assume the default name — one shared stamp would have each
# board's build delete the other board's config, every time, for ever. And the hash covers EVERY defaults
# file, not just the one this target reads: the alternative is a build that quietly keeps a stale config
# because the change happened to land in the other target's file.
if(DEFINED SDKCONFIG)
    get_filename_component(_sdkcfg "${SDKCONFIG}" ABSOLUTE BASE_DIR "${CMAKE_CURRENT_LIST_DIR}")
else()
    set(_sdkcfg "${CMAKE_CURRENT_LIST_DIR}/sdkconfig")
endif()
set(_stamp "${_sdkcfg}.defaults.stamp")
file(GLOB _defaults "${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults" "${CMAKE_CURRENT_LIST_DIR}/sdkconfig.defaults.*")
list(REMOVE_ITEM _defaults "${_stamp}")
list(FILTER _defaults EXCLUDE REGEX "\\.stamp$")
list(SORT _defaults)
if(_defaults)
    set(_defaults_hash "")
    foreach(_f IN LISTS _defaults)
        file(SHA256 "${_f}" _one)
        string(APPEND _defaults_hash "${_one}")
    endforeach()
    string(SHA256 _defaults_hash "${_defaults_hash}")
    set(_prev_hash "")
    if(EXISTS "${_stamp}")
        file(READ "${_stamp}" _prev_hash)
        string(STRIP "${_prev_hash}" _prev_hash)
    endif()
    if(EXISTS "${_sdkcfg}" AND NOT _prev_hash STREQUAL _defaults_hash)
        message(WARNING
            "sdkconfig.defaults changed since ${_sdkcfg} was generated -- regenerating it.\n"
            "Any local `idf.py menuconfig` tweak not present in a sdkconfig.defaults file is being "
            "discarded; put it there if it should survive.\n"
            "Previous config saved as ${_sdkcfg}.superseded.")
        file(RENAME "${_sdkcfg}" "${_sdkcfg}.superseded")
    endif()
    file(WRITE "${_stamp}" "${_defaults_hash}")
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)


project(interns_commander)
