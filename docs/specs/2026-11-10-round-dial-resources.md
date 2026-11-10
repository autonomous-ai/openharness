# Round dial: give back flash and internal RAM it holds for nothing (Diego, 2026-11-10)

## Why

The round dial (`devices/harness-device/firmware`, ESP32-S3) copies its whole image into PSRAM at boot, so every
flash byte is also a PSRAM byte. Internal RAM is the scarce pool: about 127.5 KB free, largest block 43,008 B. An
audit of main `c1a711d1a` (`docs/plans/2026-11-10-round-dial-resources-audit.md`, findings #1-#15) found about
410 KB of image and about 25 KB of internal RAM that buy nothing, plus a stack telemetry list that names a task
which no longer exists and misses the ones that matter.

## Goal

Take back the low-risk part of that, with no change in what the dial shows or does.

## In scope (audit numbers)

1. **Stack telemetry names the real tasks (#11).** `ram_telemetry_periodic` logs the stacks of every task the
   firmware creates: `proj_refresh`, `ptt`, `beep`, `cable_link`, `cable_session`, `habitat_actions`,
   `habitat_touch`, `habitat_render`, `voice_capture`, `voice_send`. `commander_ws` goes.
2. **The Focus-only image links only Focus (#1, 270,293 B).** In the default build (`HABITAT_FOCUS_ONLY`), the
   character registry and the illustrated tick no longer reference Tim, Tux, the octopus or the illustrated
   companions, so the linker drops `tux.c`, `illustrated.c`, `octopus.c`, `octopus_font.c`. `-DDEVICE_ALL_SKINS=1`
   keeps every character as today.
3. **newlib nano printf (#4, 31,403 B).** `CONFIG_LIBC_NEWLIB_NANO_FORMAT=y`, after the two `%llu` in
   `ram_telemetry.c` become `%u`. No firmware format string uses `long long` afterwards.
4. **No duplicated generated data (#5, part).**
   - `pets.c` emits each distinct array once (61,762 B of byte-identical arrays today, mostly one alert bubble
     stored for Codex, Muse and Fo).
   - `focus_marks.c` does not carry the 56 px marks for Claude, Codex and Muse, which always show their built-in
     pet (28,224 B), and emits identical arrays once (6,272 B).
   - Both through their generators (`gen_pets.py`, `gen_focus_marks.py`); `gen_pets.py --check` stays green.
5. **Smaller stacks where the dial's own telemetry shows the need (#3, #12).**
   - `habitat_render`: 24,576 → 12,288 B unless `DEVICE_ALL_SKINS` (peak 5,596 B; the extra was for the ROM
     inflater, which only the compiled-out companion pack uses).
   - `proj_refresh` 7,168 → 4,096 (peak 2,248), `voice_capture` 5,120 → 4,096 (peak 2,576), `voice_send`
     5,120 → 4,096 (peak 2,404). Each new size is at least 1.5× its measured peak.
   - `ptt`, `beep`, main and `cable_link` keep their sizes.
6. **Rare-path buffers move to PSRAM (#9, ~11.9 KB).** `last_words.c` `s_previous`, `pet_store.c` `s_scratch`
   (`EXT_RAM_BSS_ATTR`), and `cable_client.c` `s_agents` (allocated from `MALLOC_CAP_SPIRAM`).
7. **Network leftovers removed (#13, 0 B).** The eight network components leave `BOARD_REQUIRES`,
   `espressif/esp_websocket_client` leaves `idf_component.yml` (and `dependencies.lock`), and the Wi-Fi, HTTP,
   TLS, LWIP and WebSocket `sdkconfig.defaults*` values go. `mbedtls` (SHA-256 in `fw_update.c`), `app_update`,
   `esp_partition` and app rollback stay.

## Out of scope

- IRAM-to-flash settings (#2) and calling or deleting `ram_telemetry_init` (#8): each needs an A/B measurement on
  a dial first. Follow-up.
- Cutting Latin Extended-A from the Inter faces (#6) and the `DEVICE_ALL_SKINS` image no longer fitting PSRAM
  (#7): Diego decides.
- `focus_faces.c` kerning and shared-table dedup (#5, rest): its generator needs `lv_font_conv` and an Inter
  instance outside the repo. Follow-up.
- `MINIMAL_BUILD` (#10), partitions (#14), PSRAM statics (#15), the thread/PM code, the host.

## Done when

- **Image:** the default image is at least 300 KB smaller and IRAM/DRAM no larger. `nm` shows no `ht_tux_`,
  `ht_illustrated_` or `ht_octopus_` symbols in the default ELF. `-DDEVICE_ALL_SKINS=1` and `-DBOARD_PROBE=1`
  still build.
- **Internal RAM:** at least 25 KB more free at boot, by the dial's own `RAM tag=` line.
- **Tests:**
  - `make device-test` passes, and every `firmware/test/test_*.py` passes, as CI runs them.
  - New tests pin: the telemetry task list, the Focus-only link set, no `%ll` in format strings, no duplicate
    arrays in `pets.c` / `focus_marks.c`.
- **On a dial** (USB flash, `-DPROJECT_VER=0.1.0-dev`, 30 minutes of normal use):
  - Focus face, pets, alerts, voice message and the Swarm screens look and work as before.
  - A firmware push over the cable completes.
  - Every task in the new telemetry list keeps at least 1 KB of stack free.
  - The cable shows no reboot, watchdog or `stack overflow`.

## Design

- **Growth, read cost, scale:** none; fewer bytes everywhere.
- **Compatibility:** the cable protocol is untouched; the daemon sees the same device. Older and newer daemons
  work as before.
- **Platforms:** the round dial only. The Pro (`devices/harness-pro`) is not touched.
- **Failure:**
  - A wrong cut shows up as a build error, a failing test, a size or symbol change, or on the dial as a stack
    warning, reboot or missing art.
  - The stack telemetry lands first so the stack change can be judged.
