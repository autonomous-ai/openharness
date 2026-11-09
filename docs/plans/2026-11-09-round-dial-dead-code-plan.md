# Round dial dead-code cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the round dial firmware's dead files, functions, data and comments without changing the built image or any test result.

**Architecture:** Deletions only, in five commits on branch `chore/round-dial-dead-code` (worktree `.claude/worktrees/dialclean`). A baseline of `idf.py size` totals and test results is taken first. Each task ends by proving the same totals and the same passing tests. The audit (`docs/plans/2026-11-09-round-dial-dead-code-audit.md`) holds every item's evidence and line numbers at `d18648f46`. Main has moved since, so re-find each line by its text, never by number.

**Tech Stack:** ESP-IDF 5.5.4 (ESP32-S3), C11, CMake, Python 3 generators and host tests.

**Spec:** `docs/specs/2026-11-09-round-dial-dead-code.md`

## Global Constraints

- Firmware root: `devices/harness-device/firmware/` (written `FW/` below). Never touch `devices/harness-pro`, `cli/`, `desktop/`, `backend/`.
- Toolchain for every build: `. ~/esp/esp-idf-5.5.4/export.sh; export PATH=~/.espressif/tools/xtensa-esp-elf/esp-14.2.0_20260121/xtensa-esp-elf/bin:$PATH; export IDF_PATH=~/esp/esp-idf-5.5.4`.
- Build in a scratch build dir, never `FW/build`: `idf.py -C FW -B /tmp/dialclean-build/<name> -DSDKCONFIG=/tmp/dialclean-build/<name>.sdkconfig build`.
- Keep these, even though they look removable:
  - `ram_telemetry_init` and the `ram_psram_*` helpers; `display_lock_at`; `audio_client.h`; `audio_probe.h`.
  - Every bench and flag tool (O1-O11).
  - `esp_websocket_client`, `BOARD_REQUIRES` and every `sdkconfig` value.
  - All thread/PM/Buddy code.
- Comments only in `idf_component.yml`, `dependencies.lock`, `sdkconfig.defaults*`: no value or dependency change.
- Do not flash a device. Do not push.

## Review Focus

- A Python host test that slices C out of `ui_habitat.c` between markers (`test_touch_ui.py`, `test_voice_ui.py`, `test_question_ui.py`, `test_machine_ui.py`): a deletion next to a marker silently changes what it compiles. Expected: every `FW/test/test_*.py` passes after Task 3, run as CI runs them.
- `-Werror` host builds: a static left unused after a cut (`cjson_psram_malloc`, `axp_charge_state`, `moods`, …) breaks `run.sh`. Expected: `make device-test` passes after Task 3.
- The flag builds (`DEVICE_ALL_SKINS=1`, `BOARD_PROBE=1`) reaching a removed symbol. Expected: both compile in Task 5.
- Removed CMake options passed by scripts (`upload-firmware.sh -DDEVICE_FORCE_PROD=1`). Expected: the option is gone from the script in Task 2, so a release build prints no unused-variable warning.
- The hackathon `solution.patch` no longer applying. Expected: `git apply --check` gives the same result as at baseline (Task 5).

---

### Task 1: Baseline

**Files:** none changed. Write `/tmp/dialclean-build/baseline.txt`.

- [ ] **Step 1: Build the default image and record sizes**
  - Run: `idf.py -C FW -B /tmp/dialclean-build/default -DSDKCONFIG=/tmp/dialclean-build/default.sdkconfig build && idf.py -C FW -B /tmp/dialclean-build/default -DSDKCONFIG=/tmp/dialclean-build/default.sdkconfig size > /tmp/dialclean-build/baseline-size.txt`
  - Expected: build succeeds; the size file lists Flash Code, Flash Data, IRAM, DRAM and the total image size.
- [ ] **Step 2: Record the flag builds**
  - Run the same build with `-DDEVICE_ALL_SKINS=1` (dir `skins`) and with `-DBOARD_PROBE=1` (dir `probe`).
  - Expected: both succeed. If one fails on main already, note it in `baseline.txt`; Task 5 then only requires the same failure.
- [ ] **Step 3: Record the tests**
  - Run, from the repo root:
    - `make device-test`
    - `for t in FW/test/test_*.py; do python3 "$t" || echo "FAIL $t"; done` (CI's glob, with `IDF_PATH` set)
    - `python3 FW/scripts/gen_octopus.py --check`
    - `git apply --check samples/hackathon-fo/01-fo-glance/solution.patch`
  - Expected:
    - device-test passes and every `test_*.py` passes.
    - gen_octopus `--check` FAILS ("octopus_font.c is stale").
    - The patch result is recorded as is.
  - Write all four results into `baseline.txt`.

### Task 2: Delete the dead files (D1-D10)

**Files:**
- Delete:
  - `FW/main/audio_client.c`, `FW/main/ui/touch_ctrl.h`, `FW/main/ui/metrics_round466.h`, `FW/main/ui/ui_metrics.h`
  - `FW/main/provisioned_config.h.example`, `FW/screen.html`, `FW/device-stages.html`
  - `FW/docs/` (3 files), `FW/tools/generate_engine_icons.py`, `FW/scripts/gen_fonts.sh`
  - `FW/fonts/Geist-Medium.ttf`, `FW/fonts/Geist-SemiBold.ttf`, `FW/assets/sparkle.png`
  - `devices/harness-device/prototype/habitat/assets/GeistMono-Regular.ttf`
- Modify:
  - `FW/main/ui/ui_screens.h`: drop `#include "ui_metrics.h"` and the `#if UI_DESK_GRID … #endif` block around `ui_notif_band_top_px`.
  - `FW/main/CMakeLists.txt`: drop the `if(DEVICE_FORCE_PROD)` and `if(DEVICE_BACKEND_URL)` blocks.
  - `FW/.gitignore`: drop the provisioning-secrets comment and the two `main/provisioned_config.h*` lines; keep `build-prod/`.
  - `FW/scripts/upload-firmware.sh`: drop `-DDEVICE_FORCE_PROD=1` and its comment.
  - `FW/assets/README.md`: the sparkle entry names `sparkle_fill.png` only.
  - `devices/harness-device/prototype/habitat/FONTS.md`: the GeistMono line points at `firmware/fonts/`.

- [ ] **Step 1: Confirm each file is still unreferenced on current main**
  - Run: `git grep -n -e audio_client.c -e touch_ctrl -e metrics_round466 -e ui_metrics.h -e provisioned_config -e screen.html -e device-stages.html -e generate_engine_icons -e gen_fonts.sh -e Geist-Medium -e Geist-SemiBold -e 'sparkle\.png' -- . ':!docs/plans/2026-11-09-round-dial-dead-code-audit.md' ':!devices/harness-pro'`
  - Expected: only the lines this task edits, the files themselves, and historical `docs/superpowers/plans/*` records. Anything else: stop, and report it as a ruling.
- [ ] **Step 2: Delete and edit** as listed above.
- [ ] **Step 3: Verify**
  - Rebuild `default` and run `size`. Expected: Flash Code, Flash Data, IRAM, DRAM and total equal `baseline-size.txt`.
  - Run: `make device-test`. Expected: pass.
- [ ] **Step 4: Commit**
  - `git add -A devices/harness-device`
  - `git commit -m "round dial: delete files nothing builds or reads (LVGL, Pro and Wi-Fi leftovers)"`

### Task 3: Delete unused functions, declarations and macros (D11-D13)

**Files:**
- Modify (functions): `FW/main/ui/habitat/ui_habitat.c`, `FW/main/cable_client.c`, `FW/main/cable_link.c`, `FW/main/board/power.c`, `FW/main/config_store.c`, `FW/main/ui/habitat/tim.c`, `FW/main/ui/habitat/display_habitat.c`, `FW/main/ui/habitat/creature_gallery.c`.
- Modify (headers): `FW/main/ui/ui_screens.h`, `FW/main/cable_client.h`, `FW/main/cable_link.h`, `FW/main/ui/display.h`, `FW/main/board/power.h`, `FW/main/config_store.h`, `FW/main/ui/habitat/runtime.h`, `FW/main/ui/habitat/tim.h`, `FW/main/ui/habitat/creature_gallery.h`.
- Modify (macros, D13): `FW/main/config_store.c`, `FW/main/board/pins_dial.h`, `FW/main/board/board.h`, `FW/main/ui/habitat/octopus.h`, `FW/main/fw_update.c`.

The names are in the audit, D11 (table), D12 and D13. Exception: **skip the `ram_telemetry.c` row entirely.**

- [ ] **Step 1: Re-check every name is still unused on current main**
  - Run, for each function name N: `git grep -nw N -- devices/harness-device samples`
  - Expected: only its definition, its prototype and comments. A new caller means: keep that function, and record a ruling.
- [ ] **Step 2: Delete**
  - Remove the functions, prototypes and comments, the D12 declarations (`cable_tile_t`, `SWARM_TILES_MAX`), and the D13 macros/enum values.
  - Also remove the statics a cut leaves unused: `axp_charge_state` and `AXP_REG_STATUS0` in `power.c`, `moods` in `creature_gallery.c`.
  - Keep the comment above `PROGRESS_EVERY` in `fw_update.c` (it documents the ACK-per-slice rule).
- [ ] **Step 3: Verify**
  - `make device-test`: pass (`-Werror` catches a leftover static).
  - `for t in FW/test/test_*.py; do python3 "$t" || echo "FAIL $t"; done`: no FAIL.
  - Rebuild `default` and run `size`: totals equal the baseline.
- [ ] **Step 4: Commit**
  - `git commit -am "round dial: delete functions, declarations and macros nothing uses"`

### Task 4: Generated data and generators (D14-D16)

**Files:**
- Modify:
  - `FW/main/ui/habitat/lvgl_icons.c`, `FW/scripts/gen_lvgl_assets.py`, `FW/assets/lvgl/SPEC.md`, `FW/main/ui/habitat/terminal.h`, `FW/main/ui/habitat/focus.h`, `FW/test/test_touch_ui.py` (the `ht_icon_mic` assert) — D14.
  - `FW/scripts/gen_octopus.py`, `FW/test/test_glyph_cache.c`, `FW/test/test_raster_ascii.c`, `FW/test/bridge_flow_replay.py`, `FW/test/test_audio_init.py`, `FW/test/test_touch_driver.py` (comment) — D15.
  - `FW/main/ui/habitat/fonts.c`, `FW/scripts/gen_habitat_fonts.py`, `FW/test/test_terminal.c`, `devices/harness-device/prototype/habitat/FONTS.md` — D16.
- Delete: `devices/harness-device/prototype/habitat/assets/unscii-8.ttf` — D16.

- [ ] **Step 1: The failing check**
  - Run: `python3 FW/scripts/gen_octopus.py --check`. Expected: FAIL (stale).
- [ ] **Step 2: Fix `gen_octopus.py`**
  - Drop heights 14 and 16 from its height loop, remove `PRO_ONLY` and the `#if HT_FACE_PX >= 720` wrapping.
  - Run `--check` again. Expected: PASS with no change to `octopus_font.c` or `octopus_art.inc`.
- [ ] **Step 3: D14**
  - Hand-delete `engine28_*`, `ht_icon_engine28` and `mic` from `lvgl_icons.c`.
  - Make `gen_lvgl_assets.py` stop emitting them, including its summary print.
  - Drop the 27 px and microphone rows from `SPEC.md`, and update the `terminal.h` declaration and the `focus.h` comment.
  - Rewrite the `test_touch_ui.py` assert so it checks that no mic sprite is drawn without naming `ht_icon_mic`. If the assert means nothing without it, delete the assert and record a ruling.
  - Do not regenerate through the script (it needs an LVGL checkout).
- [ ] **Step 4: D15 tests**
  - Remove the `#if HT_FACE_PX >= 720` arms in the two C tests and keep their `#else` bodies.
  - Remove `#define DEVICE_HABITAT 1` from the two Python tests, and fix the stale `test_touch_driver.py` comment.
- [ ] **Step 5: D16**
  - Hand-delete the `ht_pixel_40` and `ht_lock_dot` blocks from `fonts.c`, and their declarations in `terminal.h`.
  - In `gen_habitat_fonts.py`, drop the `pixel` input, the two font entries and their special case, and update the docstring.
  - In `test_terminal.c`, remove the lines that use the two fonts.
  - Delete `unscii-8.ttf` and its `FONTS.md` line.
- [ ] **Step 6: Verify**
  - `make device-test` passes, every `FW/test/test_*.py` passes, and `gen_octopus.py --check` passes.
  - Rebuild `default` and run `size`: totals equal the baseline.
- [ ] **Step 7: Commit**
  - `git add -A devices/harness-device`
  - `git commit -m "round dial: drop unused icons and fonts, and the Pro octopus atlases so gen_octopus --check passes"`

### Task 5: Stale comments (D17 text, D18) and final proof

**Files:**
- Modify (comments only):
  - `FW/.gitignore`, `FW/CMakeLists.txt`, `FW/main/idf_component.yml`, `FW/sdkconfig.defaults`, `FW/sdkconfig.defaults.esp32s3`
  - `FW/main/ram_telemetry.h`, `FW/main/board/board_pins.h`, `FW/main/board/board.h`, `FW/main/board/board.c`, `FW/main/app_main.c`, `FW/main/device_mac.c`
  - `FW/main/ui/habitat/display_habitat.c`, `FW/main/ui/habitat/terminal.h`, `FW/main/ui/habitat/character_motion.c`, `FW/main/ui/touch.h`, `FW/main/ptt.c`, `FW/main/board/board_probe.c`, `FW/main/ui/ui_screens.h`
  - `FW/main/fw_update.h`, `FW/scripts/upload-firmware.sh`, `FW/test/test_fw_update.py`
  - The audit's D17 and D18 lists. `.gitignore` entries for `build.dial/`, `build.pro/`, `sdkconfig.dial*`, `sdkconfig.pro*`, `build-arm` go too.

- [ ] **Step 1: Edit**
  - Remove or reword each stale sentence so it describes the one board and the current code. Never change a value, a dependency, or code.
  - `git diff --stat` and a read of the diff must show comment and ignore lines only.
- [ ] **Step 2: Final proof**
  - Rebuild `default` and run `size`: equal to the baseline.
  - Rebuild `skins` and `probe`: same outcome as the baseline.
  - `make device-test`, every `test_*.py`, `gen_octopus.py --check`: pass.
  - `git apply --check samples/hackathon-fo/01-fo-glance/solution.patch`: same result as the baseline.
  - Write the before/after totals into `/tmp/dialclean-build/final.txt`.
- [ ] **Step 3: Commit**
  - `git commit -am "round dial: comments describe the one board, without LVGL, the Pro or Wi-Fi"`
