# Round dial resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give back about 700 KB of image/PSRAM and up to about 65 KB of internal RAM on the round dial, and make the all-skins image boot again, with no visible change except Latin Extended-A letters outside Vietnamese drawing as their base letter.

**Architecture:**
- Branch `chore/round-dial-resources` (worktree `.claude/worktrees/dialres`). One commit per task, each pinned by a host test where one can express it and proved by `idf.py size` / `nm` against a baseline.
- Items that can only be judged on hardware (IRAM-to-flash, cJSON in PSRAM) land behind a keep-or-revert rule settled in the dial A/B of Task 14.
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
- **`-DDEVICE_ALL_SKINS=1`:** behaviour is identical except for its storage (Task 13). Gates are `#ifdef HABITAT_FOCUS_ONLY` / `HABITAT_NO_COMPANION_ART` / `if(NOT DEVICE_ALL_SKINS)`.
- **Stacks:** new sizes are ≥ 1.5× the measured peak. `ptt`, `beep`, main, `cable_link`, `cable_session`, `habitat_actions` and `habitat_touch` keep their sizes.
- **Vietnamese** keeps U+0102 U+0103 U+0110 U+0111 U+0128 U+0129 U+0168 U+0169 from U+0100-U+017F, and every U+1EA0-U+1EF9 letter it has today.
- **The default `partitions.csv` does not change.**
- **No flash before Task 14, no push.**

## Review Focus

- **A dial that saved Tux, or a companion, before** boots the Focus-only image. Expected: it draws Focus, and the host sees the same character name as before (Task 3 test).
- **A format nano cannot print** (`%ll*`, `%j`, `%z`, `%t`, `%L`, `%a`). Expected: none in `FW/main`, and `_printf_float` is still linked for cJSON (Task 4).
- **An array merged into another** but drawn with a different palette, size or element type. Expected: merged arrays are identical in type and body, and the existing pet, mark and face render tests still pass (Tasks 5-6).
- **A word with a cut letter next to a kept one** (e.g. "Łódź Hà Nội"). Expected: base letters for the cut ones, the real glyphs for the kept ones, and no `?` (Task 7 test).
- **A task near its new stack size** on a path the telemetry has not covered: a long voice message, a long Swarm list, the all-skins inflater. Expected: each keeps ≥ 1 KB free over the Task 14 runs, and render keeps 24 KB in all-skins.

---

### Task 1: Baseline

**Files:** none. Writes `/tmp/dialres-build/baseline.txt`.

- [ ] **Step 1: Build.** Build `default`, `skins` (`-DDEVICE_ALL_SKINS=1`) and `probe` (`-DBOARD_PROBE=1`) and run `idf.py size` on each.
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

### Task 3: The Focus-only image links only Focus (#1)

**Files:** Modify `FW/main/ui/habitat/character.c` (registry `characters[]`, `ht_character_species`, `ht_character_tick`, and any other direct call into `ht_tux_*` / `ht_octopus_*` / `ht_illustrated_*`). Create `FW/test/test_focus_only_link.py`.

**Interfaces:**
- Produces: under `HABITAT_FOCUS_ONLY`, every `ht_character_id_t` resolves to Focus's tick/draw/face, each row keeps its own `name`, and `ht_character_species()` returns false.

- [ ] **Step 1: Failing test** `test_focus_only_link.py`.
  - Compile `character.c` to an object twice, with the `-I`/`-D` flags `run.sh` uses for `test_character`: once with `-DHABITAT_FOCUS_ONLY=1`, once without.
  - Run `nm -u` on each.
  - Assert that the FOCUS_ONLY object has no undefined symbol starting with `ht_tux_`, `ht_illustrated_` or `ht_octopus_`.
  - Assert that the other object references `ht_tux_draw`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Gate `character.c`.** Under `#ifdef HABITAT_FOCUS_ONLY`, apply the Interfaces block. The `#else` side is today's code, unchanged.
- [ ] **Step 4: Verify.** Test PASS, host tests (they build without the flag).
- [ ] **Step 5: Measure.**
  - `default`: total down by ≈ 270 KB, and no `ht_tux_` / `ht_illustrated_` / `ht_octopus_` in `nm`.
  - `skins`: totals unchanged.
- [ ] **Step 6: Commit** `round dial: the Focus-only image links only Focus`.

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
  - `HABITAT_RENDER_STACK` = 12288 under `HABITAT_NO_COMPANION_ART`, else 24576.
  - Update the comment: the 24 KB is the ROM inflater's, and only the companion pack uses it.
- [ ] **Step 2: Other stacks.**
  - `proj_refresh` 4096, `voice_capture` 4096, `voice_send` 4096.
  - Each gets a comment naming its measured peak (2,248 / 2,576 / 2,404 B, from the dials' `STACK` and `alive` lines, fw ≥ 0.0.94).
- [ ] **Step 3: Verify.** Host tests. Build `default` and `skins`; `skins` keeps 24576 for render.
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
- [ ] **Step 4: Measure.** Build `default`, `skins` and `probe`.
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

- [ ] **Step 1: Build.** Build `default`, `skins` and `probe` (`skins` and `probe` must build).
  - Expected: Flash ≈ 14 KB smaller.
  - Any missing component the build names goes back into `BOARD_REQUIRES`, ledgered.
- [ ] **Step 2: Fault build.** Build `fault` (`-DDEVICE_RENDER_FAULT=1`). It is used in Task 14 to prove that logs and a fault report still reach the cable.
- [ ] **Step 3: Commit** `round dial: minimal build`.

### Task 13: The all-skins image boots again: the pack in its own partition (#7)

**Files:**
- Create `FW/partitions_skins.csv`:
  - `nvs` and `otadata` as in `partitions.csv`
  - `ota_0` at 0x20000, size 0x560000
  - `ota_1` at 0x580000, size 0x560000
  - `companions`, data/0x40, at 0xAE0000, size 0x500000
- Modify `FW/main/CMakeLists.txt`:
  - With `DEVICE_ALL_SKINS`: no `EMBED_FILES` pack.
  - Point `CONFIG_PARTITION_TABLE_CUSTOM_FILENAME` at `partitions_skins.csv`, through an `sdkconfig.skins` defaults file appended to `SDKCONFIG_DEFAULTS` when the flag is set.
  - `esptool_py_flash_to_partition(flash "companions" "${pack}")`.
- Modify `FW/main/ui/habitat/illustrated_cache.c`: replace the `_binary_companion_art_pack_*` symbols with `esp_partition_find_first(0x40, …, "companions")` + `esp_partition_mmap(..., ESP_PARTITION_MMAP_DATA, ...)` at init.
  - A missing partition or a bad pack header falls back to `HABITAT_NO_COMPANION_ART` behaviour: Focus, as the Focus-only image does.
- Create `FW/test/test_skins_partitions.py`.

- [ ] **Step 1: Failing test** `test_skins_partitions.py`.
  - `partitions_skins.csv` parses.
  - No partitions overlap, and all end ≤ 16 MB.
  - Each OTA slot ≥ 1.3 × the all-skins image without the pack (≈ 3.4 MB).
  - `companions` ≥ the size of `assets/companions/companion_art.pack`.
  - `partitions.csv` is byte-identical to `origin/main`'s.
- [ ] **Step 2: Run it.** Expected: FAIL (no file).
- [ ] **Step 3: Implement** as listed. Keep the default build's CMake path unchanged.
- [ ] **Step 4: Verify.** Test PASS and host tests (`test_companions.py` reads the pack file, not the image).
- [ ] **Step 5: Measure.**
  - `skins`: image + PSRAM statics < 8,388,608 B.
  - `default`: unchanged against Task 12.
- [ ] **Step 6: Commit** `round dial: the all-skins image keeps its companion pack in a partition, so it fits PSRAM and boots`.

### Task 14: Proof on a dial, and the two A/B decisions

**Files:** none, except reverting Task 10 and/or Task 11 if their rule fails. A revert counts as a Task 14 commit.

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
- [ ] **Step 5: All skins.** If Diego has a spare dial, USB-flash `skins` to it.
  - Expected: it boots and draws an illustrated companion when one is selected.
  - Never push this image over OTA.
  - Without a spare dial, record that this check is still open.
