# Round dial resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give back about 400 KB of flash and PSRAM and about 25 KB of internal RAM on the round dial, with no change in what it shows or does.

**Architecture:** Seven independent changes on branch `chore/round-dial-resources` (worktree `.claude/worktrees/dialres`), one commit each. Each change is pinned by a host test where one can express it, and proved by an `idf.py size` / `nm` comparison against a baseline. The last task is a USB flash and a 30-minute run on a dial. Audit with all numbers and file:line: `docs/plans/2026-11-10-round-dial-resources-audit.md`. It was taken at `c1a711d1a`, so re-find lines by text.

**Tech Stack:** ESP-IDF 5.5.4 (ESP32-S3), C11, CMake, Python 3 generators and host tests.

**Spec:** `docs/specs/2026-11-10-round-dial-resources.md`

## Global Constraints

- Firmware root `devices/harness-device/firmware/` (`FW/`). Never touch `devices/harness-pro`, `cli/`, `desktop/`, `backend/`.
- Toolchain:
  - `. ~/esp/esp-idf-5.5.4/export.sh; export PATH=~/.espressif/tools/xtensa-esp-elf/esp-14.2.0_20260121/xtensa-esp-elf/bin:$PATH; export IDF_PATH=~/esp/esp-idf-5.5.4`, in a subshell. The IDF venv's `python3` has no Pillow, so host tests run with the system `python3`.
  - Builds go to `/tmp/dialres-build/<name>` with `-DSDKCONFIG=/tmp/dialres-build/<name>.sdkconfig`, never `FW/build`.
- Host tests:
  - `env -u IDF_PATH make device-test`, and `IDF_PATH=~/esp/esp-idf-5.5.4 python3 FW/test/test_X.py` for every `FW/test/test_*.py`.
  - `test_cable_models.py` fails on macOS on main (clang `snprintf` macro redefinition); its bar is "same as baseline".
- New Python tests are plain scripts with `assert`, like the existing `test_*.py`. CI runs them by glob.
- Keep `-DDEVICE_ALL_SKINS=1` behaviour identical: every gate below is `#ifdef HABITAT_FOCUS_ONLY` / `if(NOT DEVICE_ALL_SKINS)`.
- New stack sizes ≥ 1.5× the measured peak. `ptt`, `beep`, main, `cable_link`, `cable_session`, `habitat_actions` and `habitat_touch` keep their sizes.
- Out of scope: IRAM-to-flash settings, `ram_telemetry_init`, Latin Extended-A cuts, `focus_faces.c`, `MINIMAL_BUILD`, partitions.
- No flash before Task 8, no push.

## Review Focus

- A non-default character still reachable in the Focus-only image, so a dial that saved Tux before draws nothing. Expected: the registry maps every id to Focus, and the saved preference reads as Focus (Task 3 test).
- Nano printf on a format that needs more than nano has (`%ll*`, `%j`, `%z`, `%L`, floats outside cJSON). Expected: no such format in `FW/main`, and `_printf_float` is still linked (Task 4).
- A pet or a mark whose array was merged into another's but is drawn with its own palette or size. Expected: merged arrays are byte-identical in content *and* element type. The render tests for pets and marks still pass (Task 5).
- A buffer moved to PSRAM that is touched from an ISR or with the cache disabled. Expected: none of the three is. `s_tx_frame` stays where it is (Task 7).
- A task near its new stack size on a path the telemetry has not covered (voice at 16 kHz, long Swarm lists, a firmware push). Expected: each keeps ≥ 1 KB free over the Task 8 run.

---

### Task 1: Baseline

**Files:** none. Writes `/tmp/dialres-build/baseline.txt`.

- [ ] **Step 1:** Build `default`, `skins` (`-DDEVICE_ALL_SKINS=1`) and `probe` (`-DBOARD_PROBE=1`) and run `idf.py size` on each.
  - Expected: all build. The default total is about 3,369,871 B.
- [ ] **Step 2:** Save `xtensa-esp32s3-elf-nm` symbol names for each ELF to `/tmp/dialres-build/names-<name>.txt`.
- [ ] **Step 3:** Record the test results:
  - `env -u IDF_PATH make device-test`
  - the `test_*.py` loop
  - `python3 FW/scripts/gen_pets.py --check`
  - Expected: all pass, except the known `test_cable_models.py`.

### Task 2: Stack telemetry names the real tasks (#11)

**Files:**
- Modify: `FW/main/ram_telemetry.c` (the `tasks[]` list in `ram_telemetry_periodic`)
- Create: `FW/test/test_ram_telemetry_tasks.py`

- [ ] **Step 1: Write the failing test `test_ram_telemetry_tasks.py`**
  - It collects every task name created in `FW/main` (`git grep`/regex over `xTaskCreate(` and `xTaskCreatePinnedToCore(`: the second argument's string literal).
  - It reads the string literals in `tasks[]` inside `ram_telemetry_periodic`.
  - It asserts `set(tasks) == created`.
  - It asserts `"commander_ws" not in tasks`.
- [ ] **Step 2:** Run it. Expected: FAIL (`commander_ws` listed; `cable_link`, `cable_session`, `habitat_actions`, `habitat_touch`, `habitat_render`, `voice_capture`, `voice_send` missing).
- [ ] **Step 3:** Set `tasks[]` to `proj_refresh, ptt, beep, cable_link, cable_session, habitat_actions, habitat_touch, habitat_render, voice_capture, voice_send`.
- [ ] **Step 4:** Run the test (PASS), `make device-test`, the `test_*.py` loop, and a `default` build.
- [ ] **Step 5:** Commit: `round dial: stack telemetry lists the tasks the firmware runs`.

### Task 3: The Focus-only image links only Focus (#1)

**Files:**
- Modify: `FW/main/ui/habitat/character.c` (registry `characters[]` ~line 42-58; `ht_character_tick` ~line 103 and any other direct call into `ht_illustrated_*`, `ht_tux_*`, `ht_octopus_*`)
- Create: `FW/test/test_focus_only_link.py`

**Interfaces:**
- Produces: under `HABITAT_FOCUS_ONLY`, every `ht_character_id_t` resolves to the Focus definition. `ht_character_species()` returns false, so no species path is taken.

- [ ] **Step 1: Write the failing test `test_focus_only_link.py`**
  - It compiles `FW/main/ui/habitat/character.c` alone to an object with `cc -c -std=c11 -DHABITAT_FOCUS_ONLY=1 -I FW/main -I FW/main/ui -I FW/main/ui/habitat` (add the `-I`/`-D` the existing `run.sh` line for `test_character` uses).
  - It runs `nm -u` on the object.
  - It asserts that no undefined symbol starts with `ht_tux_`, `ht_illustrated_`, `ht_octopus_`, or is `ht_tim_draw`.
  - It compiles again WITHOUT the define and asserts `ht_tux_draw` IS undefined there, so the test proves the switch.
- [ ] **Step 2:** Run it. Expected: FAIL (the `HABITAT_FOCUS_ONLY` object references `ht_tux_draw` and others).
- [ ] **Step 3:** In `character.c`, under `#ifdef HABITAT_FOCUS_ONLY`:
  - Every row of `characters[]` is the Focus row, keeping its own `name` string so names reported to the host do not change.
  - `ht_character_species()` returns false.
  - The `ht_illustrated_tick_species` call is compiled out.
  - The `#else` side is today's code byte for byte.
- [ ] **Step 4:** Run the test (PASS), `make device-test` (it builds without the flag, so every skin stays covered), and the `test_*.py` loop.
- [ ] **Step 5:** Build `default` and `skins`.
  - Expected: `default` total down by ≈ 270 KB, and `nm` has no `ht_tux_`, `ht_illustrated_`, `ht_octopus_` symbols.
  - Expected: `skins` totals equal its baseline.
- [ ] **Step 6:** Commit: `round dial: the Focus-only image links only Focus`.

### Task 4: newlib nano printf (#4)

**Files:**
- Modify: `FW/main/ram_telemetry.c:113` (two `%llu` → `%u`, their arguments cast to `unsigned`)
- Modify: `FW/sdkconfig.defaults` (add `CONFIG_LIBC_NEWLIB_NANO_FORMAT=y` with a one-line reason)
- Create: `FW/test/test_nano_formats.py`

- [ ] **Step 1: Write the failing test `test_nano_formats.py`**
  - It scans every `.c`/`.h` under `FW/main` for string literals containing `%` conversions.
  - It asserts that none uses a length or conversion that newlib nano lacks: `ll`, `j`, `z`, `t`, `L`, or `%a`.
  - It asserts that `FW/sdkconfig.defaults` sets `CONFIG_LIBC_NEWLIB_NANO_FORMAT=y`.
- [ ] **Step 2:** Run it. Expected: FAIL on `ram_telemetry.c` and on the missing setting.
- [ ] **Step 3:** Make both edits.
- [ ] **Step 4:** Run the test (PASS) and the host tests.
- [ ] **Step 5:** Build `default`.
  - Expected: Flash Code down by ≈ 31 KB.
  - Expected: `nm` still has `_printf_float` (cJSON prints numbers with `%1.15g`).
- [ ] **Step 6:** Commit: `round dial: newlib nano printf`.

### Task 5: No duplicated generated data (#5, pets and marks)

**Files:**
- Modify: `FW/scripts/gen_pets.py`; regenerate `FW/main/ui/habitat/pets.c`
- Modify: `FW/scripts/gen_focus_marks.py`; regenerate `FW/main/ui/habitat/focus_marks.c`
- Create: `FW/test/test_generated_unique.py`

- [ ] **Step 1: Write the failing test `test_generated_unique.py`**
  - It parses every `static const <type> <name>[N] = {…};` in `pets.c` and `focus_marks.c`.
  - It asserts that no two arrays of the same element type have identical bodies.
  - It asserts that the `ht_icon_engine56` entries at ENGINES indices 0, 1 and 11 (claude, codex, muse) have width 0 and NULL pixels.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3: `gen_pets.py`**
  - While emitting, keep a map from (element type, body) to the first array name.
  - Emit a repeated body once, and point later references (frame tables, `ht_pets[]`) at the first name.
  - Run `gen_pets.py`, then `gen_pets.py --check`. Expected: `--check` passes.
- [ ] **Step 4: `gen_focus_marks.py`**
  - For `claude`, `codex` and `muse`, emit `{0,0,NULL,NULL}` with a comment: they always show their built-in pet (`focus.c` `pet_for`).
  - Dedupe the rest as in Step 3.
  - Regenerate.
- [ ] **Step 5:** Run the test (PASS), `make device-test` (the pet and focus render tests), and the `test_*.py` loop.
- [ ] **Step 6:** Build `default`. Expected: total down by a further ≈ 90 KB.
- [ ] **Step 7:** Commit: `round dial: generated pets and marks carry each array once`.

### Task 6: Smaller stacks where telemetry shows the need (#3, #12)

**Files:**
- Modify:
  - `FW/main/ui/habitat/display_habitat.c` (`habitat_render` stack)
  - `FW/main/app_main.c` (`proj_refresh`)
  - `FW/main/audio_client_habitat.c` (`voice_capture`, `voice_send`)

- [ ] **Step 1:** `habitat_render`: `HABITAT_RENDER_STACK` is 12288 under `HABITAT_NO_COMPANION_ART`, else 24576. Update the comment: the 24 KB is for the ROM inflater, which only the companion pack uses.
- [ ] **Step 2:** `proj_refresh` 7168 → 4096, `voice_capture` 5120 → 4096, `voice_send` 5120 → 4096. One comment each, naming the measured peak (2,248 / 2,576 / 2,404 B, from the dials' `STACK` and `alive` lines).
- [ ] **Step 3:** Run the host tests. Build `default` and `skins`.
  - Expected: `default` static RAM unchanged (stacks are heap).
  - Expected: `skins` keeps 24576 for render.
- [ ] **Step 4:** Commit: `round dial: render, refresh and voice stacks sized from their measured peaks`.

### Task 7: Rare-path buffers to PSRAM, network leftovers out (#9, #13)

**Files:**
- Modify: `FW/main/last_words.c` (`s_previous` → `EXT_RAM_BSS_ATTR`), `FW/main/pet_store.c` (`s_scratch` → `EXT_RAM_BSS_ATTR`), `FW/main/cable_client.c` (`s_agents` from `heap_caps_calloc(..., MALLOC_CAP_SPIRAM)`, falling back to `calloc`)
- Modify:
  - `FW/main/CMakeLists.txt` `BOARD_REQUIRES`: drop `esp_wifi`, `esp_netif`, `esp_event`, `esp_http_server`, `esp_http_client`, `esp_https_ota`, `esp_websocket_client`, `esp-tls`.
  - `FW/main/idf_component.yml`: drop `espressif/esp_websocket_client`.
  - `FW/dependencies.lock`: regenerate with `idf.py reconfigure`.
  - `FW/sdkconfig.defaults*`: drop the Wi-Fi, HTTP(S)-OTA, TLS bundle, LWIP and WebSocket keys, as the audit's `nonet2` build did.

- [ ] **Step 1:** Confirm, by `git grep`, that none of the three buffers is touched from an ISR or an `IRAM_ATTR` function. If one is, keep it and ledger a ruling.
- [ ] **Step 2:** Make the three buffer edits. Run the host tests.
- [ ] **Step 3:** Make the network edits.
  - Run `idf.py reconfigure` in the `default` build.
  - Expected: `dependencies.lock` loses `esp_websocket_client` and nothing else changes.
- [ ] **Step 4:** Build `default`, `skins`, `probe`.
  - Expected: all build.
  - Expected: DIRAM `.bss` down by ≈ 8.2 KB (the two statics).
  - Expected: the network edits change no section size and add or remove no symbol versus the Task 6 build (the audit measured 0 B).
- [ ] **Step 5:** Commit: `round dial: rare-path buffers in PSRAM; drop the network components nothing links`.

### Task 8: Proof on a dial

**Files:** none.

- [ ] **Step 1:** Build `default` with `-DPROJECT_VER=0.1.0-dev`. Flash it with the repo procedure:
  - quit Harness;
  - write `date +%s` to `~/.harness/flasher/flashing`;
  - `harness stop`;
  - confirm the chip is ESP32-S3 with `python -m esptool chip_id`;
  - `idf.py -p <port> flash`;
  - remove the flag;
  - `harness start`;
  - open Harness.
- [ ] **Step 2:** The daemon log says `on fw 0.1.0-dev`, and no `offering firmware` follows.
- [ ] **Step 3:** Compare the first `RAM tag=` line after boot with one from the baseline firmware in `~/.harness/logs/usb-*/dial-*.log`. Expected: `int_free` at least 25 KB higher.
- [ ] **Step 4:** Ask Diego to use the dial for 30 minutes: Focus face, a pet alert, a voice message, the Swarm screens, and a firmware push over the cable.
  - Expected: no reboot, watchdog or `stack overflow` in the dial log.
  - Expected: every task in the new `STACK` lines keeps ≥ 1 KB free.
