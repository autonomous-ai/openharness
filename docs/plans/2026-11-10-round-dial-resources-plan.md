# Round dial resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Focus the round dial's only mode (deleting Tim, Tux, the companions and their 4.6 MB pack, and the creature gallery), give back about 700 KB of image/PSRAM and up to about 65 KB of internal RAM, and change nothing visible except Latin Extended-A letters outside Vietnamese drawing as their base letter.

**Architecture:**
- Branch `chore/round-dial-resources` (worktree `.claude/worktrees/dialres`). One commit per task, each pinned by a host test where one can express it and proved by `idf.py size` / `nm` against a baseline.
- Items that can only be judged on hardware (IRAM-to-flash, cJSON in PSRAM) land behind a keep-or-revert rule settled in the dial A/B of Task 13.
- Audit, with all numbers and file:line at `c1a711d1a` (re-find lines by text): `docs/plans/2026-11-10-round-dial-resources-audit.md`.

**Tech Stack:** ESP-IDF 5.5.4 (ESP32-S3), C11, CMake, Python 3 generators (Pillow, fontTools) and host tests, `npx lv_font_conv@1.5.2`.

**Spec:** `docs/specs/2026-11-10-round-dial-resources.md`

## Global Constraints

- **Scope:** firmware root `devices/harness-device/firmware/` (`FW/`). Never touch `devices/harness-pro`, `cli/`, `desktop/`, `backend/`.
- **Toolchain** (in a subshell):
  `. ~/esp/esp-idf-5.5.4/export.sh; export PATH=~/.espressif/tools/xtensa-esp-elf/esp-14.2.0_20260121/xtensa-esp-elf/bin:$PATH; export IDF_PATH=~/esp/esp-idf-5.5.4`
  - The IDF venv's `python3` has no Pillow, so host tests and generators run with the system `python3`.
  - Builds go in `/tmp/dialres-build/<name>` with `-DSDKCONFIG=/tmp/dialres-build/<name>.sdkconfig`, never in `FW/build`.
- **Host tests:**
  - `env -u IDF_PATH make device-test`, plus every `FW/test/test_*.py` run as `IDF_PATH=~/esp/esp-idf-5.5.4 python3 <file>`.
  - `test_cable_models.py` fails on macOS on main (clang `snprintf` macro redefinition), so it counts as "same as baseline".
  - New tests are plain `assert` scripts like the existing `test_*.py`; CI runs them by glob.
- **Focus is the only mode** (Diego, 2026-11-10). Task 3 deletes every other character, the companions, the creature gallery and the `DEVICE_ALL_SKINS` / `DEVICE_DEFAULT_CHARACTER` options. Later tasks build `default` and `probe` only.
- **Stacks:** new sizes are ≥ 1.5× the measured peak. `ptt`, `beep`, main, `cable_link`, `cable_session`, `habitat_actions` and `habitat_touch` keep their sizes.
- **Vietnamese** keeps U+0102 U+0103 U+0110 U+0111 U+0128 U+0129 U+0168 U+0169 from U+0100-U+017F, and every U+1EA0-U+1EF9 letter it has today.
- **The default `partitions.csv` does not change.**
- **Host side of the companion feature** (`cli/src/cable/companionProtocol.ts`, `cableSession.ts` companion fields, `desktop` `kDeviceCompanionSkins`): not touched. It is a follow-up; the daemon already treats the fields as optional.
- **No flash before Task 13, no push.**
- **`samples/hackathon-fo/01-fo-glance/solution.patch`** may be regenerated in Task 3 so it still applies; nothing else outside `FW/` and `devices/harness-device/prototype/` changes.

## Review Focus

- **A dial that saved Tux, Tim or a companion before** boots the new image. Expected: it draws Focus (Task 3 test). A host that still sends `companion` frames gets them ignored, with no crash (Task 3).
- **A format nano cannot print** (`%ll*`, `%j`, `%z`, `%t`, `%L`, `%a`). Expected: none in `FW/main`, and `_printf_float` is still linked for cJSON (Task 4).
- **An array merged into another** but drawn with a different palette, size or element type. Expected: merged arrays are identical in type and body, and the existing pet, mark and face render tests still pass (Tasks 5-6).
- **A word with a cut letter next to a kept one** (e.g. "Łódź Hà Nội"). Expected: base letters for the cut ones, the real glyphs for the kept ones, and no `?` (Task 7 test).
- **A task near its new stack size** on a path the telemetry has not covered: a long voice message, a long Swarm list. Expected: each keeps ≥ 1 KB free over the Task 13 runs.

---

### Task 1: Baseline

**Files:** none. Writes `/tmp/dialres-build/baseline.txt`.

- [ ] **Step 1: Build.** Build `default`, `probe` (`-DBOARD_PROBE=1`), `fault` (`-DDEVICE_RENDER_FAULT=1`) and `layout` (`-DDEVICE_LAYOUT_BENCH=1`), and run `idf.py size` on each.
  - Expected: all three build; the default total is about 3,369,871 B.
- [ ] **Step 2: Symbols.** Save the `xtensa-esp32s3-elf-nm` names of each ELF to `/tmp/dialres-build/names-<name>.txt`.
- [ ] **Step 3: Tests.**
  - Run the host tests and `python3 FW/scripts/gen_pets.py --check`.
  - Run `python3 FW/scripts/gen_focus_faces.py` into a copy of the tree under `/tmp/dialres-faces/` and diff the output with `FW/main/ui/habitat/focus_faces.c`.
  - Expected: the tests pass (except the known one), and the diff is empty.
  - If the diff is not empty, Task 6's and Task 7's generator path is not reproducible. Ledger it, and do Tasks 6-7 as generator edits plus a regeneration whose only diff is the intended one.
- [ ] **Step 4: Baseline A for the dial A/B.** The dial `…63:E8` already runs main's build (flashed 2026-11-10 10:48).
  - Save its `alive` and `RAM tag=` lines from the last 20 minutes of `~/.harness/logs/usb-*/dial-$(date +%Y%m%d).log`, while Diego uses it normally, to `/tmp/dialres-build/ab-baseline.log`.
  - If the dial has not been used in that window, ask Diego for 20 minutes of normal use now.

### Task 2: Stack telemetry names the real tasks (#11)

**Files:** Modify `FW/main/ram_telemetry.c` (`tasks[]` in `ram_telemetry_periodic`). Create `FW/test/test_ram_telemetry_tasks.py`.

- [ ] **Step 1: Failing test** `test_ram_telemetry_tasks.py`.
  - Collect every task name created under `FW/main`: the string literal that is the second argument of `xTaskCreate(` / `xTaskCreatePinnedToCore(`.
  - Read the string literals of `tasks[]` in `ram_telemetry_periodic`.
  - `assert set(tasks) == created` and `assert "commander_ws" not in tasks`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Fix the list.** `tasks[]` = `proj_refresh, ptt, beep, cable_link, cable_session, habitat_actions, habitat_touch, habitat_render, voice_capture, voice_send`.
- [ ] **Step 4: Verify.** Test PASS, host tests, `default` build.
- [ ] **Step 5: Commit** `round dial: stack telemetry lists the tasks the firmware runs`.

### Task 3: Focus is the dial's only mode (#1, #7)

**Files:**
- Delete (and `git grep` each name first; anything still referenced from what stays is a ruling, not a deletion):
  - `FW/main/ui/habitat/`: `tim.c/h`, `octopus.c/h`, `octopus_font.c`, `octopus_art.inc`, `tux.c/h`, `tux_moods.inc`, `illustrated.c/h`, `illustrated_cache.c`, `creature_gallery.c/h`, `creature_font.c`, `creature_art.inc`, `creature_clips.inc`, `perf_bench.c/h`, and `character_fonts.inc` if only these characters use it.
  - `FW/assets/companions/`.
  - `FW/scripts/`: `gen_octopus.py`, `gen_tux_moods.py`, `import_tux_moods.mjs`, `gen_companion_art.py`, `gen_creature_art.py`, `gen_creature_clips.py`, `gen_creature_font.py`, `analyze_octopus_perf.py`, and `gen_character_fonts.py` with `character_fonts.inc`.
  - Their tests and references: `test_companions.c/.py`, `test_companion_protocol.py`, `test_creature_gallery.c`, `test_octopus_art.py`, `test/reference48/octopus*`, and every other test whose only subject is a deleted character.
  - `devices/harness-device/prototype/habitat/` inputs used only by the deleted generators (`assets/tux/`, `assets/creature-references/`), and `CREATURE_GALLERY*.md`, `CREATURE_REFERENCES.md`, `TUX.md`.
- Modify:
  - `character.h` / `character.c`:
    - The registry holds Focus only; `HT_CHARACTER_COUNT` is 1.
    - Delete `ht_character_species`, `ht_character_companion`, `species[]`, `companion_style`, `ht_character_default`'s Tim/Tux branches, and the illustrated tick path.
    - Any id read from NVS means Focus.
  - `ui_habitat.c`:
    - Delete `desktop_companion`, `follow_companion`, `companion_celebrating`, `desktop_identity`, `celebration_identity`, `select_companion`, the skin/character choice, the `HABITAT_FOCUS_ONLY` blocks (their Focus side stays, unconditionally) and every `DEVICE_CREATURE_GALLERY` hook.
    - The skin setting always reports Focus.
  - `ui_screens.h`: delete `ui_companion_t`, `follow_companion`, `companion`, `companion_details`, `UI_SETTING_FOLLOW_COMPANION`, `ui_set_companion*` and `ui_companion_celebrate`.
  - `cable_client.c`:
    - Delete `companion_json`, `companion_parse`, the `followCompanion` / `companion` / `companionProtocol` / `companionDetails` fields, and the `companion` / celebration message cases.
    - Those messages now fall through to the unknown-message path.
  - `config_store.h`: bit 4 becomes "reserved (was: do not follow the desktop companion)". Do not reuse it.
  - `display_habitat.c`: delete `ht_illustrated_prepare` / `init` and the `DEVICE_OCTOPUS_BENCH` hooks.
  - `character_motion.c`, `audio_capture.c`: delete the octopus-bench and gallery hooks.
  - `main/CMakeLists.txt`:
    - Delete the files' entries, the `DEVICE_ALL_SKINS` / `COMPANION_ART` / `EMBED_FILES` / `HABITAT_FOCUS_ONLY` / `HABITAT_NO_COMPANION_ART` / `DEVICE_DEFAULT_CHARACTER` / `DEVICE_OCTOPUS_BENCH` / `DEVICE_CREATURE_GALLERY` blocks, and those names in the other benches' guards.
    - The layout and transport benches, render fault/stress, `DEVICE_HABITAT_ORANGE` and `BOARD_PROBE` stay.
  - `test/run.sh` and the mixed tests (`test_character.c`, `test_character_preferences.py`, `test_device_settings.py`, `test_touch_ui.py`, `test_voice_ui.py`, `test_touch_driver.py`, `test_layout_bench.py`, …): remove only the cases about deleted characters, companions or the gallery. Every Focus case stays. `test_touch_driver.py`, which builds the touch task against the gallery, is retargeted to Focus.
  - Docs: `FW/README.md`, `FW/scripts/flash-station.sh` and `prototype/habitat/README.md`: only the lines that name the deleted things.
  - `samples/hackathon-fo/01-fo-glance/solution.patch`: if `git apply --check` stops applying because its CMake context named the deleted blocks, regenerate the patch so it applies, with the same changes. Ledger it.
- Create: `FW/test/test_focus_only.py`.

**Interfaces:**
- Produces: `HT_CHARACTER_FOCUS` is the only `ht_character_id_t` (value 0). `ht_character_select(c, any)` selects Focus.

- [ ] **Step 1: Failing test** `test_focus_only.py`.
  - `git grep -i -e illustrated -e companion_art -e followCompanion -e companionProtocol -e companionDetails -e DEVICE_ALL_SKINS -e HABITAT_FOCUS_ONLY -e ht_tux_ -e ht_octopus_ -e ht_tim_ -e creature_gallery -- FW/main FW/CMakeLists.txt` finds nothing.
  - `HT_CHARACTER_COUNT == 1`.
  - A slice of `character.c` compiled with an NVS value of 7 (an old companion id), following the `test_character_preferences.py` pattern, selects Focus.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Delete and edit** as listed, rebuilding and testing as you go.
- [ ] **Step 4: Verify.**
  - Test PASS, `env -u IDF_PATH make device-test`, and every `test_*.py`.
  - The commit message lists the test files and cases removed. Every one of them is about a deleted character.
  - `git apply --check samples/hackathon-fo/01-fo-glance/solution.patch` applies.
- [ ] **Step 5: Measure.**
  - `default`: total down by ≈ 270 KB.
  - `nm` has no `ht_tux_` / `ht_illustrated_` / `ht_octopus_` / `ht_tim_`.
  - `probe`, `fault` (`-DDEVICE_RENDER_FAULT=1`) and `layout` (`-DDEVICE_LAYOUT_BENCH=1`) build.
- [ ] **Step 6: Commit** `round dial: Focus is the only mode; delete Tim, Tux, the companions and the creature gallery`.

### Task 4: newlib nano printf (#4)

**Files:** Modify `FW/main/ram_telemetry.c` (the two `%llu` become `%u`, with arguments cast to `unsigned`) and `FW/sdkconfig.defaults` (`CONFIG_LIBC_NEWLIB_NANO_FORMAT=y`, with a one-line reason). Create `FW/test/test_nano_formats.py`.

- [ ] **Step 1: Failing test** `test_nano_formats.py`.
  - Assert that no string literal in `FW/main/**/*.{c,h}` has a `%` conversion with length `ll`, `j`, `z`, `t` or `L`, or conversion `a`.
  - Assert that `FW/sdkconfig.defaults` sets `CONFIG_LIBC_NEWLIB_NANO_FORMAT=y`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Edit** both files.
- [ ] **Step 4: Verify.** Test PASS, host tests.
- [ ] **Step 5: Measure.** `default`: Flash Code down by ≈ 31 KB, and `nm` still has `_printf_float`.
- [ ] **Step 6: Commit** `round dial: newlib nano printf`.

### Task 5: Pets and marks carry each array once (#5, part 1)

**Files:** Modify `FW/scripts/gen_pets.py` and `FW/scripts/gen_focus_marks.py`, then regenerate `pets.c` and `focus_marks.c`. Create `FW/test/test_generated_unique.py`.

**Interfaces:**
- Produces: `unique_arrays(path) -> None`, a helper in `test_generated_unique.py` that asserts no two `static const <type> <name>[…] = {…};` arrays of one element type have identical bodies. Task 6 extends the test to `focus_faces.c`.

- [ ] **Step 1: Failing test.**
  - `unique_arrays` holds for `pets.c` and `focus_marks.c`.
  - The `ht_icon_engine56` entries at ENGINES indices 0, 1 and 11 (claude, codex, muse) are `{0,0,NULL,NULL}`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: `gen_pets.py`.**
  - Map (element type, body) to the first array name. Emit a repeated body once, and point later references at the first name.
  - Regenerate, then run `--check`. Expected: PASS.
- [ ] **Step 4: `gen_focus_marks.py`.**
  - claude, codex and muse emit `{0,0,NULL,NULL}`, with a comment that they always show their built-in pet (`focus.c` `pet_for`).
  - Dedupe as in Step 3, then regenerate.
- [ ] **Step 5: Verify.** Test PASS, host tests (pet and focus render tests included).
- [ ] **Step 6: Measure.** `default` total down by a further ≈ 90 KB.
- [ ] **Step 7: Commit** `round dial: generated pets and marks carry each array once`.

### Task 6: Inter faces share their tables; the wordmark's kerning fits it (#5, part 2)

**Files:** Modify `FW/scripts/gen_focus_faces.py` (and `gen_lvgl_assets.py` `emit_font` only if the sharing must happen there), then regenerate `focus_faces.c`. Extend `FW/test/test_generated_unique.py`.

- [ ] **Step 1: Failing test.**
  - `unique_arrays("focus_faces.c")`.
  - The wordmark face, the 7-glyph face the audit names at `focus_faces.c:27783`, has kerning tables sized for its own glyph count.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Share identical tables.** When two faces' `codes` / `kl` / `kr` (or any) tables are identical, emit one, named for the first face, and point the others' `ht_pfont_t` at it.
- [ ] **Step 4: Cut the wordmark's kerning.** Limit its kerning classes and table to the classes its 7 glyphs use, and remap the class indices so that every glyph pair still kerns by the same amount.
- [ ] **Step 5: Regenerate** `focus_faces.c`.
- [ ] **Step 6: Verify.**
  - Test PASS.
  - Host tests, including `test_touch_ui.py` and the text render tests, which draw these faces.
  - A new check in the same test: for every pair of the wordmark's 7 glyphs, `pkern` gives the same value before and after. Compute "before" from the Task 1 copy.
- [ ] **Step 7: Measure.** `default` total down by ≈ 20 KB.
- [ ] **Step 8: Commit** `round dial: Inter faces share their tables; the wordmark kerns only its own letters`.

### Task 7: Latin Extended-A cut to Vietnamese, with base-letter fallback on the Inter path (#6)

**Files:**
- Modify `FW/scripts/gen_focus_faces.py`: `KEEP` = `base.TEXT` minus U+0100-U+017F, plus the eight Vietnamese letters. Then regenerate `focus_faces.c`.
- Modify `FW/main/ui/habitat/terminal.c` `plookup`: after `fallback`, before `?`, look up `display_fallback(cp, scratch)`'s single ASCII letter in the face.
- Create `FW/test/test_inter_fallback.py`.

- [ ] **Step 1: Failing test** `test_inter_fallback.py`.
  - Compile `terminal.c` + `focus_faces.c` + `fonts.c` as `run.sh` does for `test_terminal`.
  - Render "ś" and "s" with `ht_lv_inter_20` and assert identical pixels.
  - Render "ă" and "a" and assert they differ (ă keeps its own glyph).
  - Assert that `pindex(ht_lv_inter_20, 0x15B)` is -1, and that the index of 0x103 is ≥ 0.
- [ ] **Step 2: Run it.** Expected: FAIL (ś is in the face today, and there is no fallback).
- [ ] **Step 3: Implement.** Edit `KEEP`, regenerate, and add the fallback to `plookup`. Keep `pglyph_t` semantics: the fallback glyph comes from the same face.
- [ ] **Step 4: Verify.** Test PASS, host tests, and the `gen_focus_faces.py` self-check ("every TEXT codepoint the font has").
- [ ] **Step 5: Measure.** `default` total down by ≈ 189 KB.
- [ ] **Step 6: Commit** `round dial: Inter faces carry Vietnamese's Latin Extended-A letters only; others draw their base letter`.

### Task 8: Smaller stacks where telemetry shows the need (#3, #12)

**Files:** Modify `FW/main/ui/habitat/display_habitat.c` (`habitat_render`), `FW/main/app_main.c` (`proj_refresh`) and `FW/main/audio_client_habitat.c` (`voice_capture`, `voice_send`).

- [ ] **Step 1: Render stack.**
  - `habitat_render` takes 12288.
  - Update the comment: the old 24 KB was for the ROM inflater, which only the deleted companion pack used.
- [ ] **Step 2: Other stacks.**
  - `proj_refresh` 4096, `voice_capture` 4096, `voice_send` 4096.
  - Each gets a comment naming its measured peak (2,248 / 2,576 / 2,404 B, from the dials' `STACK` and `alive` lines, fw ≥ 0.0.94).
- [ ] **Step 3: Verify.** Host tests, and the `default` build.
- [ ] **Step 4: Commit** `round dial: render, refresh and voice stacks sized from their measured peaks`.

### Task 9: Rare-path buffers to PSRAM; network leftovers out (#9, #13)

**Files:**
- Buffers:
  - `FW/main/last_words.c` (`s_previous` → `EXT_RAM_BSS_ATTR`)
  - `FW/main/pet_store.c` (`s_scratch` → `EXT_RAM_BSS_ATTR`)
  - `FW/main/cable_client.c` (`s_agents` from `heap_caps_calloc(…, MALLOC_CAP_SPIRAM)`, falling back to `calloc`)
- Network:
  - `FW/main/CMakeLists.txt` `BOARD_REQUIRES`: drop `esp_wifi`, `esp_netif`, `esp_event`, `esp_http_server`, `esp_http_client`, `esp_https_ota`, `esp_websocket_client` and `esp-tls`.
  - `FW/main/idf_component.yml`: drop `espressif/esp_websocket_client`.
  - `FW/dependencies.lock`: regenerate it with `idf.py reconfigure`.
  - `FW/sdkconfig.defaults*`: drop the Wi-Fi, HTTP(S)-OTA, TLS-bundle, LWIP and WebSocket keys.

- [ ] **Step 1: Safety check.** `git grep` that none of the three buffers is touched from an ISR or an `IRAM_ATTR` function. If one is, keep it and ledger a ruling.
- [ ] **Step 2: Move the buffers.** Edit the three files and run the host tests.
- [ ] **Step 3: Remove the network leftovers.** Make the edits and run `idf.py reconfigure`.
  - Expected: `dependencies.lock` loses only `esp_websocket_client`.
- [ ] **Step 4: Measure.** Build `default` and `probe`.
  - All build.
  - DIRAM `.bss` is down by ≈ 8.2 KB.
  - The network edits change no section size and no symbol, compared with a build of this tree before Step 3.
- [ ] **Step 5: Commit** `round dial: rare-path buffers in PSRAM; drop the network components nothing links`.

### Task 10: cJSON allocates from PSRAM (#8), pending the A/B

**Files:** Modify `FW/main/app_main.c` (call `ram_telemetry_init()` first in `app_main`, before any cJSON use). Create `FW/test/test_ram_telemetry_init.py`.

- [ ] **Step 1: Failing test.** `app_main`'s body calls `ram_telemetry_init();` before the first other call.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Add the call.**
- [ ] **Step 4: Verify.** Test PASS and host tests; `default` builds.
- [ ] **Step 5: Commit** `round dial: cJSON allocates from PSRAM, as ram_telemetry.h says (pending dial A/B)`.

### Task 11: Kernel, heap and ringbuffer code out of IRAM (#2), pending the A/B

**Files:** Modify `FW/sdkconfig.defaults.esp32s3`: add `CONFIG_FREERTOS_PLACE_FUNCTIONS_INTO_FLASH=y`, `CONFIG_HEAP_PLACE_FUNCTION_INTO_FLASH=y` and `CONFIG_RINGBUF_PLACE_FUNCTIONS_INTO_FLASH=y`, with the reason: code runs from PSRAM, and the cache is never disabled (`SPI_FLASH_CACHE_NO_DISABLE`).

- [ ] **Step 1: Edit** the file.
- [ ] **Step 2: Measure.** `default`: IRAM `.text` drops from ≈ 64.6 KB to ≈ 40.0 KB, and the host tests pass.
- [ ] **Step 3: Commit** `round dial: kernel, heap and ringbuffer code out of IRAM (pending dial A/B)`.

### Task 12: `MINIMAL_BUILD` (#10)

**Files:** Modify `FW/CMakeLists.txt` (`set(MINIMAL_BUILD ON)` before `project()`, with the reason). Add components back to `BOARD_REQUIRES` only if the build demands them.

- [ ] **Step 1: Build.** Build `default` and `probe` (`probe` must build).
  - Expected: Flash ≈ 14 KB smaller.
  - Any missing component the build names goes back into `BOARD_REQUIRES`, ledgered.
- [ ] **Step 2: Fault build.** Build `fault` (`-DDEVICE_RENDER_FAULT=1`). It is used in Task 13 to prove that logs and a fault report still reach the cable.
- [ ] **Step 3: Commit** `round dial: minimal build`.

### Task 13: Proof on a dial, and the two A/B decisions

**Files:** none, except reverting Task 10 and/or Task 11 if their rule fails. A revert counts as a Task 13 commit.

- [ ] **Step 1: Flash.** Build `default` with `-DPROJECT_VER=0.1.0-dev`. Flash it with the repo procedure:
  1. Quit Harness.
  2. `date +%s > ~/.harness/flasher/flashing`.
  3. `harness stop`.
  4. `python -m esptool chip_id`: it must say ESP32-S3.
  5. `idf.py -p <port> flash`.
  6. Remove the flag.
  7. `harness start`.
  8. Open Harness.

  Then the daemon log says `on fw 0.1.0-dev`, and no `offering firmware` follows.
- [ ] **Step 2: A/B (B side).** Ask Diego for 20 minutes of normal use. Save the `alive` and `RAM tag=` lines to `/tmp/dialres-build/ab-new.log`, then compare with `ab-baseline.log`.
  - Keep Tasks 10 and 11 if `frame_max_us` (p95 and max) is within 10% and `int_min` is higher.
  - Otherwise rebuild without Task 11, repeat 20 minutes, and keep whichever of Tasks 10/11 passes. Revert the one that fails.
  - If Task 10 is reverted, also delete `ram_telemetry_init`, the `ram_psram_*` helpers and the `json_fb` field.
- [ ] **Step 3: Normal use.** Ask Diego for 30 minutes on the final firmware:
  - the Focus face, a pet alert, a voice message, the Swarm screens;
  - a message with "Hà Nội, Łódź, Kraków" so Vietnamese and other accented letters are on screen.

  Expected:
  - no reboot, watchdog or `stack overflow` in the dial log;
  - every task in the `STACK` lines keeps ≥ 1 KB free;
  - `int_free` at boot is ≥ 40 KB above the baseline (≥ 15 KB if both A/B items were reverted).
- [ ] **Step 4: Fault build.** Flash the `fault` image.
  - Expected: the daemon log shows the dial's logs, and after the induced fault its report (last words / backtrace).
  - Then flash the final image back.
