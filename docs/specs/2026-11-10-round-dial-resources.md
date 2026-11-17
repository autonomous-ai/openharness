# Round dial: give back flash, PSRAM and internal RAM it holds for nothing (Diego, 2026-11-10)

## Why

The round dial (`devices/harness-device/firmware`, ESP32-S3) copies its whole image into PSRAM at boot, so every
flash byte is also a PSRAM byte. Internal RAM is the scarce pool: about 127.5 KB free, largest block 43,008 B.
The audit of main `c1a711d1a` (`docs/plans/2026-11-10-round-dial-resources-audit.md`, findings #1-#15) found:
- about 700 KB of image that buys nothing;
- about 65 KB of internal RAM that could come back;
- a stack telemetry list that names a task which no longer exists;
- skins and companions that no shipped dial can show, with an `-DDEVICE_ALL_SKINS=1` image that no longer even
  boots.

Diego asked for all of it (2026-11-10, "full").

## Goal

Take all of it back. Focus becomes the dial's only mode, as it already is on every shipped dial. The one visible
change: Latin Extended-A letters outside Vietnamese now draw as their base letter (ś as s), where today the face
draws the letter itself.

## In scope

Audit numbers in brackets.

**Telemetry first**
1. **Stack telemetry names the real tasks [#11].** `ram_telemetry_periodic` logs every task the firmware creates:
   `proj_refresh`, `ptt`, `beep`, `cable_link`, `cable_session`, `habitat_actions`, `habitat_touch`,
   `habitat_render`, `voice_capture`, `voice_send`. `commander_ws` goes.

**Flash and PSRAM**

2. **Focus is the dial's only mode [#1, #7] (Diego, 2026-11-10: "the device uses only Focus"; companions "no
   longer used").** Everything that draws or selects another character goes:
   - **ASCII Tim and the octopus:** `tim.c/h`, `octopus.c/h`, `octopus_font.c`, `octopus_art.inc`,
     `gen_octopus.py`.
   - **Tux:** `tux.c/h`, `tux_moods.inc`, `gen_tux_moods.py`, `import_tux_moods.mjs`.
   - **The illustrated companions:** `illustrated.c/h`, `illustrated_cache.c`, `assets/companions/` (4.6 MB
     pack), `gen_companion_art.py`.
   - **Follow the desktop companion:** the setting bit, the `companion*` fields of the settings frame, the
     `companion` frames, the celebration.
   - **The creature gallery:** `creature_gallery.c/h`, `creature_font.c`, `creature_art.inc`,
     `creature_clips.inc`, `gen_creature_*.py`.
   - **The octopus bench:** `perf_bench.c/h`, `DEVICE_OCTOPUS_BENCH`, `analyze_octopus_perf.py`.
   - **Character fonts:** `character_fonts.inc` and `gen_character_fonts.py`, if only those characters use them.
   - **Build options:** `DEVICE_ALL_SKINS`, `DEVICE_DEFAULT_CHARACTER`, `HABITAT_FOCUS_ONLY`,
     `HABITAT_NO_COMPANION_ART`. Their tests, test references and docs go too.

   What stays:
   - Focus and what it uses: `focus.c/h`, `focus_faces.c`, `focus_marks.c`, pets, `character_layout`,
     `character_types`, `character_motion`.
   - A one-row `character.c` registry, if keeping the `ht_character_*` calls is simpler than inlining Focus.

   What a dial and the host see:
   - **A saved skin:** a dial whose NVS holds a skin or companion id from before shows Focus.
   - **The setting:** the skin setting reads Focus.
   - **Settings frame:** it no longer carries `companionProtocol`, `followCompanion`, `companion` or
     `companionDetails`. The daemon reads all of them as optional (`cli/src/cable/cableSession.ts`).
   - **Companion frames:** a `companion` frame from the host is ignored, like any unknown message.
   - **Desktop:** it already hides the companion feature (`kDeviceCompanionSkins = false`).

   **Follow-up, not here:** the host side (`companionProtocol.ts`, the companion fields in `cableSession.ts`,
   `kDeviceCompanionSkins`, any skin picker).
3. **newlib nano printf [#4, 31,403 B].** `CONFIG_LIBC_NEWLIB_NANO_FORMAT=y`, after the two `%llu` in
   `ram_telemetry.c` become `%u`. No firmware format string uses a conversion nano lacks.
4. **No duplicated generated data [#5, ~110 KB].**
   - `pets.c`: each distinct array once (61,762 B today).
   - `focus_marks.c`: no 56 px marks for Claude, Codex and Muse, which always show their built-in pet (28,224 B),
     and each distinct array once (6,272 B).
   - `focus_faces.c`:
     - the seven Inter faces share one copy of their identical `codes`/`kl`/`kr` tables (10,152 B);
     - the 7-glyph wordmark face carries a kerning table for its 7 glyphs, not 103×101 (10,403 B).
   - All of this through the generators. `gen_pets.py --check` stays green, and a regeneration of `focus_faces.c`
     before any change reproduces today's file exactly.
5. **Latin Extended-A cut to what Vietnamese needs [#6, ~189 KB].**
   - The Inter faces keep U+0102, U+0103, U+0110, U+0111, U+0128, U+0129, U+0168 and U+0169 from U+0100-U+017F,
     and drop the other 120 letters.
   - On the Inter path a letter a face lacks draws its base letter from the existing `display_fallbacks.inc`
     table (ś as s) before falling back to `?`. That is what the monospace path already does.
6. **`MINIMAL_BUILD` [#10, 14,148 B flash, 416 B RAM].** Logs and a panic's report still reach the host over
   the cable.

**Internal RAM**

7. **Kernel, heap and ringbuffer code out of IRAM [#2, +25,532 B].**
   - `CONFIG_FREERTOS_PLACE_FUNCTIONS_INTO_FLASH`, `CONFIG_HEAP_PLACE_FUNCTION_INTO_FLASH` and
     `CONFIG_RINGBUF_PLACE_FUNCTIONS_INTO_FLASH`.
   - These are kept only if the dial's `frame_max_us` stays within 10% of the old firmware's, in an A/B on one
     dial.
8. **Smaller stacks where the dial's own telemetry shows the need [#3, #12].**
   - `habitat_render`: 24,576 → 12,288 B (peak 5,596 B). The extra was for the ROM inflater, which only the deleted
     companion pack used.
   - `proj_refresh`: 7,168 → 4,096 B (peak 2,248 B).
   - `voice_capture`: 5,120 → 4,096 B (peak 2,576 B).
   - `voice_send`: 5,120 → 4,096 B (peak 2,404 B).
   - Every new size is at least 1.5× its peak. The other stacks keep their sizes.
9. **Rare-path buffers in PSRAM [#9, ~11.9 KB].** `last_words.c` `s_previous`, `pet_store.c` `s_scratch` and
   `cable_client.c` `s_agents`. `cable_link.c` `s_tx_frame` stays.
10. **cJSON allocates from PSRAM [#8, up to ~37 KB peak].**
    - `app_main` calls `ram_telemetry_init()` first, as its header says.
    - It is kept only if, in an A/B on one dial, `int_min` is higher and `frame_max_us` stays within 10%.
    - Otherwise `ram_telemetry_init`, the unused `ram_psram_*` helpers and the always-`0/0B` `json_fb` field are
      deleted instead.

**Config**

11. **Network leftovers removed [#13, 0 B].**
    - The eight network components leave `BOARD_REQUIRES`.
    - `espressif/esp_websocket_client` leaves `idf_component.yml` and `dependencies.lock`.
    - The Wi-Fi, HTTP, TLS, LWIP and WebSocket `sdkconfig.defaults*` values go.
    - `mbedtls` (SHA-256 in `fw_update.c`), `app_update`, `esp_partition` and app rollback stay.

## Decided, no change

- **Partitions [#14].** The default table stays: changing it needs a USB reflash of every shipped dial, and
  nothing needs the space.
- **PSRAM statics [#15].** 4.5 MB of PSRAM is free and nothing is short. `ui_habitat.c` `s`, the voice ring and
  `swarm` stay.

## Out of scope

The host, the Pro (`devices/harness-pro`).

## Done when

**Image**
- The default image is at least 600 KB smaller, and IRAM/DRAM are no larger.
- `nm` shows no `ht_tux_`, `ht_illustrated_`, `ht_octopus_` or `ht_tim_` symbols.
- `-DBOARD_PROBE=1` and the remaining bench / render-fault builds still build.
- `git grep -i "illustrated\|companion_art\|followCompanion\|companionProtocol\|DEVICE_ALL_SKINS\|octopus\|tux"`
  finds nothing under `devices/harness-device/firmware/main` (outside generated pet data, if a pet is named so).

**Internal RAM**
- At least 40 KB more free at boot, by the dial's own `RAM tag=` line. Items 7 and 10 count only if their A/B
  keeps them.

**Tests**
- `make device-test` and every `firmware/test/test_*.py` pass, as CI runs them.
- New tests pin:
  - the telemetry task list;
  - Focus as the only character, and a saved old skin falling back to it;
  - no unsupported `%` conversions;
  - no duplicate arrays in `pets.c` / `focus_marks.c` / `focus_faces.c`;
  - the kept Vietnamese letters;
  - the Inter base-letter fallback;

**On a dial** (USB flash, `-DPROJECT_VER=0.1.0-dev`)
- **A/B:** 20 minutes on the baseline firmware, then 20 minutes on the new one, same use. Record `frame_max_us`,
  `int_free`, `int_min` and `int_largest` from the `alive` and `RAM tag=` lines, and decide items 7 and 10 by
  their rules.
- **30 minutes of normal use** on the final firmware:
  - the Focus face, pets, alerts, a voice message and text with Vietnamese and other accented
    letters look and work as before;
  - no reboot, watchdog or `stack overflow`;
  - every task in the new telemetry keeps at least 1 KB of stack free.
- **Logs and panics:** a `MINIMAL_BUILD` image with `-DDEVICE_RENDER_FAULT=1` shows its logs and its fault
  report in the daemon log.

## Design

- **Growth, read cost, scale:** none; fewer bytes everywhere.
- **Compatibility:**
  - The cable protocol is unchanged except that the dial no longer sends or reads the optional companion fields.
    The daemon already treats them as optional. The skin setting always reads Focus.
  - Only text with Latin Extended-A letters outside Vietnamese changes on screen (base letter instead of the
    letter).
- **Platforms:** the round dial only.
- **Failure:**
  - A wrong cut shows up as a build error, a failing test, a size or symbol change, or on the dial as a stack
    warning, reboot, missing art or a `?`.
  - The telemetry lands first so the stack and RAM changes can be judged.
  - Items 7 and 10 have explicit keep-or-revert rules.
