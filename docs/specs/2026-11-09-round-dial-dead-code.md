# Round dial: remove dead code and files (Diego, 2026-11-09)

## Why

The round dial's tree (`devices/harness-device/`) still carries what the LVGL renderer, the ESP32-P4 Pro and
Wi-Fi provisioning left behind when they were removed: files nothing builds, functions nothing calls, fonts
and icons nothing draws, generators for files that no longer exist, and comments about two boards. It makes
the firmware harder to read and change. One generator check already fails on main because of it
(`scripts/gen_octopus.py --check`).

Audit (`docs/plans/2026-11-09-round-dial-dead-code-audit.md`, read-only at `d18648f46`; every item checked by references across the whole repo, including CI, the host, tests that
cut C out of sources by name, and the hackathon sample). Item ids D1-D18 are its ids,
below.

## Goal

Delete what is dead, and nothing else. The dial behaves exactly as before: same firmware image, same tests.

## In scope

Paths are relative to `devices/harness-device/firmware/` unless they start with `prototype/`.

### Whole files (D1-D10)
- `main/audio_client.c` (not built; `audio_client_habitat.c` replaced it; `audio_client.h` stays).
- `main/ui/touch_ctrl.h` (nothing includes it; the Pro has its own).
- `main/ui/metrics_round466.h`, `main/ui/ui_metrics.h` (no define used), with the `#include` and the
  `#if UI_DESK_GRID` block in `ui_screens.h`.
- `main/provisioned_config.h.example`, the `DEVICE_FORCE_PROD` and `DEVICE_BACKEND_URL` blocks in
  `main/CMakeLists.txt` (no code reads their macros), their `.gitignore` lines, and the
  `-DDEVICE_FORCE_PROD=1` that `scripts/upload-firmware.sh` passes.
- `screen.html`, `device-stages.html`, and `docs/` (three LVGL-era notes).
- `tools/generate_engine_icons.py` (writes a file that no longer exists, from a retired repo).
- `scripts/gen_fonts.sh` and `fonts/Geist-Medium.ttf` (the old LVGL faces). `fonts/Geist-SemiBold.ttf` stays:
  `mobile/scripts/build_play_graphics.py` draws the Play Store graphics with it.
- `assets/sparkle.png` (only `sparkle_fill.png` is read), with `assets/README.md`.
- `prototype/habitat/assets/GeistMono-Regular.ttf` (byte-identical copy of `fonts/`), with `FONTS.md`.

### Code inside live files (D11-D13)
- The unused functions of D11 in `ui_habitat.c` (56), `cable_client.c`, `cable_link.c`, `power.c`,
  `config_store.c`, `tim.c`, `display_habitat.c` (`display_init_ota` only; `display_lock_at` is live through
  the `display_lock()` macro) and `creature_gallery.c`, with their prototypes and the statics they leave
  unused.
- Declarations never defined (D12): `ui_desk_open/close/is_open`, `ui_notif_band_top_px`, `ui_tiles_replace`,
  `cable_tile_t`, `SWARM_TILES_MAX`.
- Unused macros and enum values (D13).

### Generated data and generators (D14-D16)
- `ht_icon_engine28` and `ht_icon_mic` in `lvgl_icons.c`, with `gen_lvgl_assets.py`, `assets/lvgl/SPEC.md`,
  `terminal.h`, `focus.h` and the one test assert that names `ht_icon_mic`.
- `gen_octopus.py`: stop emitting the Pro-only octopus atlases, so `--check` passes again. The never-compiled
  `HT_FACE_PX >= 720` branches and `#define DEVICE_HABITAT 1` lines in tests.
- `ht_pixel_40`, `ht_lock_dot` (test-only fonts in `fonts.c`), `prototype/habitat/assets/unscii-8.ttf`, with
  `gen_habitat_fonts.py`, `terminal.h`, `test/test_terminal.c` and `FONTS.md`.

### Stale text (D17 comments, D18)
- Comments and ignore lines about two boards, the Pro, LVGL, `ota.c`, `touch.c`, `display.c`,
  `commander_client.c` and libsodium, in source, CMake, `.gitignore`, `idf_component.yml` and
  `sdkconfig.defaults*`. Comments only: no value changes.

## Out of scope

- Anything that changes the built image or behaviour:
  - `ram_telemetry_init` and the `ram_psram_*` helpers. Nothing calls the init, though its header says to
    call it at boot. It may be a lost call rather than dead code, so it stays and Diego decides.
  - Removing `espressif/esp_websocket_client`, the Wi-Fi/TLS/HTTP `BOARD_REQUIRES`, and the `sdkconfig`
    values. They change the component set; this needs a size and boot test on a dial, so it is a follow-up.
- Splitting large files.
- The host side (`cli/`, `desktop/`).
- Rewriting `RELEASE.md` and `prototype/habitat/*.md` beyond the lines that name deleted files.
- Optional tools behind a flag: the benches, creature gallery, render fault/stress, `BOARD_PROBE`,
  `flash-station.sh`, `device_release_check.py`, the skins and characters, companions and pets.
- `parrot.animation` and `stark-dragon.txt` (possible attribution copies).

## Done when

- Every in-scope item is gone, and nothing else changed.
- **Same image:**
  - The default build (`idf.py build`, IDF 5.5.4, ESP32-S3) has the same `idf.py size` totals before and
    after: flash code, flash data, IRAM, DRAM.
  - The `DEVICE_ALL_SKINS=1` and `BOARD_PROBE=1` builds still compile.
- **Same tests:**
  - `make device-test` (`firmware/test/run.sh`) passes.
  - Every `firmware/test/test_*.py` passes, as CI runs them.
  - `scripts/gen_octopus.py --check` passes; it fails before.
- `git apply --check` of `samples/hackathon-fo/01-fo-glance/solution.patch` gives the same result before and
  after.
- No flash is needed: an unchanged image is the evidence. If the totals differ, stop and explain each byte
  before merging.

## Design

- **Growth, read cost, scale:** none; only deletions.
- **Compatibility:** the cable protocol and the host are untouched. The daemon sees the same device.
- **Platforms:** the round dial (ESP32-S3) only. The Pro (`devices/harness-pro`) has its own copies and is
  not touched.
- **Failure:** a wrong deletion shows up as a build error, a size change or a failing test, all before
  merge.
