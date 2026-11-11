# Round dial firmware: dead-code audit (read-only)

Tree: `devices/harness-device/` at `d18648f46` (main), worktree `.claude/worktrees/swarmread`. Nothing was
edited. Paths below are relative to `devices/harness-device/firmware/` unless they start with
`devices/`, `cli/`, `desktop/`, `docs/`, `samples/`, `.github/` or `prototype/`.

How it was checked:
- `git grep` across the whole repo for every file name, symbol, flag and asset path: `.github/workflows`,
  `Makefile`, `scripts/`, `cli/`, `desktop/`, `backend/`, `docs/`, `samples/`, `devices/harness-pro`,
  the READMEs and AGENTS files, plus the firmware's own scripts and tests.
- Build list: `main/CMakeLists.txt` (`BOARD_SRCS` and every `target_sources` behind a flag).
- Tests: `test/run.sh` (local only, through `make device-test`, `Makefile:128`) and **CI**:
  `.github/workflows/ci.yml:556` runs every `test/test_*.py` by glob. CI does **not** run `run.sh`'s C
  tests. A `test_*.py` file is therefore CI-live even when `run.sh` doesn't list it (for example
  `test_layout_bench.py`).
- Python tests that cut C out of the sources by name or by marker string (`test_touch_ui.py:12`,
  `:55`, `:226`, `:246-254`, and others). I checked every `index()`/`split()` marker in `test/*.py`
  against the dead ranges below. No marker falls inside one.
- Unused functions: a scanner over every `BOARD_SRCS` file, repeated until nothing new turned up, so
  a function whose only callers are dead counts as dead too. Macro uses in headers count as uses. That
  rule caught `display_lock_at`, which looks unused but is called through
  `#define display_lock()` (`main/ui/display.h:22`). It is LIVE.
- Ran (read-only, temp dirs): `test/test_layout_bench.py`, `test/test_cable_transport.py` and
  `test/test_companions.py` all PASS. `scripts/gen_octopus.py --check` **FAILS** on current main
  (see D15). Not run: ESP-IDF builds, and so none of the `DEVICE_*` bench builds.

---

## Summary table

| # | Item | Verdict | Size | Evidence (short) |
|---|---|---|---|---|
| D1 | `main/audio_client.c` | DEAD | 15,222 B / 326 lines | Not in CMake. Replaced by `audio_client_habitat.c` (`CMakeLists.txt:35`). The only reference is prose in `docs/UI_FLOWS.md:81` (D6). |
| D2 | `main/ui/touch_ctrl.h` | DEAD | 960 B / 19 lines | Nothing includes it and nothing defines `touch_ctrl_open`/`_name` in this tree. The Pro keeps its own copy (`devices/harness-pro/firmware/main/display/touch.h:11`). |
| D3 | `main/ui/metrics_round466.h` + `main/ui/ui_metrics.h` | DEAD | 10,259 B / 140 lines | None of the 53 `#define`s is used outside the file. `RECAP_LINES`/`WAVE_PITCH_X10` in `focus.c:53,602` are focus.c's own enums, and focus.c does not include the header. `UI_DESK_GRID` (=0) only gates a dead declaration in `ui_screens.h:195`. |
| D4 | `main/provisioned_config.h.example` + `DEVICE_FORCE_PROD` / `DEVICE_BACKEND_URL` CMake blocks | DEAD | 1,035 B + 14 CMake lines + 5 .gitignore lines | No source includes `provisioned_config.h`. No `.c`/`.h` reads `DEVICE_FORCE_PROD`, `DEVICE_PROD_BACKEND_URL` or `DEVICE_FORCE_CONFIG` (searched `main/` and `test/`: exit 1). These are Wi-Fi/backend leftovers. |
| D5 | `screen.html`, `device-stages.html` | DEAD | 57,030 B / 818 lines | No references anywhere. They mock the LVGL "Commander" screens ("device tokens … from ui_screens.c"). |
| D6 | `docs/` (INTERNAL_RAM_OPTIMIZATION.md, UI_FLOWS.md, UI_REDESIGN.md) | DEAD | 52,743 B / 1,147 lines | No references anywhere. They describe LVGL, `ui_screens.c`, `commander_client.c`, `touch.c` and `lv_mem_core_builtin.c`, none of which exist. |
| D7 | `tools/generate_engine_icons.py` (the whole `tools/` dir) | DEAD | 5,085 B / 104 lines | No references. It writes `main/ui/icons_engine.c` (deleted) from the retired `autonomous-code` repo. |
| D8 | `scripts/gen_fonts.sh` + `fonts/Geist-Medium.ttf` + `fonts/Geist-SemiBold.ttf` | DEAD | 148,895 B | No references to the script. It writes the LVGL `main/ui/geist_*.c` faces (deleted). The two TTFs are read only by this script. |
| D9 | `assets/sparkle.png` | DEAD | 369 B | `gen_habitat_fonts.py:127` reads only `sparkle_fill.png`. The only mention is `assets/README.md:7`. |
| D10 | `prototype/habitat/assets/GeistMono-Regular.ttf` | DEAD | 69,936 B | Byte-identical to `fonts/GeistMono-Regular.ttf` (`cmp`). No script reads the prototype path. Both generators read `fonts/` (`gen_habitat_fonts.py:11`, `gen_character_fonts.py:9`). |
| D11 | 83 unused functions in compiled files | DEAD | 413 lines / ~12.3 KB in `.c`, plus ~230 declaration+comment lines in headers | Each has no caller in `main/` or `test/` (C, Python, sh), and none is used through a header macro. List below. |
| D12 | Never-defined declarations in `ui_screens.h` (`ui_desk_open/close/is_open`, `ui_notif_band_top_px`, `ui_tiles_replace`) + `cable_tile_t`/`SWARM_TILES_MAX` | DEAD | ~45 lines | Declared, never defined, never called. These are desk-grid (Pro) leftovers. |
| D13 | Unused `#define`s and enum values | DEAD | ~25 lines | `config_store.c:183-193` (`K_CID`, `K_MQ*`, `K_FACH`, `K_FDCH`); `pins_dial.h:9-11` (`BSP_LCD_H_RES/V_RES/BIT_PER_PIXEL`); `board.h:18-20` (`TOUCH_GT911`, Pro); `octopus.h:9-10` (`HT_OCTOPUS_BRIEF_Y`… four values); `ui_screens.h:19-28` (`AGENT_CTL_CHIPS`, `AGENT_EFFORT_CHIP`); `power.c:13` (`AXP_REG_STATUS0`, dead once D11 lands); `fw_update.c:24` (`PROGRESS_EVERY`). |
| D14 | `ht_icon_engine28[14]` and `ht_icon_mic` in the generated `lvgl_icons.c` | DEAD (firmware) | ~103 KB of source (29 + 3 lines) | Nothing in firmware uses them. `ht_icon_mic` appears only in a negative assert (`test/test_touch_ui.py:3588`). Removal needs a generator edit too. |
| D15 | Pro-only octopus atlases still in `gen_octopus.py` (`PRO_ONLY`, `HT_FACE_PX >= 720`) and `HT_FACE_PX` / `DEVICE_HABITAT` test leftovers | DEAD (stale generator/test code) | ~15 lines | `gen_octopus.py --check` currently FAILS. It regenerates `ht_octopus_font_14/16` under `#if HT_FACE_PX >= 720`, which were hand-removed from `octopus_font.c`. `HT_FACE_PX` is defined nowhere. |
| D16 | `ht_pixel_40` + `ht_lock_dot` (generated `fonts.c`) + `prototype/habitat/assets/unscii-8.ttf` | DEAD (firmware), medium confidence | ~124 KB of fonts.c source + 293,712 B TTF | No firmware user, only `test/test_terminal.c:37,91,276-286`. Unscii-8 is the input for exactly these two faces (`gen_habitat_fonts.py:12,40,42`). Removal changes fonts.c and the generator (see Risks). |
| D17 | Stale `idf_component.yml` and lock content | DEAD comments; DEAD-needs-build-check dependency | ~16 lines + 10 lock lines | Lines 9-14 comment on an LVGL dependency that is gone. Lines 42-44 describe libsodium/`main/e2ee/e2ee_core.c`, which don't exist. `espressif/esp_websocket_client` (lines 35-41, "used by commander_client.c") is included by no source. |
| D18 | Stale `.gitignore` / top-level CMake / header comments about two boards, the Pro and LVGL | DEAD text | ~40 lines | See section D18. |
| O1 | `DEVICE_PERF_BENCH` (ui_perf.c, audio_probe.c, ui_perf.h, hooks) | OPTIONAL-TOOL | ~300 lines | Compiled always but `#ifdef`-empty. `audio_probe.h` is LIVE in normal builds: lines 10-13 map `audio_stream_*` to `cable_client_voice_*`. |
| O2 | `DEVICE_OCTOPUS_BENCH` (perf_bench.c/h) + `scripts/analyze_octopus_perf.py` | OPTIONAL-TOOL | 12,901 B + 3,433 B | CMake:147-153. The script has no references but parses the bench's `OCTO_PERF` log (`perf_bench.c:23`). |
| O3 | `DEVICE_LAYOUT_BENCH` (layout_bench.c/h, scroll_bench.c, `DEVICE_LAYOUT_BASELINE`) + `scripts/analyze_layout_perf.py` | OPTIONAL-TOOL, CI-tested | 12,669 B + 5,347 B | `test/test_layout_bench.py` runs in CI via the glob and PASSES. `-DDEVICE_LAYOUT_BENCH=1` is also how 6 `run.sh` tests reach A/B hooks in terminal.c/octopus.c/ascii_clip.c (`run.sh:86,157,169,175,181,187`). |
| O4 | `DEVICE_TRANSPORT_BENCH` (transport_bench.c) + `scripts/analyze_transport_perf.py` | OPTIONAL-TOOL, CI-tested | 7,114 B + 2,468 B | `test/test_cable_crc.py:14` extracts CRC functions from `transport_bench.c` (CI, `IDF_PATH` set). |
| O5 | `DEVICE_CREATURE_GALLERY` (creature_gallery.c/h, creature_font.c, creature_art.inc, creature_clips.inc, gen_creature_*.py) | OPTIONAL-TOOL, tested | ~460 KB source | `run.sh:192-196`. `test/test_touch_driver.py:18,125` builds the production touch task against `creature_gallery.c`. |
| O6 | `DEVICE_RENDER_FAULT`, `DEVICE_RENDER_STRESS` | OPTIONAL-TOOL | hooks only, in display_habitat.c | CMake:217-229. Documented only in `prototype/habitat/README.md`. |
| O7 | `BOARD_PROBE` (board/board_probe.c/h) | OPTIONAL-TOOL | 4,286 B | CMake:170-176, `app_main.c:191`. The bring-up aid for hardware ports. |
| O8 | `DEVICE_HABITAT_ORANGE`, `DEVICE_ALL_SKINS`, `DEVICE_DEFAULT_CHARACTER` | OPTIONAL-TOOL | — | `theme.h`, `character.c:81-85`, `illustrated_cache.c`. Tests: `test_touch_ui.py`, `test_character_preferences.py`. Hackathon sample: `samples/hackathon-fo/01-fo-glance/`. |
| O9 | `scripts/flash-station.sh` | OPTIONAL-TOOL (unreferenced) | 8,487 B | A batch flashing script for manufacturing. No references. |
| O10 | `test/device_release_check.py` | OPTIONAL-TOOL (slightly stale) | 5,326 B | Documented in `prototype/habitat/RELIABILITY.md:18`. It passes `src/lib/summarize.spec.ts` to vitest, and `cli/src/lib/summarize.spec.ts` no longer exists. |
| O11 | `HT_UPDATE_ARC_GOLDEN` (test_arc_pixels.c), `import_tux_moods.mjs`, `fo_pet.py`, `gen_*` without `--check` | OPTIONAL-TOOL (regeneration) | — | Generators whose outputs are compiled. See the LIVE notes. |
| L1 | `assets/lvgl/SPEC.md` + `scripts/gen_lvgl_assets.py` | LIVE | 3,279 B + 17,203 B | They generate the compiled `lvgl_fonts.c`/`lvgl_icons.c` (CMake:72-73), and `gen_focus_faces.py:34` imports the script. `terminal.h:55` points at SPEC.md. |
| L2 | `lvgl_fonts.c`, `lvgl_icons.c` (named LVGL, compiled) | LIVE | — | `ht_lv_montserrat_14/22` (`ui_habitat.c:1435,2586`), `ht_icon_engine20` (`ui_habitat.c:2564`, `focus.c:173`). Only the D14 parts are dead. |
| L3 | octopus/Tim, Tux, illustrated characters | LIVE | — | In the registry (`character.c:44-58`), selectable with `DEVICE_DEFAULT_CHARACTER` (CMake:134-140) and `DEVICE_ALL_SKINS`. The host protocol lists the species (`cli/src/cable/companionProtocol.ts:2`). |
| L4 | `assets/companions/` (4,764,750 B) | LIVE (pack is OPTIONAL) | 4.6 MB | Header always included (`illustrated.c:2`, `illustrated_cache.c:2`). Pack embedded when `DEVICE_ALL_SKINS` is set (CMake:103-107) and read by `test/test_companions.py:10`. Generated by `gen_companion_art.py`. |
| L5 | `assets/pets/` (3,051,068 B tracked) | LIVE | 3.0 MB | Inputs of `gen_pets.py`, which writes the compiled `pets.c`. `run.sh:19` runs `gen_pets.py --check`. |
| L6 | `assets/engines/*.png`, `assets/sparkle_fill.png` | LIVE | 5.1 KB | `gen_habitat_fonts.py:86,127`. |
| L7 | `test/reference48`, `reference79`, `reference91` | LIVE | 168 KB / 48 KB / 20 KB on disk | `run.sh:82,151`; `test_cable_transport.py:16` (reference91, run.sh:50 and CI); `test_layout_bench.py:13-14,77`; `test_arc_storage.c:4`. |
| L8 | `test/__pycache__` | not tracked | — | Untracked and ignored by `.gitignore:6` (`__pycache__/`). Nothing to delete in git. |
| L9 | `prototype/habitat/assets/creature-references/clips.json`, `assets/tux/*.json` | LIVE | 325 KB + 138 KB | `gen_octopus.py:22`, `gen_creature_clips.py:11`, `test_octopus_art.py:10`; `gen_tux_moods.py:9` (run.sh:18 `--check`), `import_tux_moods.mjs:9`. |
| L10 | other `fonts/` (GeistMono, Geist-Regular, Inter-*, NotoSansSymbols2, jgs7, the OFL texts) | LIVE | — | `gen_habitat_fonts.py:11,19`, `gen_character_fonts.py:9`, `gen_focus_faces.py:41,48-50`, `gen_octopus.py:93`, `gen_creature_font.py:20`. `OFL.txt` is Geist's license, and Geist-Regular stays. |
| L11 | `hardware/` | LIVE | — | Linked from the root `README.md:285,299-300`, and `hardware/README.md` covers every file. |
| L12 | `test/bridge_flow_replay.py`, `native_shapes.py`, `arc_pixels.inc`, `test_cable_transport.c`, `test_companions.c` | LIVE | — | Imported or compiled by other tests (`test_touch_ui.py:4472`, eight `test_*.py`, `test_arc_pixels.c:12`, `test_cable_transport.py:15`, `test_companions.py:26`). |
| U1 | `prototype/habitat/assets/creature-references/parrot.animation`, `stark-dragon.txt` | UNSURE | 7,018 B + 641 B | No script reads them. `clips.json` is canonical and builds need no originals (`CREATURE_GALLERY_02.md:51`). They may be kept as provenance for third-party ASCII art. |
| U2 | WiFi/TLS/HTTP/LWIP settings in `sdkconfig.defaults*` and unused `BOARD_REQUIRES` | UNSURE (likely dead, may change the image) | ~20 config lines + 8 REQUIRES | See Risks. |

---

## DEAD items: evidence and the edits that go with them

### D1. `main/audio_client.c`

- Evidence: it isn't in `BOARD_SRCS` or any `target_sources`. `git grep -F audio_client.c` finds only
  `docs/UI_FLOWS.md:81` (deleted in D6) and a historical Pro plan
  (`docs/superpowers/plans/2026-10-11-harness-pro-firmware.md:242`). Leave that plan alone; it is a
  record. The Python audio tests read `audio_client_habitat.c` (`test_audio_stream.py:9`,
  `test_audio_threads.py:14`). `audio_client.h` stays: 10 files include it.
- Edits with it: none in CMake or tests. Its unused `#define`s (`FLUSH_BUDGET_US` and the rest) go
  with it.

### D2. `main/ui/touch_ctrl.h`

- Evidence: `git grep touch_ctrl` finds only the file itself, the Pro's own declaration and definition
  (`devices/harness-pro/firmware/main/display/touch.h:11`, `touch_gt911.c:60`) and a Pro doc.
  `touch_habitat.c` doesn't include it.
- Edits with it: none.

### D3. `main/ui/metrics_round466.h`, `main/ui/ui_metrics.h`

- Evidence: `ui_metrics.h` is included only by `ui_screens.h:11`, and `metrics_round466.h` only by
  `ui_metrics.h:17`. I checked every `#define` in `metrics_round466.h` against `main/` and `test/`. Only
  three names appear anywhere else:
  - `WAVE_PITCH_X10` and `RECAP_LINES` are declared again as enums in `focus.c:53,602`. focus.c does
    not include this header; if it did, the `#define RECAP_LINES 2` would break that enum.
  - `UI_DESK_GRID` (0) is used only at `ui_screens.h:195`, around the dead `ui_notif_band_top_px`
    declaration.
- Edits with it:
  - `ui_screens.h:11`: drop `#include "ui_metrics.h"`.
  - `ui_screens.h:192-197`: drop the `#if UI_DESK_GRID … #endif` block.

### D4. `main/provisioned_config.h.example` and the backend flags

- Evidence: no source includes `provisioned_config.h`. `git grep
  "FORCE_PROD|PROD_BACKEND|BACKEND_URL|OTA_KEY|METADATA_URL|provisioned" -- main test` (outside CMake and
  the example) returns nothing. The firmware is USB-only (`README.md:7-9`).
- Edits with it:
  - `main/CMakeLists.txt:155-168`: remove the `DEVICE_FORCE_PROD` and `DEVICE_BACKEND_URL` blocks.
    The macros they define are read by no code, so the compiled output doesn't change.
  - `.gitignore:33-37`: remove the provisioning-secrets comment and the two
    `main/provisioned_config.h*` lines. Keep `build-prod/`; `upload-firmware.sh` and `flash-station.sh`
    use it.
  - `scripts/upload-firmware.sh:24-25,185-192` passes `-DDEVICE_FORCE_PROD=1`. That is harmless once
    the CMake block is gone: CMake only warns "Manually-specified variables were not used". It can be
    dropped with its comment, or left as is.
  - Docs: `prototype/habitat/README.md:47`, `CREATURE_GALLERY.md:89`, `TUX.md:159` and
    `docs/superpowers/plans/2026-10-28-round-dial-swarm-chat.md` mention `-DDEVICE_FORCE_PROD=1` in build
    commands. Those are historical and need no change.

### D5. `screen.html`, `device-stages.html`

- Evidence: zero references. Both are LVGL-era screen mockups ("Commander — Device Screens",
  "source of truth — from ui_screens.c").
- Edits with it: none. New mockups go in the gitignored `mockup/` (`.gitignore:40-42`).

### D6. `docs/` (all three files)

- Evidence: zero inbound references (`git grep "INTERNAL_RAM_OPTIMIZATION|UI_FLOWS|UI_REDESIGN|firmware/docs"`).
  Of the source files they cite, only `app_main.c`, `ptt.c`, `config_store.c` and `display.h` still
  exist. Missing: `ui_screens.c`, `touch.c`, `commander_client.c`/`.h`, `display.c`,
  `lv_mem_core_builtin.c`. `UI_REDESIGN.md:3` says it was "Not implemented".
- Edits with it: none. The `build-arm` example in `INTERNAL_RAM_OPTIMIZATION.md:86` is the only user of
  `.gitignore:31` (see D18).

### D7. `tools/generate_engine_icons.py`

- Evidence: zero references. `TARGET = …/main/ui/icons_engine.c`, which was deleted with LVGL. It reads
  `../autonomous-code/apps/web/public/engine-icons`, which is retired. The 20 px marks now come from
  `gen_lvgl_assets.py` (git history at a pinned revision) and the 56 px marks from `gen_focus_marks.py`.
- Edits with it: remove the empty `tools/` directory.

### D8. `scripts/gen_fonts.sh`, `fonts/Geist-Medium.ttf`, `fonts/Geist-SemiBold.ttf`

- Evidence: `gen_fonts.sh` has zero references. It writes `main/ui/geist_<tag>_<size>.c` with
  `--format lvgl --lv-include lvgl.h` ("Exactly the five faces ui_screens.c references"), and none of
  those files exists. `Geist-Medium.ttf` and `Geist-SemiBold.ttf` are read only by it (lines 18-19).
- Keep `fonts/Geist-Regular.ttf` (`gen_habitat_fonts.py:19`, the Vietnamese faces) and `fonts/OFL.txt`,
  which is its license.

### D9. `assets/sparkle.png`

- Evidence: only `assets/README.md:7` mentions it. `gen_habitat_fonts.py:127` opens
  `sparkle_fill.png` only.
- Edits with it: `assets/README.md:7-9`: change the heading and text to cover `sparkle_fill.png` only.

### D10. `prototype/habitat/assets/GeistMono-Regular.ttf`

- Evidence: `cmp` shows it is identical to `fonts/GeistMono-Regular.ttf`. No path in the repo points at
  `prototype/habitat/assets/GeistMono`. The "browser" prototype that used it is gone.
- Edits with it: `prototype/habitat/FONTS.md:3` says "The browser and firmware generator use the
  vendored TTF". Change it to point at `firmware/fonts/`.

### D11. Unused functions in compiled files (83)

None of these has a caller in `main/` or `test/`, in C, Python or shell. None is used through a header
macro or a function pointer, and none appears in `samples/`. The Pro's own copies (`devices/harness-pro`)
are separate code. Entries marked † are dead only because their sole callers are in this list. Line
ranges are at `d18648f46`.

| File | Functions (start line) | Lines |
|---|---|---|
| `main/ui/habitat/ui_habitat.c` | `habitat_is_voice_view` 4147; `ui_project_fill_missing_engine` 4550; `ui_project_has_event` 4656; `ui_project_is_busy` 4664; `ui_project_set_busy_tokens` 4767; `ui_project_set_tool` 4775; `ui_project_set_todos` 4793; `ui_project_set_agents` 4814; `ui_cancel_acked` 4836; `ui_report_active_agent` 4924; `ui_get_active_project_index` 4934; `ui_get_active_project_id` 4941; `ui_get_active_session_id` 4942; `ui_is_projects_active` 4943; `ui_reader_is_open` 4947; `ui_picker_is_open` 4948; `ui_switch_is_open` 4949; `ui_notif_pull_zone_px` 4956; `ui_action_hit` 4957; `ui_swipe_begin` 4963; `ui_swipe_end` 4964; `ui_home_overview`† 4973; `ui_tap` 4979; `ui_notif_close`† 4992; `ui_notif_is_open` 4999; `ui_notif_pill_hit` 5000; `ui_notif_swipe_up` 5006; `ui_show_machines` 5810; `ui_machines_refresh` 5890; `ui_selected_machine_is_local` 5896; `ui_scroll_is_reversed` 5910; `ui_take_portal_req` 5911; `ui_take_wifi_retry_req` 5912; `ui_set_creating` 5913; `ui_show_connecting` 6281; `ui_enter_remote_offline` 6282; `ui_enter_link_guide` 6286; `ui_leave_remote_offline_loading` 6292; `ui_leave_error_screen` 6293; `ui_show_pairing` 6294; `ui_show_e2ee_pair` 6299; `ui_show_e2ee_paired` 6304; `ui_show_unpaired` 6305; `ui_voice_is_recording` 6325; `ui_voice_is_active` 6326; `ui_voice_start_tick` 6327; `ui_voice_start` 6328; `ui_voice_start_goal` 6337; `ui_voice_stop` 6346; `ui_voice_quota_status` 6384; `ui_voice_quota_exceeded` 6388; `ui_stop_active_turn` 6393; `ui_lock_init_gate` 6429; `ui_lock_setup` 6430; `ui_lock_active` 6431; `ui_log_state_if_changed` 6432 | 265 (56 functions) |
| `main/cable_client.c` | `cable_client_list_machines` 365; `cable_client_machine_id`† 379; `cable_client_list_swarms` 390; `cable_client_machine_name` 834; `cable_client_agent_total` 842; `cable_client_has_window` 851; `cable_client_list_agents` 876; `cable_client_counters` 1742 | 35 |
| `main/ram_telemetry.c` | `ram_telemetry_init` 50; `ram_psram_calloc` 69; `ram_psram_realloc` 80; `ram_psram_strdup` 87; static `cjson_psram_malloc`† 35; static `cjson_heap_free`† 45 (plus `static bool s_initialized`, line 20) | 47 |
| `main/board/power.c` | `power_battery_pct` 91; `power_is_charging` 108; `power_is_on_external` 113; static `axp_charge_state`† 102 (plus `AXP_REG_STATUS0`, line 13) | 22 |
| `main/config_store.c` | `config_load_swipe_reversed` 163; `config_save_swipe_reversed` 174 | 18 |
| `main/cable_link.c` | `cable_link_host_present` 261; `cable_link_counters` 268; `cable_link_reset_decoder` 276 | 15 |
| `main/ui/habitat/tim.c` | `ht_tim_portrait` 42 | 4 |
| `main/ui/habitat/display_habitat.c` | `display_init_ota` 494 (**not** `display_lock_at`: LIVE through `display.h:22`) | 1 |
| `main/ui/habitat/creature_gallery.c` (optional tool O5) | `ht_gallery_name` 42; `ht_gallery_mood` 47 (plus the static `moods` table that only they use) | 6 |

Edits that go with them:

- Remove the prototypes and their comments. Counts are approximate where a comment is shared:
  - `ui_screens.h`: 53 prototypes plus the five in D12, about 150 lines.
  - `cable_client.h`: about 22 lines.
  - `cable_link.h`: about 23 lines.
  - `display.h`: `display_init_ota`, line 12.
  - `power.h`: 3 prototypes.
  - `config_store.h:53-54`.
  - `ram_telemetry.h`: `ram_telemetry_init` and the three `ram_psram_*` prototypes, plus the
    orphaned "Mark LVGL ready…" comment at lines 9-10, whose function is already gone.
  - `runtime.h`: `habitat_is_voice_view`.
  - `tim.h`: `ht_tim_portrait`.
  - `creature_gallery.h`: `ht_gallery_name` and `ht_gallery_mood`.
- Remove the statics left unused after the cut. Otherwise `-Wunused-function` and `-Wunused-variable`
  fire, and the host tests build with `-Werror`:
  - `ram_telemetry.c`: `cjson_psram_malloc`, `cjson_heap_free` and `s_initialized`.
  - `power.c`: `axp_charge_state` and `AXP_REG_STATUS0`.
  - `creature_gallery.c`: `moods`.
- `ram_telemetry.c` keeps `s_json_fallback_count/bytes`. They are only written by the removed
  allocator and already always read 0. They still appear in log lines, so keep them to leave log
  output unchanged.
- Comment references to remove alongside:
  - `ui_screens.h:353` ("swipe_reversed … the LVGL build honours it").
  - `docs/UI_FLOWS.md` (D6) mentions `ui_cancel_acked`, `ui_show_pairing` and `ui_voice_start`.
  - `cli/src/lib/commander.ts:242,453` mention `ui_project_set_agents`. These describe the old device,
    are outside the firmware and have no build effect. Leave them, or reword them in a host PR.
- Expected image effect: none. ESP-IDF links with `--gc-sections`, so unreferenced non-static functions
  are already dropped. Confirm with `idf.py size` before and after (see Risks).

### D12. Never-defined declarations and the desk-grid tile type

- `ui_screens.h:160-162` (`ui_desk_open/close/is_open`, with comment 157-159), `:196`
  (`ui_notif_band_top_px`, in the D3 `#if` block) and `:276-283` (`ui_tiles_replace` and its comment):
  there is no definition anywhere in the tree, and no caller.
- `cable_client.h:177-194`: the `cable_tile_t` comment block, `SWARM_TILES_MAX` and the typedef. Their
  only user is the dead `ui_tiles_replace` declaration.
- Pairs with the comment-only leftover at `cable_client.c:953-957` ("THE ROUND DIAL IS THE ONLY BUILD
  THAT SKIPS THIS … habitat on the Pro"). It is a dangling comment with no code under it.

### D13. Unused macros and enum values

| Where | What | Notes |
|---|---|---|
| `main/config_store.c:183-193` | `K_CID`, `K_MQHOST`, `K_MQPORT`, `K_MQUSER`, `K_MQPASS`, `K_FACH`, `K_FDCH` and the "SDS provisioning" comment | MQTT/Wi-Fi NVS keys. `config_clear_all` erases the whole namespace and doesn't name them. |
| `main/board/pins_dial.h:9-11` | `BSP_LCD_H_RES`, `BSP_LCD_V_RES`, `BSP_LCD_BIT_PER_PIXEL` | `HT_WIDTH`/`HT_HEIGHT` come from `terminal.h`. |
| `main/board/board.h:18-20` | `TOUCH_GT911` (the last enum value) and its "GT911 is the Pro's" comment; also the Pro sentences at `:49-50` | The other enum values are unchanged when the last one goes. |
| `main/ui/habitat/octopus.h:7-10` | the `HT_OCTOPUS_BRIEF_Y`/`READING_Y`/`BRIEF_TEXT_Y`/`READING_TEXT_Y` enum and its comment | The first enum (`HT_OCTOPUS_FRAMES`…) stays. |
| `main/ui/ui_screens.h:19-28` | `AGENT_CTL_CHIPS`, `AGENT_EFFORT_CHIP` and their comments | Never tested. They refer to `touch.c` and `ui_screens.c`. |
| `main/fw_update.c:24` | `PROGRESS_EVERY` | Never used. Keep the comment above it (lines 20-23): it documents the ACK-per-slice protocol rule. |

### D14. `ht_icon_engine28` and `ht_icon_mic` (generated `main/ui/habitat/lvgl_icons.c`)

- Evidence: `ht_icon_engine28` appears only in `terminal.h:77` and comments (`focus.h:35`).
  `ht_icon_mic` appears in `terminal.h:77` and `test/test_touch_ui.py:3588`, where it is used only to
  assert that the mic sprite is *not* drawn. Data: `engine28_*` is 29 lines / 91,380 B of source,
  `mic_*` is 3 lines / 11,984 B. The image already drops them through `--gc-sections`.
- Edits with it:
  - `scripts/gen_lvgl_assets.py:255-261`: stop emitting `engine28_*`, `ht_icon_engine28` and `mic`, and
    update the print at 263.
  - `assets/lvgl/SPEC.md:29,31`: drop the 27 px and microphone rows.
  - `lvgl_icons.c`: delete lines 10-59 (every other line is an `engine28_*` array) plus 61-64.
  - `terminal.h:76-77`: update the declaration and comment.
  - `focus.h:35`: update the comment.
  - `test/test_touch_ui.py:3588`: delete the assert or rewrite it without `ht_icon_mic`.
- Regenerating through the script needs an LVGL 9.5.0 checkout and git access to the 0.0.86 source
  revision. A hand edit plus a matching generator edit is enough.

### D15. Pro and `HT_FACE_PX` leftovers in a generator and tests

- `scripts/gen_octopus.py:90,101-102,106-107`: `PRO_ONLY = (14, 16)` and the `#if HT_FACE_PX >= 720`
  wrapping. `python3 scripts/gen_octopus.py --check` currently fails with "octopus_font.c is stale".
  Regenerating into a scratch dir showed the only difference is the two Pro atlases
  `ht_octopus_font_14/16`, 236 added lines; `octopus_art.inc` is identical. Fix: drop 14 and 16 from
  the height loop and remove `PRO_ONLY`. Output then matches the checked-in file, as checked by diff.
- `test/test_glyph_cache.c:22-28,65-70` and `test/test_raster_ascii.c:69-74`: the `#if HT_FACE_PX >= 720`
  branches never compile, and `HT_FACE_PX` is defined nowhere. Keep the `#else` arm.
- `test/bridge_flow_replay.py:32` and `test/test_audio_init.py:25`: `#define DEVICE_HABITAT 1`. The flag
  no longer exists (`main/CMakeLists.txt:14`), and no source tests it.
- `test/test_touch_driver.py:19-22`: the comment says the header "derives them from HT_FACE_PX". That is
  stale.

### D16. `ht_pixel_40`, `ht_lock_dot` and `unscii-8.ttf` (medium confidence)

- Evidence: neither font appears in `main/` outside `fonts.c` and the declarations (`terminal.h:54,108`).
  The lock screen they served is gone; the `ui_lock_*` functions in D11 are stubs.
  - Test users: `test/test_terminal.c:37` (a generic loop over fonts), `:91`, and `:276-286` (lock_dot
    equals pixel_40's 'o').
  - `prototype/habitat/assets/unscii-8.ttf` is read only by `gen_habitat_fonts.py:12`, and only for these
    two faces (`:40,42`, plus the special cases at `:63`).
  - The `ht_pixel_40` data runs from `fonts.c:3945` to `5847`, about 122 KB of source; `ht_lock_dot` is
    `fonts.c:5932-5954`.
- Edits with it:
  - `gen_habitat_fonts.py`: drop the `pixel` input and the two `fonts` entries, and simplify line 63.
  - `fonts.c`: remove the two blocks.
  - `terminal.h:54,108`: remove the declarations.
  - `test/test_terminal.c:37,91,276-286`: remove or retarget the uses.
  - Delete `unscii-8.ttf` (293,712 B).
  - `prototype/habitat/FONTS.md:4`: remove the Unscii line.
  - `gen_habitat_fonts.py:3`: update the docstring.
- Why medium: `fonts.c` is generated, and the script has no `--check` mode. It pins Pillow 12.2.0, while
  this machine has 12.1.1, so I couldn't confirm a regeneration is byte-identical. Hand-delete both
  blocks and the generator lines together.

### D17. `main/idf_component.yml` and `dependencies.lock`

- Lines 9-14: the LVGL dependency comment ("~9.5.0"…). The `lvgl/lvgl` entry is gone and the lock has
  no lvgl. DEAD text.
- Lines 42-44: a libsodium/E2EE comment for `main/e2ee/e2ee_core.c`. That file doesn't exist, and
  there is no libsodium entry. DEAD text.
- Line 20 ("→ LVGL pointer indev") and lines 3-5, 31-33 ("the two boards", "the Pro repeats"): stale
  wording.
- Lines 35-41: `espressif/esp_websocket_client` ("used by commander_client.c"). No source includes
  `esp_websocket_client.h`. It is likely dead, but removing it changes the resolved component set:
  `dependencies.lock:60-69` changes and the component leaves the build. **Verify with an ESP-IDF build
  and an `idf.py size` comparison** (Risks R1).
- `.gitignore:10-13` keeps the "LVGL 9.6.0" story as the reason the lock is tracked. That is history,
  not dead; reword if you like.

### D18. Stale text about two boards, the Pro and LVGL

Each of these is a comment or ignore line, with no behaviour.

- `.gitignore`:
  - `:2` ("one project now builds for two boards").
  - `:6-7` (`build.dial/`, `build.pro/`).
  - `:18-20` (".esp32p4 stay TRACKED"; that file doesn't exist).
  - `:25-30` (`sdkconfig.dial*`, `sdkconfig.pro*`).
  - `:31` (`build-arm`, only used by D6's doc).
  - `:40` ("before writing LVGL code").
  - No script in the repo creates `build.dial`, `build.pro` or `sdkconfig.dial/pro`. Removing these
    entries can make old local leftovers show as untracked; that is cosmetic.
- `CMakeLists.txt:34-38`: "TWO BOARDS, TWO SDKCONFIGS … `sdkconfig.pro`". The hash logic itself is
  LIVE.
- `sdkconfig.defaults.esp32s3:3,8`: "when the Pro left" and "LVGL object pool lives here". The comments
  only; the values are covered in U2.
- `main/ram_telemetry.h:9-13` (LVGL), `main/board/board_pins.h:6,12`, `main/board/board.h:3-4,18-19,49-50`,
  `main/board/board.c:82`, `main/app_main.c:53`, `main/device_mac.c:21-22`.
- `main/ui/habitat/display_habitat.c:62-63,190-197`: the ST7703 and DPI fence, and `ui/panel_pro.c`.
- `main/ui/habitat/terminal.h:293-294` ("native for the Pro's ST7703") and
  `character_motion.c:36`.
- `main/ui/touch.h`, `main/ptt.c`, `main/board/board_probe.c` and `ui_screens.h` cite `touch.c` and
  `display.c`, which no longer exist.
- `main/fw_update.h`, `scripts/upload-firmware.sh:4` and `test/test_fw_update.py` cite `ota.c`.
  `sdkconfig.defaults:21-24,30-31` cite `main/ota.c` and HTTP OTA download.
- `docs/` (D6) and `RELEASE.md` (Risks R4).

---

## OPTIONAL-TOOL items: who and what uses them

No workflow, Makefile target or host code builds or starts any of these. The only users are the tests
and docs named below.

- **O1 `DEVICE_PERF_BENCH`**
  - Code: `ui/ui_perf.c` (in `BOARD_SRCS`, whole body under `#ifdef`, 197 lines),
    `ui/ui_perf.h` (no-op inline stubs when off), `audio_probe.c` (93 lines, all under the `#ifdef`),
    `audio_probe.h`.
  - Hooks: `app_main.c:216`, `touch_habitat.c:130`, `audio_capture.c:291`.
  - `audio_probe.h` must stay even if the bench goes: its `#else` arm (`audio_probe.h:10-20`) is how
    `audio_client_habitat.c` reaches `cable_client_voice_*`.
  - Docs: `prototype/habitat/README.md`, `TUX.md`, `CREATURE_GALLERY.md`.
- **O2 `DEVICE_OCTOPUS_BENCH`** (requires PERF)
  - Code: `ui/habitat/perf_bench.c/h`.
  - Hooks: `display_habitat.c:298,380,390,416,421,426`, `ui_habitat.c:6434`, `character_motion.c:83`,
    `ui_perf.c:42,143`.
  - Consumer: `scripts/analyze_octopus_perf.py` (no inbound reference; parses `OCTO_PERF:` lines).
  - Test reference: `test/reference48/octopus.c.inc`. No test compiles `perf_bench.c`.
- **O3 `DEVICE_LAYOUT_BENCH`** and `DEVICE_LAYOUT_BASELINE`
  - Code: `layout_bench.c/h` and `scroll_bench.c`, plus the reference sources, wired in at
    `CMakeLists.txt:196-213`.
  - Tested in CI by `test/test_layout_bench.py` (not listed in `run.sh`; PASS).
  - The same macro is a test seam: `run.sh:86,157,169,175,181,187` compile with
    `-DDEVICE_LAYOUT_BENCH=1` to reach `ht_arc_fast_sampling` etc. (`terminal.h:273-279`,
    `octopus.h:12-14`, `ascii_clip.h:24-26`). Removing the bench means keeping or renaming those seams.
  - Consumer: `scripts/analyze_layout_perf.py` (no inbound reference; parses `layout-bench:`).
- **O4 `DEVICE_TRANSPORT_BENCH`**
  - Code: `transport_bench.c` and `test/reference91/cable_frame_ref.c` (`CMakeLists.txt:178-185`).
  - Tests: CI runs `test/test_cable_crc.py`, which extracts static CRC candidates from
    `transport_bench.c`. reference91 is also used by `test_cable_transport.py:16`.
  - Consumer: `scripts/analyze_transport_perf.py` (no inbound reference).
- **O5 `DEVICE_CREATURE_GALLERY`**
  - Code: `creature_gallery.c/h`, `creature_font.c`, `creature_art.inc`, `creature_clips.inc`.
  - Generators: `gen_creature_art.py`, `gen_creature_clips.py` (reads `clips.json`) and
    `gen_creature_font.py` (reads `fonts/jgs7.ttf`).
  - Hooks: `ui_habitat.c:19,2851,2960,3172,3821,4138,4150,4207,4324`, `audio_capture.c:124`.
  - Tests: `run.sh:192-196` (`test_creature_gallery.c`). `test/test_touch_driver.py:18,125` compiles the
    production touch task with the gallery, so removing it means rewriting that test (it runs in CI).
  - Docs: `prototype/habitat/CREATURE_GALLERY*.md`, `CREATURE_REFERENCES.md`, `FONTS.md:10`.
- **O6 `DEVICE_RENDER_FAULT` / `DEVICE_RENDER_STRESS`**: hooks only in `display_habitat.c:33-40,106,123,372-388`.
  No test. Docs: `prototype/habitat/README.md:47-51`.
- **O7 `BOARD_PROBE`**
  - Code: `board/board_probe.c/h`, hooked at `app_main.c:191-193`.
  - The tool for a "hardware port" (`README.md:49-53`), though the README doesn't mention the flag.
- **O8 skins and theme flags**: `DEVICE_HABITAT_ORANGE` (`theme.h`; `test_touch_ui.py`; the hackathon
  sample `samples/hackathon-fo/01-fo-glance/README.md:91`, whose `solution.patch` adds a sibling flag),
  `DEVICE_ALL_SKINS` / `HABITAT_FOCUS_ONLY` (`desktop/lib/devices/device_settings.dart:13`,
  `kDeviceCompanionSkins`), and `DEVICE_DEFAULT_CHARACTER` (`test/test_character_preferences.py`,
  `prototype/habitat/TUX.md:54`). These are product decisions that are parked, not dead.
- **O9 `scripts/flash-station.sh`**: zero references. It flashes a batch from `build-prod/` with
  esptool. Ask the owner whether manufacturing still uses it.
- **O10 `test/device_release_check.py`**: documented in `prototype/habitat/RELIABILITY.md:18-22`. It calls
  `cli/scripts/device-release-check.mts` (exists) and passes `src/lib/summarize.spec.ts` to vitest
  (`device_release_check.py:91`), and that spec file no longer exists. It is stale but probably still
  runs, since vitest treats the argument as a filter.
- **O11 regeneration tools**:
  - `HT_UPDATE_ARC_GOLDEN` (`test_arc_pixels.c:10,16,176,182`, golden refresh).
  - `scripts/import_tux_moods.mjs` (`TUX.md:145`; reads/writes `prototype/habitat/assets/tux/*.json`).
  - `scripts/fo_pet.py` (writes `assets/pets/fo`; `gen_pets.py` and `assets/pets/fo/README.md`).
  - `gen_character_fonts.py`, `gen_focus_faces.py` (`--inter-instance` needs the gitignored
    `mockup/fonts-inter/Inter.ttf`), `gen_focus_marks.py` (reads `desktop/assets/engine-icons`),
    `gen_companion_art.py` (reads `daemons/tools/illustrated/`), `gen_display_fallbacks.py` (needs
    Python 3.14 for Unicode 16), `gen_lvgl_assets.py`.
  - All of these generate compiled or tested files.

### Feature removal, not in scope (kept out of the DEAD list on purpose)

The Swarm thread / PM / Buddy code is live and tested. Removing it is a separate decision:
- `main/ui/habitat/supertab.c/h` (thread fields; `ht_supertabs_thread_leave`, `supertab.h:95`).
- `main/cable_client.c/h` (`cable_client_supertab_thread_leave`, `cable_client_supertab_side`,
  `cable_client_supertab_side_kept`, `cable_client.h:238-240`, and about 38 thread/buddy sites in
  cable_client.c).
- `main/ui/habitat/ui_habitat.c` (about 162 matching sites: the thread face, the Swarm picker, the
  PM/Buddy sides).
- Tests: `test/test_supertab.c`, `test/test_cable_supertab.py`, `test/test_cable_models.py`, and
  `test/test_touch_ui.py` (about 290 matching lines).

None of the 83 functions in D11 belongs to that feature.

---

## Risks and things I could not settle

- **R1. No ESP-IDF build was run.** Every deletion was checked by references and against `--gc-sections`
  reasoning, not by compiling.
  - Before merging, run `idf.py build` and `idf.py size` on the default config and compare the image
    (expect identical code and data, or address-only shifts).
  - Also compile the flag builds you keep, at least `-DDEVICE_ALL_SKINS=1` and `-DBOARD_PROBE=1`.
  - Run `make device-test` and the CI glob of `test_*.py`.
  - The bench flag builds (O1-O7) weren't compiled either. A static check found every function they
    call is defined, but whether they still build today is unverified.
- **R2. `ram_telemetry_init` may be a lost call, not dead code.**
  - `ram_telemetry.h:5-6` says "Call once at the very start of app_main()". It installs PSRAM-first
    cJSON allocation. Nothing calls it, so cJSON uses the default allocator today.
  - Deleting it keeps today's behaviour. Restoring the call would change behaviour (internal RAM use).
  - Ask the owner before deleting; it may be a regression to fix instead.
- **R3. Config that is probably dead but affects the image (U2).**
  - Settings with no remaining user in the source:
    - `sdkconfig.defaults:24`: `CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP`.
    - `sdkconfig.defaults.esp32s3:15`: `SPIRAM_TRY_ALLOCATE_WIFI_LWIP`.
    - `:22`: `ESP_WIFI_SOFTAP_SUPPORT`.
    - `:25`: `HTTPD_MAX_REQ_HDR_LEN`.
    - `:28`: `WS_TRANSPORT`.
    - `:32-33`: `MBEDTLS_CERTIFICATE_BUNDLE*`.
    - `:42-47`: the LWIP socket and window settings.
  - Unused components in `main/CMakeLists.txt:79-98` `BOARD_REQUIRES`: `esp_wifi`, `esp_netif`,
    `esp_event`, `esp_http_server`, `esp_http_client`, `esp_https_ota`, `esp_websocket_client` and
    `esp-tls`. No source includes their headers (checked). `fw_update.c` uses `esp_ota_ops`,
    `esp_partition` and `mbedtls` (sha256).
  - Changing any of these changes `sdkconfig` and can change the image: the bundle size, LWIP pools,
    and the `MBEDTLS_EXTERNAL_MEM_ALLOC` path that the SHA-256 in `fw_update.c` goes through.
  - Treat these as a follow-up with a size and boot test on a dial, not as a dead-code deletion.
- **R4. `RELEASE.md` is stale.**
  - §1-3 (lines 1-41, 80-90) describe the device polling GCS over Wi-Fi with
    `DEVICE_OTA_METADATA_URL`/`DEVICE_OTA_KEY` in `config_store.h`, and confirming on the commander
    `connected` frame in `commander_client.c`. None of these exists any more.
  - Today the host pushes the update: `cli/src/cable/fwPush.ts:4` reads "the SAME published manifest
    the device used to poll".
  - Line 120 says `make flash-circle`, but there is no such target in `Makefile`; line 150 already says
    it lives elsewhere.
  - The publishing half (`make upload-circle`) is current. It needs a rewrite, not a deletion.
- **R5. `prototype/habitat/*.md` is stale but referenced.**
  - `README.md:3-5,44-56` calls habitat "opt-in" and says "The shipped LVGL path remains selectable with
    `DEVICE_HABITAT=0`". `TUX.md:157` and `CREATURE_GALLERY.md:88` pass `-DDEVICE_HABITAT=1`.
  - Generator headers cite these docs as provenance (`gen_creature_art.py:6`, `octopus_art.inc:3`), and
    `FONTS.md` carries the license attributions for Jgs7 and Unscii. Keep the files and fix the text.
- **R6. D16 regeneration.** See D16: there is no `--check` mode and the Pillow pin differs. Hand-edit
  `fonts.c` and the generator together.
- **R7. U1 (parrot.animation, stark-dragon.txt).** Unreferenced, but they may be kept on purpose as
  source and attribution copies of third-party ASCII art. That is the owner's call.
- **R8. `samples/hackathon-fo/01-fo-glance/solution.patch` patches `main/CMakeLists.txt`
  (hunk at line 123), `test/run.sh` (line 39), `focus.c`, `theme.h` and `test_touch_ui.py`.**
  - The D4 edit removes CMake lines 155-168, which is after the hunk; the hunk context lines don't
    change, but later hunks shift.
  - D14 touches `test_touch_ui.py:3588`; the patch's hunk there should be re-checked.
  - After the cleanup, run `git apply --check` on the patch.
- **R9. The CI firmware job runs only `test_*.py`, not `run.sh`.** Removing a C test from `run.sh`
  is covered only by `make device-test` locally. Removing a `test_*.py` (O3, O4, O5) changes what CI
  runs.
- **R10. Tests extract code by name.** Every function removed in D11 was checked against all
  `function('…')` calls and `index()`/`split()` markers in `test/*.py`. No match. If the D11 cut also
  touches a neighbouring comment, re-run `test_touch_ui.py`, `test_voice_ui.py`, `test_question_ui.py`
  and `test_machine_ui.py`, which slice `ui_habitat.c` between markers such as
  `'/*\n * THE SWARMS'` and `'static void tabs_open(void)'`.

### Totals (DEAD only)

- Whole files, high confidence (D1-D10): about 361.5 KB in 16 files, plus the empty `tools/` and `docs/`
  directories.
- Code inside live files (D11-D13, D15, D17-D18): about 413 function lines (~12.3 KB), about 230
  header lines, about 25 macro lines, about 15 generator and test lines, and about 60 comment and
  ignore lines.
- Generated data (D14, D16): about 227 KB of `.c` source plus the 293.7 KB `unscii-8.ttf`. The device
  image is unaffected, because the linker already discards this data.
- Not counted: the optional tools (O1-O11), about 1.1 MB of source including the creature gallery's
  ~460 KB, and the 4.6 MB companion pack, which is live.
