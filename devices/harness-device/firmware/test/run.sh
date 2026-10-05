#!/usr/bin/env bash
# Host tests for the parts of the firmware that do not need the board.
#
#   devices/harness-device/firmware/test/run.sh
#
# No ESP-IDF, no flash cycle, no cable: cable_frame.c compiles with a plain compiler on purpose, so the
# framing both halves of the link depend on can be checked in milliseconds. Run it before touching either
# half — the daemon's TypeScript decoder asserts against the same vectors, and a change here that is not
# a change there is a link that opens and then delivers nothing.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

# The vectors are generated, not written. Regenerating first means a stale file cannot pass as agreement.
python3 "$here/../scripts/gen_cable_vectors.py" --check
python3 "$here/../scripts/gen_tux_moods.py" --check
python3 "$here/../scripts/gen_pets.py" --check
python3 "$here/../scripts/gen_arc_geometry.py" --check

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_character" "$here/test_character.c" \
   "$here/../main/ui/habitat/character.c" "$here/../main/ui/habitat/illustrated.c" "$here/../main/ui/habitat/character_motion.c" \
   "$here/../main/ui/habitat/character_layout.c" "$here/../main/ui/habitat/tux.c" \
   "$here/../main/ui/habitat/focus.c" "$here/../main/ui/habitat/lvgl_fonts.c" "$here/../main/ui/habitat/lvgl_icons.c" "$here/../main/ui/habitat/focus_marks.c" "$here/../main/ui/habitat/focus_faces.c" "$here/../main/ui/habitat/pets.c" \
   "$here/../main/ui/habitat/octopus.c" "$here/../main/ui/habitat/octopus_font.c" \
   "$here/../main/ui/habitat/ascii_clip.c" \
   "$here/../main/ui/habitat/terminal.c" "$here/../main/ui/habitat/fonts.c"
"$out/test_character"
python3 "$here/test_character_preferences.py"

cc -std=c11 -Wall -Wextra -Werror -O1 \
   -o "$out/test_cable_frame" "$here/test_cable_frame.c" "$here/../main/cable_frame.c"
"$out/test_cable_frame" "$here/vectors/cable_frame.txt"
python3 "$here/test_cable_transport.py"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_cable_json_guard" "$here/test_cable_json_guard.c" "$here/../main/cable_json_guard.c"
"$out/test_cable_json_guard"

cc -std=c11 -Wall -Wextra -Werror -O1 \
   -o "$out/test_cable_machines" "$here/test_cable_machines.c" "$here/../main/cable_machines.c"
"$out/test_cable_machines"

# Which dial this image is on, decided from who answered on the I2C bus. Two boards ship on one image;
# the table that tells them apart is arithmetic on a list of addresses, so it is proved here.
cc -std=c11 -Wall -Wextra -Werror -O1 \
   -o "$out/test_board" "$here/test_board.c" "$here/../main/board/board_table.c"
"$out/test_board"
python3 "$here/test_board_i2c.py"

# New direct compositor: fuzz partial redraws against a fresh frame under UB/bounds sanitizers.
# SANITIZERS=address,undefined also enables ASan on hosts with a compatible ASan runtime.
cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_terminal" "$here/test_terminal.c" \
   "$here/../main/ui/habitat/terminal.c" "$here/../main/ui/habitat/fonts.c"
"$out/test_terminal"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_arc_pixels" "$here/test_arc_pixels.c" \
   "$here/../main/ui/habitat/focus_faces.c" "$here/../main/ui/habitat/lvgl_fonts.c" \
   "$here/../main/ui/habitat/terminal.c" "$here/../main/ui/habitat/fonts.c"
"$out/test_arc_pixels"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -I "$here/../main/ui/habitat" -o "$out/test_arc_storage" "$here/test_arc_storage.c" \
   "$here/reference79/terminal_ref.c" "$here/../main/ui/habitat/fonts.c" \
   "$here/../main/ui/habitat/focus_faces.c" "$here/../main/ui/habitat/lvgl_fonts.c"
"$out/test_arc_storage"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" -DDEVICE_LAYOUT_BENCH=1 \
   -o "$out/test_arc_bounds" "$here/test_arc_bounds.c" \
   "$here/../main/ui/habitat/focus_faces.c" "$here/../main/ui/habitat/lvgl_fonts.c" \
   "$here/../main/ui/habitat/terminal.c" "$here/../main/ui/habitat/fonts.c"
"$out/test_arc_bounds"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -I "$here/../main/ui/habitat" -o "$out/test_arc_ring" "$here/test_arc_ring.c" \
   "$here/../main/ui/habitat/terminal.c" "$here/../main/ui/habitat/fonts.c" -lm
"$out/test_arc_ring"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_voice_buffer" "$here/test_voice_buffer.c" "$here/../main/voice_buffer.c"
"$out/test_voice_buffer"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" -pthread \
   -o "$out/test_voice_buffer_threads" "$here/test_voice_buffer_threads.c" "$here/../main/voice_buffer.c"
"$out/test_voice_buffer_threads"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_scroll" "$here/test_scroll.c" "$here/../main/ui/habitat/scroll.c" -lm
"$out/test_scroll"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_gestures" "$here/test_gestures.c" "$here/../main/ui/habitat/gestures.c"
"$out/test_gestures"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_workspace" "$here/test_workspace.c" "$here/../main/ui/habitat/workspace.c"
"$out/test_workspace"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_tim" "$here/test_tim.c" "$here/../main/ui/habitat/tim.c" "$here/../main/ui/habitat/character_motion.c" "$here/../main/ui/habitat/character_layout.c" \
   "$here/../main/ui/habitat/terminal.c" "$here/../main/ui/habitat/fonts.c"
"$out/test_tim"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_octopus" "$here/test_octopus.c" "$here/../main/ui/habitat/octopus.c" \
   "$here/../main/ui/habitat/octopus_font.c" "$here/../main/ui/habitat/ascii_clip.c" "$here/../main/ui/habitat/tim.c" "$here/../main/ui/habitat/character_motion.c" "$here/../main/ui/habitat/character_layout.c" \
   "$here/../main/ui/habitat/terminal.c" "$here/../main/ui/habitat/fonts.c"
"$out/test_octopus"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -I "$here/../main/ui/habitat" -I "$here" -o "$out/test_renderer_reference" \
   "$here/test_renderer_reference.c" "$here/reference48/terminal_ref.c" "$here/reference48/octopus_ref.c" \
   "$here/../main/ui/habitat/octopus.c" "$here/../main/ui/habitat/ascii_clip.c" \
   "$here/../main/ui/habitat/octopus_font.c" "$here/../main/ui/habitat/tim.c" "$here/../main/ui/habitat/character_motion.c" "$here/../main/ui/habitat/character_layout.c" \
   "$here/../main/ui/habitat/terminal.c" "$here/../main/ui/habitat/fonts.c"
"$out/test_renderer_reference"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" -DDEVICE_LAYOUT_BENCH=1 \
   -o "$out/test_ascii_scene" "$here/test_ascii_scene.c" "$here/../main/ui/habitat/octopus.c" \
   "$here/../main/ui/habitat/octopus_font.c" "$here/../main/ui/habitat/ascii_clip.c" "$here/../main/ui/habitat/tim.c" "$here/../main/ui/habitat/character_motion.c" "$here/../main/ui/habitat/character_layout.c" \
   "$here/../main/ui/habitat/terminal.c" "$here/../main/ui/habitat/fonts.c"
"$out/test_ascii_scene"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_glyph_cache" "$here/test_glyph_cache.c" "$here/../main/ui/habitat/octopus.c" \
   "$here/../main/ui/habitat/octopus_font.c" "$here/../main/ui/habitat/ascii_clip.c" "$here/../main/ui/habitat/tim.c" "$here/../main/ui/habitat/character_motion.c" "$here/../main/ui/habitat/character_layout.c" \
   "$here/../main/ui/habitat/terminal.c" "$here/../main/ui/habitat/fonts.c"
"$out/test_glyph_cache"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -DDEVICE_LAYOUT_BENCH=1 -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_raster_ascii" "$here/test_raster_ascii.c" "$here/../main/ui/habitat/octopus.c" \
   "$here/../main/ui/habitat/octopus_font.c" "$here/../main/ui/habitat/ascii_clip.c" "$here/../main/ui/habitat/tim.c" "$here/../main/ui/habitat/character_motion.c" "$here/../main/ui/habitat/character_layout.c" \
   "$here/../main/ui/habitat/terminal.c" "$here/../main/ui/habitat/fonts.c"
"$out/test_raster_ascii"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -DDEVICE_LAYOUT_BENCH=1 -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_damage_delta" "$here/test_damage_delta.c" "$here/../main/ui/habitat/octopus.c" \
   "$here/../main/ui/habitat/octopus_font.c" "$here/../main/ui/habitat/ascii_clip.c" "$here/../main/ui/habitat/tim.c" "$here/../main/ui/habitat/character_motion.c" "$here/../main/ui/habitat/character_layout.c" \
   "$here/../main/ui/habitat/terminal.c" "$here/../main/ui/habitat/fonts.c"
"$out/test_damage_delta"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -DDEVICE_LAYOUT_BENCH=1 -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_damage_bands" "$here/test_damage_bands.c" "$here/../main/ui/habitat/octopus.c" \
   "$here/../main/ui/habitat/octopus_font.c" "$here/../main/ui/habitat/ascii_clip.c" "$here/../main/ui/habitat/tim.c" "$here/../main/ui/habitat/character_motion.c" "$here/../main/ui/habitat/character_layout.c" \
   "$here/../main/ui/habitat/terminal.c" "$here/../main/ui/habitat/fonts.c"
"$out/test_damage_bands"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -DDEVICE_LAYOUT_BENCH=1 -o "$out/test_ascii_clip" "$here/test_ascii_clip.c" "$here/../main/ui/habitat/ascii_clip.c"
"$out/test_ascii_clip"
python3 "$here/test_octopus_art.py"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_creature_gallery" "$here/test_creature_gallery.c" \
   "$here/../main/ui/habitat/creature_gallery.c" "$here/../main/ui/habitat/creature_font.c" \
   "$here/../main/ui/habitat/terminal.c" "$here/../main/ui/habitat/fonts.c"
"$out/test_creature_gallery"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_selection" "$here/test_selection.c" "$here/../main/ui/habitat/selection.c"
"$out/test_selection"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_carry" "$here/test_carry.c" "$here/../main/ui/habitat/carry.c"
"$out/test_carry"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_visit" "$here/test_visit.c" "$here/../main/ui/habitat/visit.c"
"$out/test_visit"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_form" "$here/test_form.c" "$here/../main/ui/habitat/form.c"
"$out/test_form"

cc -std=c11 -Wall -Wextra -Werror -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
   -o "$out/test_draft" "$here/test_draft.c" "$here/../main/ui/habitat/draft.c"
"$out/test_draft"

python3 "$here/test_search_ui.py"
python3 "$here/test_draft_ui.py"
python3 "$here/test_question_ui.py"
python3 "$here/test_voice_ui.py"
python3 "$here/test_touch_ui.py"
python3 "$here/test_brightness_ui.py"
# The preferences the desktop app now owns, driven through the device's own read/apply/worker path.
python3 "$here/test_device_settings.py"
python3 "$here/test_touch_driver.py"
python3 "$here/test_render_guard.py"
python3 "$here/test_display_power.py"
python3 "$here/test_machine_ui.py"
python3 "$here/test_reload_threads.py"
python3 "$here/test_agent_snapshot.py"
python3 "$here/test_cable_session.py"
python3 "$here/test_cable_idle.py"
python3 "$here/test_fw_update.py"
python3 "$here/test_cable_logging.py"
python3 "$here/test_audio_notify.py"
python3 "$here/test_audio_init.py"
python3 "$here/test_audio_stream.py"
python3 "$here/test_audio_threads.py"

# These exercise the exact cJSON version linked into the board, when its SDK is
# available. The rest of the suite remains independent of ESP-IDF.
if [[ -n "${IDF_PATH:-}" ]]; then
    python3 "$here/test_cable_crc.py"
    cc -std=c11 -Wall -Wextra -Werror -Wno-deprecated-declarations -O1 -g -fsanitize="${SANITIZERS:-undefined,bounds}" \
        -I "$here/../main" -I "$IDF_PATH/components/json/cJSON" \
        -o "$out/test_cable_features" "$here/test_cable_features.c" \
        "$here/../main/cable_features.c" "$IDF_PATH/components/json/cJSON/cJSON.c"
    "$out/test_cable_features"
    cc -std=c11 -Wall -Wextra -Werror -Wno-deprecated-declarations -O1 -g -pthread -fsanitize="${SANITIZERS:-undefined,bounds}" \
        -I "$here/../main" -I "$IDF_PATH/components/json/cJSON" \
        -o "$out/test_cable_scroll" "$here/test_cable_scroll.c" \
        "$here/../main/cable_scroll.c" "$IDF_PATH/components/json/cJSON/cJSON.c"
    "$out/test_cable_scroll"
    python3 "$here/test_cable_json_parse.py"
    python3 "$here/test_companion_protocol.py"
    python3 "$here/test_cable_identity.py"
    python3 "$here/test_cable_models.py"
    python3 "$here/test_cable_outbound.py"
fi

python3 "$here/test_companions.py"
