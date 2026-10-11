# Harness Pro Firmware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Harness Pro its own ESP-IDF firmware under `devices/harness-pro/firmware` that runs only Pod, and serve it from main's daemon through hello capabilities, without touching `devices/harness-device`.

**Architecture:**
- Copy what the Pod build compiles on `dev/firmware-pro` (0c73edf72), then cut it down to a Pro-only tree.
- Pod's pure-C model, nav and views move unchanged.
- A new `pro_app` (app layer) and `pro_cable` (cable client) replace the round's `ui_habitat.c` and `ui_screens.h`.
- Main's `cli/src/cable` gains the Pro's messages, behind capabilities the Pro names in its hello.

**Tech Stack:** ESP-IDF 5.5.4 (esp32p4); C11; host tests with clang/cc, UBSan and Python harnesses; TypeScript (vitest) for the daemon.

**Spec:** `docs/superpowers/specs/2026-10-11-harness-pro-firmware-design.md`

**Paths used throughout:**
- `SRC` = `/private/tmp/claude-503/x/podwt/devices/harness-device/firmware`, the dev/firmware-pro source at 0c73edf72. It is read-only for this plan.
- `PRO` = `devices/harness-pro/firmware` in this worktree (`/private/tmp/claude-503/x/hpro`, branch `feat/harness-pro-firmware`, based on origin/main).

## Global Constraints

- **Toolchain and board:** ESP-IDF 5.5.4 at `~/esp/esp-idf-5.5.4`, target esp32p4. The device is the Pro with chip rev v3.2 and MAC `e8:f6:0a:e7:63:7d` on `/dev/cu.usbmodem21101`.
- **Dev image version:** dev images are built with `-DPROJECT_VER=0.0.99-pod`, so the daemon's OTA never overwrites them.
- **Panel:** `POD_PANEL_TURN=180` for this unit's upside-down panel, chosen at build time. Upright and 180 must both pass the touch tests.
- **Harness-device is untouched:** `git diff origin/main -- devices/harness-device` stays empty. Nothing under `devices/harness-pro` includes, links or globs a path under `devices/harness-device`.
- **No LVGL, no `ui_screens.h`, no Player 1, Living, Daemon or Studio code, and no round characters** (octopus, tim, tux).
- **Fonts:** Helvetica-derived glyph bitmaps are never committed (it is a system font). Devices are built with glyphs generated from macOS Helvetica. Host tests and CI use the same generator over the committed Liberation Sans (SIL OFL), which has the same metrics.
- **Memory and stack:** the frame-size guards stay at 1024 B for model, nav and glue code and 4096 B for render code. The `cable_link` task keeps its 6 KB stack. Scenes and agent tables live in PSRAM (`EXT_RAM_BSS_ATTR`), and `HT_RUNS` is 128.
- **Daemon gating:** the daemon sends a device nothing new unless its hello names the capability:
  - `swarms: "members-v1"`
  - `recap: "long-v1"`
  - `activity: "steps-v1"`
  - `player: "library-v1"`
- **Flashing:** every flash goes through `PRO/scripts/flash.sh`. It writes `~/.harness/flasher/flashing`, runs `harness stop`, checks the chip and MAC, writes 0x2000 bootloader, 0x8000 partitions, 0xf000 otadata and 0x20000 app (dio, 80m, 16MB, 921600), then clears the flag and runs `harness start`. It refuses any other MAC or revision.
- **Language:** docs and code comments are in English and follow `docs/naming-system.md`.
- **Commits:** commit only when the owner has asked for commits in this session. Stage only this plan's files.

## Review Focus

1. **An older daemon** (released CLI 0.3.73, or main before Task 8) that sends no `action`, `step`, `full`, `members` or `player.*`. The Pro must still show Tabs, agents and recaps, with empty bodies and no crash. Pinned in Task 5 (`pro_cable_test_old_daemon`).
2. **A round dial's hello on the new daemon.** Its frames must be byte-identical to today's. Pinned in Task 8 (`round hello gets no Pro fields`).
3. **The link dropping during a library sweep or a recording.** The sweep aborts, Talk goes back to where it came from, and nothing waits forever. Pinned in Task 6 (`pro_app_test_link_drop`) and Task 7 (`voice: link drop ends talk`).
4. **Oversized input.** That means a swarms list over the frame cap, a recap over 2048 B or 64 lines, a 400-char step, or a 900-char activity. Each is cut on a UTF-8 boundary, with no overflow, and no frame looping. Pinned in Task 5 (`pro_cable_test_oversize`).
5. **Both panel orientations.** A tap must land on the same hit upright and with `POD_PANEL_TURN=180`. Pinned in Task 6 (the touch replay runs both).

---

### Task 1: Project skeleton, board and panel

**Files:**
- Create:
  - `PRO/CMakeLists.txt`, `PRO/main/CMakeLists.txt`
  - `PRO/sdkconfig.defaults`, the merge of SRC's `sdkconfig.defaults`, `sdkconfig.defaults.esp32p4`, `../prototype/pro-companion/sdkconfig.defaults` and `../prototype/pro-companion/sdkconfig.wifi.defaults`, with LVGL entries dropped
  - `PRO/partitions.csv`, copied from SRC
  - `PRO/main/idf_component.yml`, with only `esp_hosted 2.12.13`, `esp_wifi_remote ~1.3.1`, `waveshare/esp_lcd_st7703 ^2.0.0`, `espressif/esp_lcd_touch_gt911 ^1.1.0` and `espressif/esp_codec_dev *`
  - `PRO/dependencies.lock`, generated and then committed
- Copy (from SRC, then remove the S3/dial branches):
  - `main/board/{board_i2c,board_pro,power_pro,ptt_pro,pro_wifi}.c/.h`, `board_pins.h`, `pins_pro.h`, `power.h`, `board.h`, `pro_button_filter.h`
  - `main/ui/{pro_panel_bus.c/.h, touch_gt911.c, touch.h}` → `PRO/main/display/`
  - `main/{config_store,device_mac,last_words,ram_telemetry}.c/.h` → `PRO/main/sys/`
- Create:
  - `PRO/main/app_main.c`, a bring-up only version: board, power latch, panel, a test pattern, and touch logging
  - `PRO/scripts/flash.sh`
  - `PRO/test/test_tree_isolation.py`

**Interfaces:**
- Produces: `void pro_display_init(void)`, `bool pro_touch_read(int *x, int *y)`, `void pro_panel_draw_strip(int y, int h, const uint16_t *px)` in `PRO/main/display/pro_display.h`.
- Produces: `PRO/scripts/flash.sh [--build-dir DIR]` with exit status 2 on a MAC or revision mismatch.

- [ ] **Step 1: Write `test/test_tree_isolation.py`.** It walks `PRO/` and asserts:
  - no file contains the string `harness-device`, except docs that explain the split;
  - no `#include` names `ui_screens.h`, `lvgl.h`, `octopus`, `tim.h`, `tux.h`, `carry.h`, `visit.h` or `workspace.h`;
  - `main/CMakeLists.txt` lists no source outside `PRO/main`.
- [ ] **Step 2: Run it and expect FAIL** (the tree does not exist yet).
  - Run: `python3 devices/harness-pro/firmware/test/test_tree_isolation.py`
- [ ] **Step 3: Create the files above.** In `app_main.c`, keep SRC's power-latch order and the GT911 manual reset before the driver opens. Draw 8 vertical colour bars, and log each touch as `touch x=%d y=%d`.
- [ ] **Step 4: Verify the build.**
  - Run: `. ~/esp/esp-idf-5.5.4/export.sh && cd devices/harness-pro/firmware && idf.py -B build -DPROJECT_VER=0.0.99-pod -DPOD_PANEL_TURN=180 build`
  - Expected: `Project build complete`, no warnings from `main/`, and the app smaller than the 0x7E0000 slot.
- [ ] **Step 5: Run the isolation test and expect PASS.**
- [ ] **Step 6: Flash with `scripts/flash.sh`.**
  - Expected: the colour bars show on the panel, and `touch x=… y=…` lines appear in `~/.harness/logs/usb-E8-F6-0A-E7-63-7D/` on taps.
- [ ] **Step 7: Commit** (only if asked).

### Task 2: Font generator with a committed fallback

**Files:**
- Create:
  - `PRO/scripts/gen_fonts.py`, ported from SRC's `../prototype/pro-companion/tools/generate_fonts.py` and reduced to the `ht_pro_24`, `ht_pro_32` and `ht_pro_42` atlases
  - `PRO/fonts/LiberationSans-Regular.ttf` and `PRO/fonts/LICENSE-LiberationSans.txt`
- Modify: `PRO/main/CMakeLists.txt` so it generates `${CMAKE_BINARY_DIR}/pro_fonts.c` at build time
- Modify: `.gitignore` to ignore any `pro_fonts.c` under `devices/harness-pro`
- Test: `PRO/test/test_fonts.py`

**Interfaces:**
- Produces: `python3 scripts/gen_fonts.py --font PATH --out FILE`. It defaults to `/System/Library/Fonts/Helvetica.ttc` index 0 when that file exists, otherwise to `fonts/LiberationSans-Regular.ttf`. It emits `ht_pro_24`, `ht_pro_32` and `ht_pro_42` with the same `ht_pro_font_t` layout as SRC's `pro_fonts.c`.

- [ ] **Step 1: Write `test_fonts.py`.** It generates fonts with Liberation Sans into a temp directory and asserts:
  - the three symbols exist;
  - `height` is 24/32/42;
  - every codepoint SRC's `pro_fonts.c` covers is present, including Vietnamese precomposed and `·`;
  - the file has no `Helvetica` string.
- [ ] **Step 2: Run it and expect FAIL.**
- [ ] **Step 3: Implement `gen_fonts.py`.**
- [ ] **Step 4: Run it and expect PASS.** Also run `idf.py build` (it now builds with Helvetica on this Mac).
- [ ] **Step 5: Commit** (only if asked).

### Task 3: Compositor and Pod, with host tests

**Files:**
- Copy:
  - SRC's `main/ui/habitat/{terminal.c,terminal.h,pro_canvas.c,pro_canvas.h,fonts.c,scroll.c,scroll.h,theme.h}` → `PRO/main/display/`
  - `main/ui/habitat/pod/*` → `PRO/main/pod/`
  - `display_habitat.c` → `PRO/main/display/pro_frame.c`
- Copy tests:
  - SRC's `test/test_pod_{model,nav,draw,pet,assets,views_agent,views_tabs}.c`, `test/pod_render.{c,py}`, `test/pod_pet_ground.c`, `test/pod_pet_strip.c`, `test/host_stubs/` → `PRO/test/`
  - SRC's `scripts/pod_gen_logos.py`, `scripts/pod_sync_assets.sh` → `PRO/scripts/`. Rename `pod_sync_assets.sh` to `import_pets.sh`; it takes the round asset path as an argument and has no default.
- Create: `PRO/test/run.sh`
- Test: `PRO/test/test_render_parity.sh`

**Interfaces:**
- Consumes: fonts from Task 2.
- Produces: `PRO/test/run.sh`, which needs no arguments, exits 0 on success and generates fonts into its temp directory.
- Produces: the compositor API is unchanged: `ht_scene_t`, `ht_run_t`, `ht_pro_text`, `ht_pro_rect`, `ht_pro_width`, `ht_rgb`, `ht_pro_raster`.

- [ ] **Step 1: Write `test_render_parity.sh`.** For each screen in `tabs tab:1 recent agent:fw recap:desk talk:fw talk:cur chrome:talk`, it renders with SRC's `pod_render.py` and with PRO's, both with `--now 600` and Liberation fonts, and asserts the PPM bytes are equal.
- [ ] **Step 2: Write `run.sh`.** Base it on SRC's `run-pod.sh`, keeping the cflags, the frame guards (1024 for `pod_model.c`, `pod_nav.c` and `pod_glue.c`; 4096 for the draw, pet, chrome and view files) and UBSan. It drops `-DDEVICE_PRO_COMPANION` and `-DDEVICE_POD`. Run it and expect FAIL, because the sources are not copied yet.
- [ ] **Step 3: Copy the files and fix the include paths.** In `terminal.c` and `terminal.h`:
  - remove the mono, arc, shimmer and sprite paths and the `DEVICE_TIM_ILLUSTRATED` field;
  - keep `pro_kind`, `radius`, `pro_height`, `pro_font` and `bitmap`;
  - make the Pro fields unconditional and delete every `#ifdef DEVICE_PRO_COMPANION` and `DEVICE_POD`.
- [ ] **Step 4: Run `bash test/run.sh` and expect PASS.** The test tails match SRC's (for example `Pod model: PASS`, `test_pod_views_agent: … checks passed`, `test_pod_views_tabs: … checks ok`). Then run `bash test/test_render_parity.sh` and expect all screens equal.
- [ ] **Step 5: Re-run `test_tree_isolation.py` and `idf.py build`.**
- [ ] **Step 6: Commit** (only if asked).

### Task 4: Inventory of the Pod hooks

**Files:**
- Create: `devices/harness-pro/docs/port-inventory.md`

**Interfaces:**
- Produces: a table with one row per `#ifdef DEVICE_POD`, `#ifndef DEVICE_POD` and `DEVICE_PRO_COMPANION` section in SRC's:
  - `main/ui/habitat/ui_habitat.c` (34 `DEVICE_POD` sections and the Pro sections);
  - `main/cable_client.c` (5);
  - `display_habitat.c`, `touch_habitat.c`, `terminal.h`, `pro_canvas.c`;
  - `app_main.c`.

  Each row gives the file and line, what the section does, and its destination: a `pro_app_*` or `pro_cable` function, or "not needed" with the reason.

- [ ] **Step 1: List them all.**
  - Run: `grep -n "DEVICE_POD\|DEVICE_PRO_COMPANION" SRC/main/ui/habitat/ui_habitat.c SRC/main/cable_client.c SRC/main/ui/habitat/display_habitat.c SRC/main/ui/habitat/touch_habitat.c SRC/main/app_main.c`
- [ ] **Step 2: Write the table.** These rows must appear:
  - `pod_new_turn` (only a new turn resets the clock);
  - the `verb` feed from the footer word versus the `activity` feed from `action`;
  - `ui_project_step` (only into a WORKING agent);
  - `pod_ui_focus` timing (quiet for 4 s after a touch, except a 0.8 s echo on Tabs);
  - `A_VOICE` value 9 and `pod_voice_block_reason`;
  - the library sweep;
  - the clock and wake;
  - `talk_over` and `unsend`;
  - recap scroll emit;
  - the 180° touch turn;
  - PSRAM scenes.
- [ ] **Step 3: Owner check.** Show the table and get the owner's yes before starting Task 5.

### Task 5: `pro_cable`, the Pro's cable client

**Files:**
- Copy: SRC's `main/{cable_link,cable_frame,cable_json_guard,cable_features}.c/.h` → `PRO/main/cable/`
- Create: `PRO/main/cable/pro_cable.c/.h`, written from SRC's `cable_client.c` and keeping only the messages below
- Create: `PRO/main/pro_app_api.h`, the callbacks `pro_cable` calls
- Test: `PRO/test/test_pro_cable.c` (a host build against cJSON from `$IDF_PATH/components/json/cJSON` and a recording stub of `pro_app_api.h`)
- Test: `PRO/test/test_pro_hello.py`, ported from `test_pod_hello.py` to target `pro_cable.c`

**Interfaces:**
- Produces, in `pro_app_api.h` (implemented by Task 6, stubbed in tests):
  - `void pro_app_link(bool up, const char *machine)`
  - `void pro_app_agents(const pro_agent_row_t *rows, int n)`, where a row has `id`, `name`, `engine`, `machine` and `status`
  - `void pro_app_swarms(const cable_swarm_t *items, int n, const cable_swarm_members_t *members, const char *selected)`
  - `void pro_app_library(const pod_library_row_t *rows, int count, int offset, int total)`
  - `void pro_app_context(const char *id, const char *machine, const char *project, const char *branch, const char *engine)`
  - `void pro_app_turn(const char *id, const char *kind, const char *text, int elapsed_s)`, where kind is one of started, verb, activity, step, done or error
  - `void pro_app_summary(const char *id, const char *text, const char *recap, const char *full, bool restore)`
  - `void pro_app_question(const char *id, const char *text)` and `void pro_app_question_close(const char *id)`
  - `void pro_app_focus(const char *id)`
  - `void pro_app_voice_result(int kind, const char *text)`
  - `void pro_app_machines(...)`, with the same shape as SRC's `ui_machines_replace`
- Produces: `void pro_cable_start(void)` and `bool pro_cable_send(const char *type, cJSON *payload)`. The hello carries:
  - `proto` (`CABLE_PROTO_VERSION`)
  - `board: "pro"`
  - `swarms: "members-v1"`
  - `recap: "long-v1"`
  - `activity: "steps-v1"`
  - `player: "library-v1"`

  It carries none of the round's `carry`, `draft`, `form`, `visit`, `workspace`, `selection` or `metrics` keys.
- `turn.activity` mapping: `text` goes to kind `verb` (when non-empty), `action` to kind `activity` (when present), and `step` to kind `step` (when non-empty).

- [ ] **Step 1: Write `test_pro_cable.c`.** It feeds framed JSON and asserts the recorded calls:
  - `pro_cable_test_turn_activity`: `{"t":"turn.activity","agentId":"a","text":"Infusing...","action":"Reading","step":"Read · x.c","elapsedSeconds":12}` gives three calls, `verb "Infusing..."`, `activity "Reading" 12` and `step "Read · x.c"`, in that order. An empty `text` gives no `verb` call.
  - `pro_cable_test_old_daemon`: `turn.activity` with only `text`, `summary` without `full`, and `swarms` without `members` each still reach `pro_app` (with `full=NULL` and `members=NULL`), and none crashes.
  - `pro_cable_test_oversize`: a 400-char `step` arrives cut at 120 bytes or less on a UTF-8 boundary, a 3000-char `full` is cut to fit the 2048 B recap, and a swarms list of 64 items over the cap ends without a loop.
  - `pro_cable_test_ignores_round`: `carry.state`, `draft.state` and `visit.state` frames make no call.
- [ ] **Step 2: Write `test_pro_hello.py`.** It asserts the hello keys above exactly, and that `carry` and `draft` are absent.
- [ ] **Step 3: Add both to `run.sh`, run it, and expect FAIL.**
- [ ] **Step 4: Implement `pro_cable.c`.** It runs on the `cable_link` task with a 6 KB stack. Parse into static scratch, not stack locals over 1 KB (the frame guard is 1024 B). There is a stack test in `test_pro_cable.c`: run the parser on a thread with a 6 KB stack.
- [ ] **Step 5: Run `bash test/run.sh` and expect PASS.**
- [ ] **Step 6: Commit** (only if asked).

### Task 6: `pro_app`, the app layer

**Files:**
- Copy: SRC's `main/ui/habitat/{pod_glue.c,pod_glue.h,pod_turn.h,touch_habitat.c}` → `PRO/main/app/`. `touch_habitat.c` keeps only the Pod path and is renamed `pro_touch.c`.
- Create: `PRO/main/app/pro_app.c/.h`, which implements `pro_app_api.h` and every Task 4 row whose destination is `pro_app`
- Modify: `PRO/main/app_main.c` to start the display, `pro_app_start()` and `pro_cable_start()`
- Test: `PRO/test/test_pro_app.py`, ported from `test_pod_touch_ui.py` to compile `pro_app.c`, `pod_glue.c` and `pro_touch.c` with host stubs

**Interfaces:**
- Consumes: `pro_app_api.h` (Task 5); `pod_ui_*` from `pod_glue.h`; `ht_*` (Task 3); `pro_display.h` (Task 1).
- Produces:
  - `void pro_app_start(void)`, which starts the render task (24-line strips, damage by `memcmp`, scenes in PSRAM);
  - `void pro_app_lock(void)` and `void pro_app_unlock(void)`;
  - `void pro_app_touch(bool down, int x, int y)`.

- [ ] **Step 1: Port the replays into `test_pro_app.py`.** Keep every test from `test_pod_touch_ui.py`, each with its name. Add:
  - `pro_app_test_link_drop`: start a library sweep, call `pro_app_link(false, NULL)`, and assert `pod_ui_sweeping()` is false. After `pro_app_link(true, …)`, the next sweep restarts from offset 0.
  - `pro_app_test_step_after_done`: a `step` after `done` leaves the agent DONE.
  - `pro_app_test_new_turn_only`: `started` twice for the same live turn resets the clock once (the `pod_new_turn` rule).
  - Run every replay upright and with `-DPOD_PANEL_TURN=180`.
- [ ] **Step 2: Run it and expect FAIL.**
- [ ] **Step 3: Implement `pro_app.c`.** Follow the Task 4 rows. Use one mutex (the display lock) around every `pod_ui_*` call and around the render.
- [ ] **Step 4: Run `bash test/run.sh` and `python3 test/test_pro_app.py`, and expect PASS.** Run `idf.py build`.
- [ ] **Step 5: Flash.** The branch daemon (0.3.73-dev, from podwt) is what is installed now.
  - Expected in the device log: `session up`, no `PANIC` and no `Guru`.
  - On screen: Tabs with Working ribbons, the Tab list, an Agent with its LCD verb and steps, Recap, focus following the app, and a swipe moving panes.
- [ ] **Step 6: Commit** (only if asked).

### Task 7: Voice and notices

**Files:**
- Copy: SRC's `main/{audio_capture,audio_client,voice_buffer,ptt}.c/.h` and `audio_client_habitat.c` (rename it `pro_voice.c`) → `PRO/main/audio/`
- Modify: `PRO/main/app/pro_app.c` for the voice gate, the recording lifecycle, send/unsend, `talk_over` and notices
- Test: `PRO/test/test_pro_voice_gate.py`, ported from `test_pod_voice_gate.py`

**Interfaces:**
- Consumes: `pro_app_voice_result` (Task 5); `pod_ui_talking`, `pod_ui_talk_over`, `pod_ui_unsend` and `pod_ui_notice` (`pod_glue.h`).
- Produces: `void pro_voice_begin(const char *agent_id)`, `void pro_voice_end(bool send)` and `const char *pro_voice_block_reason(void)`. The reasons are `offline_machine`, `busy_cable`, `not_connected` and `library_only`, with the same copy as SRC.

- [ ] **Step 1: Port the 9 replays.** Keep each name, and keep A_VOICE value 9. Add `voice: link drop ends talk`: dropping the link while TALK is on top returns to the previous view and aborts the recording.
- [ ] **Step 2: Run them and expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and expect PASS.** Build and flash. On the device, record to a Claude agent and see it arrive in the pane.
- [ ] **Step 5: Commit** (only if asked).

### Task 8: Daemon support on main, behind capabilities

**Files:**
- Create: `devices/harness-pro/docs/cable.md` with the capability table and field shapes
- Modify (under `cli/src/`):
  - `cable/cableSession.ts`: parse the four capabilities from the hello, and send members/agentIds, `full`, `action`/`elapsedSeconds`/`step`, and `player.library`/`player.context` only when they are named
  - `cable/cableHost.ts`: `cableStepFor` and `activitySnapshot` with `action`
  - `cable/cableFleet.ts`: `turnStep`
  - `cli.ts`: the step tee and the `activitySnapshot` wiring
  - `lib/deviceRecap.ts`: `deriveLongRecap`
  - `cable/playerLibrary.ts`: the library pages
- Test: `cli/src/cable/cableSession.spec.ts`, `cableHost.spec.ts`, `playerLibrary.spec.ts` and `lib/deviceRecap.spec.ts`

**Interfaces:**
- Consumes: the Pro's hello from Task 5.
- Produces, on the wire:
  - `turn.activity {agentId, text, action?, elapsedSeconds?, step?}`
  - `summary {…, full?}`
  - `swarms` items `{…, agentIds?, members?}`
  - `player.library {offset, total, rows[6]}` and `player.context {agentId, machine, project, branch, engine, remaining}`

- [ ] **Step 1: Inventory.** Diff `cli/` and `desktop/` between `git merge-base` and 0c73edf72. In `cable.md`, list every message or field Pod consumes (from `pro_cable.c`) next to its source on the branch. Mark creature voice, `cableSpeech` and Player overview as not ported.
- [ ] **Step 2: Write the failing specs:**
  - `round hello gets no Pro fields`: a hello without capabilities, then a turn with tools, a summary and a swarms change, gives frames identical to today's. That means no `step`, no `action`, no `full`, no `members` and no `player.*`.
  - `pro hello gets steps`: `activity:"steps-v1"` plus a tool card gives `turn.activity` with `step: "Read · cableSession.ts"`.
  - `pro hello gets full recap`, `pro hello gets members`, and `pro hello gets the library` (6 rows a page).
  - Port the branch's existing specs for these features.
- [ ] **Step 3: Run them and expect FAIL.**
  - Run: `cd cli && npx vitest run src/cable src/lib/deviceRecap.spec.ts`
- [ ] **Step 4: Implement the port.** Desktop changes go in only if Step 1 shows Pod needs them (for example the swarms announce). Then add the matching desktop test.
- [ ] **Step 5: Run the checks and expect PASS.**
  - Run: `cd cli && npx vitest run src/cable src/lib/deviceRecap.spec.ts && npx tsc --noEmit -p . && npm run test:harnessd`. If desktop was touched, also run `cd desktop && flutter test test/dial_swarms_announce_test.dart`.
- [ ] **Step 6: Device acceptance against main's daemon.**
  - Install this branch's CLI: `bash cli/scripts/install-cli.sh --no-restart`, then `harness start`.
  - Flash the Pro and walk the spec's Acceptance list: tool steps, recap, offline members, library, focus, voice.
  - Record the result in the PR.
- [ ] **Step 7: Commit** (only if asked).

### Task 9: CI, README and the split's guard

**Files:**
- Modify: `.github/workflows/ci.yml`, job `firmware-checks`, adding a step after the round's contracts:
  ```
  bash devices/harness-pro/firmware/test/run.sh
  python3 devices/harness-pro/firmware/test/test_pro_app.py
  python3 devices/harness-pro/firmware/test/test_pro_voice_gate.py
  python3 devices/harness-pro/firmware/test/test_tree_isolation.py
  ```
  It uses the same clang-18 and cJSON setup as the existing job.
- Modify: `scripts/tests/test_ci_plan.py`, adding a case that a change under `devices/harness-pro/` selects `firmware`.
- Create: `devices/harness-pro/README.md`, covering build, flash (`scripts/flash.sh`, with the power-latch warning), the host tests, fonts, `import_pets.sh` and the capability contract. It links `docs/cable.md` and the spec.
- Move: the Pod mockups from SRC's `mockup/` (`pro-*.html`, `pro_*.py`, `pro-*/`) to `devices/harness-pro/mockup/`. That directory is gitignored (`.gitignore` line 107, `mockup/`), so the move is local only.

- [ ] **Step 1: Add the ci-plan test case, run it and expect FAIL** if the planner does not already map the path, otherwise PASS as is.
  - Run: `python3 scripts/tests/test_ci_plan.py`
- [ ] **Step 2: Add the CI step and the README.**
- [ ] **Step 3: Check the split.**
  - Run: `git diff origin/main --stat -- devices/harness-device`. Expected: empty.
  - Run: `python3 devices/harness-pro/firmware/test/test_tree_isolation.py`. Expected: PASS.
- [ ] **Step 4: Open the PR and merge.** Push, open a draft PR, then mark it ready. When `ci/required` is green and the review is done, run `make merge-pr ARGS="N --reviewed-head SHA --reviewed-base SHA --merge"`. The PR body records the local checks from Tasks 6–8 and the device acceptance.
