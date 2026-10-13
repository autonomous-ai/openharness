# Harness Pro Lightweight Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the Pro firmware's image from 3.09 MB to at most 2.0 MB and its worst pet frame from about 43 ms to at most 30 ms, without changing a pixel.

**Architecture:**
- **Generators:** trim the generated assets (fonts, pets, logos) at their generators, and leave every decoder alone.
- **Wi-Fi:** remove the stack from the build.
- **Code:** speed up the one hot raster function, and stop waking the clock between pet steps.
- **Golden check:** a hash of every Pod screen, taken before any change, gates each task.

**Tech Stack:** ESP-IDF 5.5.4 (esp32p4), C11, Python 3 with Pillow (`/usr/local/bin/python3`), bash.

**Spec:** `docs/superpowers/specs/2026-10-11-harness-pro-lightweight-design.md`

## Global Constraints

- **Where:** all work is in `/private/tmp/claude-503/x/hpro/devices/harness-pro/firmware`, on branch `feat/harness-pro-firmware`. `devices/harness-device` stays byte-identical.
- **No commit or push** until the owner says so (owner, 2026-10-11).
- **Visuals:** byte-identical. `test/golden.sh --check` must pass after every task from Task 2 on.
- **Tests:** `test/run.sh` passes with Helvetica (the default on macOS) and with `PRO_FONT=$PWD/fonts/LiberationSans-Regular.ttf`. `test/test_tree_isolation.py` and `test/test_fonts.py` pass.
- **Build:**
  ```
  . ~/esp/esp-idf-5.5.4/export.sh && idf.py -B build -DPROJECT_VER=0.0.99-pod -DPOD_PANEL_TURN=180 build
  ```
  The size report comes from `python -m esp_idf_size --files build/harness_pro.map`.
- **Flash:** only with `scripts/flash.sh`, which keeps the chip and MAC guard. Never force-flash.
- **Kept:** `nvs_flash` and `mbedtls` stay (`config_store` needs them), `partitions.csv` is untouched, and the log level stays INFO (the daemon reads the "alive" heartbeat).
- **Not in this plan:** asset compression, `-Os`, stack trims and hardware rotation.

## Review Focus

1. **A dynamic string drawn at 42 or 56** would draw blank. Task 2's character scan must cover every `ht_pro_42` and `ht_pro_56` use.
2. **Re-running `import_pets.sh`** must still yield the pruned `pets.c`. Task 3 tests that the pruned pointers are NULL after an import.
3. **An engine without a pet** (gemini, cursor, kilo and so on) must still show its 72 px logo. The golden screens include one (`agent:cur`, `agent:kilo`).
4. **Booting without Wi-Fi:** the C5 is held in reset, the session comes up, `heap=` goes up, and there is no PANIC. This is checked on the device in Task 7.
5. **Animations that are not pets** (the LCD bars on the Agent screen, the Codex listening bars, the Playing ribbon, page flicks) must keep their cadence after Task 6. Task 6's test checks it.

---

### Task 1: Golden screen hashes and a size report

**Files:**
- Create: `test/golden.sh`
- Create: `test/golden.txt` (the baseline, committed with the plan's work)

**Interfaces:**
- Produces:
  - `test/golden.sh` writes `test/golden.txt`.
  - `test/golden.sh --check` exits 0 when every hash matches, and otherwise exits 1 and prints the screens that differ.

- [ ] **Step 1: Write `test/golden.sh`.**
  - It builds `test/pod_render.c` with the same command as `test/pod_render.py`, into `test/out/golden/`.
  - It renders each screen in this list at now_ms 0, 600, 1234, 2500 and 5000, and writes one `sha256  screen@now` line per render:
    - `tabs`, `tabs:1`, `tabs:mock`
    - `default`, `default:tab`, `default:talk`
    - `recent`, `chrome`, `chrome:talk`
    - `tab:0` through `tab:5`
    - `agent:`, `recap:` and `talk:` for each of `fw ota be cli web desk docs vault site cur notes2 kilo`
  - Font: it uses `PRO_FONT` if set, else the generator's default. It writes `test/golden.txt` once for Helvetica and `test/golden-liberation.txt` once for Liberation, choosing by `PRO_FONT`.
- [ ] **Step 2: Capture the baselines** before any other change: `bash test/golden.sh`, then `PRO_FONT=$PWD/fonts/LiberationSans-Regular.ttf bash test/golden.sh`.
- [ ] **Step 3: Check that it is stable.** Run `bash test/golden.sh --check`. Expected: `golden: 255 screens match` (the exact count is printed) and exit 0.
- [ ] **Step 4: Record the baseline size.** Run the build and the size report, and write the image size and the top 10 files into `devices/harness-pro/docs/size-baseline.txt`.

### Task 2: Fonts 42 and 56 carry only the glyphs Pod draws

**Files:**
- Modify: `scripts/gen_fonts.py` (SIZES handling, `bake`)
- Modify: `test/test_fonts.py`

**Interfaces:**
- Consumes: Task 1's `golden.sh --check`.
- Produces: `gen_fonts.py` constant `SPARSE = {42: "#>_?", 56: "#>_?"}`.

- [ ] **Step 1: Write the failing tests** in `test/test_fonts.py`.
  - `test_sparse_sizes_have_empty_masks`: generate into a temp file, parse it, and check that at 42 and 56 every glyph outside `#>_?` has a zero-size mask, while `#` has a non-empty one.
  - `test_sparse_sizes_keep_metrics`: for every codepoint, the width and advance at 42 and 56 equal those of a full bake.
  - `test_only_sparse_chars_drawn`: scan `main/**/*.c` for `ht_pro_42` and `ht_pro_56`. Every use must be a string literal made only of `#>_?`. A use with a non-literal argument fails, naming the file and line.
- [ ] **Step 2: Run them.** `python3 test/test_fonts.py` → FAIL on the first two.
- [ ] **Step 3: Implement `SPARSE` in `bake()`.** Measure every glyph as today. Store the mask bytes only for codepoints in `SPARSE[size]`, and give the others offset 0 and size 0.
- [ ] **Step 4: Verify.**
  - `python3 test/test_fonts.py` → PASS.
  - `bash test/golden.sh --check` and the Liberation check → match.
  - `test/run.sh` → rc 0.
  - The size report shows `pro_fonts.c.obj` at about 192 KB or less.

### Task 3: Prune unreachable pet data

**Files:**
- Create: `scripts/prune_pets.py`
- Modify: `scripts/import_pets.sh` (run the prune after the copy)
- Modify: `main/pod/pets.c` (regenerated by the prune)
- Modify: `test/test_pod_pet.c`

**Interfaces:**
- Produces: `prune_pets.py <pets.c>` rewrites the file in place and is idempotent. It prints the bytes removed.

- [ ] **Step 1: Write the failing test** in `test/test_pod_pet.c`.
  - For claude, codex and muse, the relax scene pointer and the alert scene pointer are NULL.
  - Every frame index any reachable loop names is still in range.
  - `pod_pet_has(engine, POD_SCENE_WORK / LISTEN / SEND)` is unchanged.
- [ ] **Step 2: Run it.** `test/run.sh` → FAIL on the NULL checks.
- [ ] **Step 3: Implement `prune_pets.py`.**
  - What it removes:
    - the relax and alert scene definitions, with their frame arrays, and only those;
    - codex frames referenced only by its WORKING and DONE small loops.
  - Reachability: a frame array is kept only if a loop Pod can play references it. Pod plays the idle and asking small loops, and the work, listen and send scenes with their overlays (see `pod_pet.c` `scene_of` and `small_state`).
  - Kept loop tables are renumbered and every index is rewritten.
  - A second run removes 0 B.
- [ ] **Step 4: Prune in place and verify.**
  - Run `python3 scripts/prune_pets.py main/pod/pets.c`.
  - `test/run.sh` → rc 0, and both golden checks → match.
  - `pets.c.obj` is at about 960 KB or less.

### Task 4: No 72 px logo for engines that have a pet

**Files:**
- Modify: `scripts/pod_gen_logos.py`
- Modify: `main/pod/engine_logos.c` (regenerated)
- Modify: `test/test_pod_assets.c`

- [ ] **Step 1: Write the failing test** in `test/test_pod_assets.c`.
  - The 72 px logo lookup for claude, codex and muse is absent.
  - It is present for every other engine the generator knows.
- [ ] **Step 2: Implement.** The generator skips the 72 px size when the engine has a pet. Take the list from the `pets.h` engine table, not a hard-coded copy. Then regenerate.
- [ ] **Step 3: Verify.**
  - `test/run.sh` → rc 0, and both golden checks → match. They include `agent:cur` and `agent:kilo`.
  - `engine_logos.c.obj` is about 205 KB or less.

### Task 5: Remove Wi-Fi

**Files:**
- Delete: `main/board/pro_wifi.c`, `main/board/pro_wifi.h`
- Modify: `main/CMakeLists.txt` (the source list and REQUIRES)
- Modify: `main/idf_component.yml` (drop `espressif/esp_hosted` and `espressif/esp_wifi_remote`)
- Modify: `main/app_main.c` (the include and the `pro_wifi_start` block)
- Modify: `main/board/board_pro.c` and `.h` (new `board_pro_hold_coprocessor()`)
- Modify: `sdkconfig.defaults` (delete lines 88–112 and the `HTTPS_OTA_ALLOW_HTTP` line)
- Modify: `dependencies.lock` (regenerated by the build)
- Modify: `test/test_tree_isolation.py`

**Interfaces:**
- Produces: `void board_pro_hold_coprocessor(void)`. It configures GPIO13 as an output and drives it high (the C5 is held in reset, active-high), and it is called from `app_main` where `pro_wifi_start` was.

- [ ] **Step 1: Write the failing test** in `test/test_tree_isolation.py`.
  - No file under `main/` includes `esp_wifi`, `esp_hosted`, `esp_netif` or `lwip`.
  - Neither `CMakeLists.txt` nor `idf_component.yml` names those components.
  - `sdkconfig.defaults` has no `CONFIG_ESP_HOSTED` or `CONFIG_ESP_WIFI_REMOTE` line.
- [ ] **Step 2: Run it.** → FAIL.
- [ ] **Step 3: Make the edits** listed above. Then `rm -f sdkconfig` (it is gitignored) and build, so the defaults are re-read and `dependencies.lock` is refreshed. Fix any remaining include that the build reports.
- [ ] **Step 4: Verify.**
  - The isolation test → PASS, `test/run.sh` → rc 0, and the build is clean.
  - The size report has no `libespressif__esp_hosted`, `liblwip` or `libsdmmc`.
  - The image is about 2.0 MB or less.

### Task 6: Faster cell raster, and wake at the pet's next step

**Files:**
- Modify: `main/pod/pod_draw.c` (`cell_raster`, about lines 95–150)
- Modify: `main/app/pod_glue.c` (`unit_ms`)
- Modify: `main/pod/pod_pet.c` and `.h` (new `pod_pet_next_step_ms`)
- Modify: `test/pod_render.c` (an optional `time:` mode, if it is not already present)
- Modify: `test/test_pro_app.py`, `test/test_pod_pet.c`

**Interfaces:**
- Produces: `uint32_t pod_pet_next_step_ms(const char *engine, pod_scene_t scene, uint32_t now_ms, uint32_t started_ms)`.
  - It returns the ms until the pet's frame next changes.
  - It returns `POD_PET_STEP_MS` when the scene draws bars or waves in code.

- [ ] **Step 1: Raster.**
  - Rewrite `cell_raster` with one source-row fetch and an edge-flag row per output row: a z = 8 path, and a zoomed path with an 8-slot row cache. The scratch is a `static` buffer only the render task uses.
  - The prototype is in the scratchpad at `fast/pod/pod_draw.c`. Port it and match the surrounding style.
  - The scratch must stay in the static and off the stack, so `run.sh`'s 4096 B render-stack cap still holds.
- [ ] **Step 2: Check the raster.**
  - Both golden checks → match.
  - `test/run.sh` → rc 0, including the stack cap.
  - Time `recap:be` and `agent:fw` before and after with `pod_render` timing, and record the µs in the task report.
- [ ] **Step 3: Write the failing wake tests.**
  - In `test/test_pod_pet.c`: the scene's frame index at `now_ms + next - 1` equals the one at `now_ms`, and the one at `now_ms + next` differs. Check this for claude work, codex listen and muse idle.
  - In `test/test_pro_app.py`: on the Agent screen with an idle muse, `unit_ms` is 217 or less but more than 33. While working, `unit_ms` never exceeds what the LCD bars need. Codex listening, which has bars, stays at 33.
- [ ] **Step 4: Implement.** `pod_pet_next_step_ms` uses each scene's own step clock. `unit_ms` takes the minimum of the pet's next step and every other animation already on screen.
- [ ] **Step 5: Verify.** `test/run.sh` → rc 0, and both golden checks → match.

### Task 7: Device check and docs

**Files:**
- Modify: `devices/harness-pro/README.md` (no Wi-Fi; the golden check; the size and frame numbers)
- Modify: `devices/harness-pro/docs/size-baseline.txt` (add the after-numbers)

- [ ] **Step 1: Build and flash.** Run the build, then `scripts/flash.sh`. Expected: rc 0, and `session up` in `~/.harness/logs/usb-E8-F6-0A-E7-63-7D/dial-*.log`.
- [ ] **Step 2: Watch the logs for 3 minutes** while an agent works with its pet on screen.
  - `raster_max_us` must be at most 30000.
  - `heap=` must be at or above the baseline's (about 384103).
  - There must be no PANIC.
- [ ] **Step 3: Write the docs.** Put the before and after numbers in the README and `size-baseline.txt`.
- [ ] **Step 4: Run every check once more.**
  - `test/run.sh` with both fonts, and both golden checks.
  - `test_tree_isolation.py` and `test_fonts.py`.
  - `git diff origin/main -- devices/harness-device` → empty.
- [ ] **Step 5: Owner acceptance on the Pro.** Tabs, Agent, Recap, Listening, voice send and the side button. Do not commit or push until the owner says so.
