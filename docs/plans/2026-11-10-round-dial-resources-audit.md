# Round dial: resources it carries for nothing (2026-11-10)

Read-only audit of main c1a711d1a (after #3604). Nothing changed, flashed or sent.
Measured on the default build (image 3,369,871 B: .rodata 2,858,928, .text 415,088; static internal RAM 175,495 B; PSRAM statics 489,288 B) and three throwaway experiment builds (compiled, not booted), plus ~10k telemetry samples from this Mac's dial logs (fw 0.0.95 to 0.1.0-dev).
Every flash byte is also a PSRAM byte: SPIRAM_FETCH_INSTRUCTIONS + SPIRAM_RODATA copy code and rodata into PSRAM at boot (logs: 4,503,524 B PSRAM free of 8 MB).
Internal RAM is the scarce pool: ~127.5 KB free, largest block 43,008 B.

| # | Finding | Saving | Confidence | Risk |
|---|---|---|---|---|
| 1 | Tim, Tux, illustrated companions link into the Focus-only default image but can never be drawn | 270,293 B flash+PSRAM | measured | low |
| 2 | FreeRTOS/heap/ringbuf code in IRAM though cache is never disabled (code runs from PSRAM) | +25,532 B internal RAM | measured | medium (frame time) |
| 3 | Render task stack 24,576 B, peak use 5,596 B (sized for the ROM inflater, only the compiled-out companion pack uses it) | 12-14 KB internal RAM | measured | low-medium |
| 4 | newlib nano printf (fix two %llu in ram_telemetry.c:113 first) | 31,403 B flash | measured | low |
| 5 | Duplicated generated data: pets.c identical arrays 61,762 B; never-drawn 56 px marks 28,224 B + 6,272 B dupes; wordmark kerning table 10,403 B (49 B needed); shared Inter tables 10,152 B | ~110 KB flash | computed | low (generator edits) |
| 6 | Latin Extended-A in 7 Inter faces: Vietnamese needs 8 letters, the other 119 per face cost 189,138 B | ~189 KB flash | computed | product call; wire display_fallbacks into the Inter path so cut letters degrade (ś → s) |
| 7 | DEVICE_ALL_SKINS image no longer fits PSRAM: 7,964,568 + 416,948 + 489,288 PSRAM statics = 8,870,804 > 8,388,608 B → boot abort "No enough psram memory for rodata" | — (option is dead) | high, not booted | keep the pack out of the PSRAM copy, or retire the option |
| 8 | ram_telemetry_init never called: cJSON nodes/strings go to internal RAM; worst parse ~37 KB internal (est.) | up to ~37 KB internal peak | estimate | PSRAM slower; A/B int_min on a dial |
| 9 | Rare-path buffers in internal RAM: last_words s_previous 4,097; pet_store s_scratch 4,120; cable_client s_agents 3,648; (optional) cable_link s_tx_frame 8,200 | ~11.9 KB (+8.2) internal | measured sizes | low |
| 10 | MINIMAL_BUILD | 14,148 B flash, 416 B RAM; objects 1,154 → 777 | measured | medium (console/panic path) |
| 11 | Stack telemetry lists commander_ws (gone), omits cable_link (runs OTA write + SHA-256), habitat_actions, habitat_touch, cable_session | — | certain | none; fix before trimming stacks |
| 12 | Oversized task stacks: proj_refresh 7,168/2,248; voice_capture 5,120/2,576; voice_send 5,120/2,404; ptt 4,096/2,168; beep 4,096/2,252; main 10,240/1,980 (stale "OTA on app_main" reason) | ~5 KB internal | measured | low |
| 13 | Wi-Fi/HTTP/TLS/LWIP/WebSocket components and config | 0 B (nothing linked) | measured | tidy only; keep mbedtls (SHA-256), app_update, esp_partition, rollback |
| 14 | Partitions: image uses 40.8% of an OTA slot; phy_init, 56 KB at 0x12000 and 128 KB at the end unused | — | measured | keep: changing the table needs a USB reflash of every dial |
| 15 | PSRAM statics: ui_habitat `s` 271,452 B (pane_memory_t memory[128] = 193,024 B); swarm 143,832 B; voice ring 32 KB, peak 640 B | low priority (4.5 MB PSRAM free) | measured | — |

Evidence and file:line per finding:
1. HABITAT_FOCUS_ONLY (main/CMakeLists.txt:130) forces Focus (ui_habitat.c:4311-4314, 4399-4401), but the registry character.c:42-58 holds function pointers to every skin and character.c:103 calls the illustrated tick, so tux.c 140,091 B, illustrated.c 96,304 B, octopus.c 29,674 B, octopus_font.c 2,708 B stay linked. Fix: ~10 lines under #ifdef HABITAT_FOCUS_ONLY pointing every row at Focus and compiling out the illustrated tick.
2. CONFIG_FREERTOS_PLACE_FUNCTIONS_INTO_FLASH, HEAP_PLACE_FUNCTION_INTO_FLASH, RINGBUF_PLACE_FUNCTIONS_INTO_FLASH; IRAM .text 64,587 → 40,015 B. Safe because SPI_FLASH_CACHE_NO_DISABLE with PSRAM XIP (spi_flash_os_func_app.c:29). Verify frame_max_us A/B plus an OTA push and NVS write while animating.
3. display_habitat.c:475-477. Lowest stack_free in alive lines 18,980 B on fw ≥ 0.0.94.
4. CONFIG_LIBC_NEWLIB_NANO_FORMAT=y; ram_telemetry.c:113 has two %llu that nano cannot print.
5. pets.c (alert bubble stored for Codex, Muse, Fo); focus.c:197-205,938,964 (Claude/Codex/Muse always show their pet); focus_faces.c:27783.
6. Latin-1 131,723 B, Vietnamese 176,423 B, ASCII 111,678 B for comparison; terminal.c:339-348 draws '?' on the Inter path.
7. esp_psram.c:249-268. The ALL_SKINS image also uses 96.7% of an OTA slot.
8. 16 KB internal-first threshold; message cap 8 KB / 512 tokens; int_min dips 10-20 KB below steady state, worst 107,015 B. If deleted instead: also drop ram_psram_* and the always-0/0B json_fb log field.
11. ram_telemetry.c:133-138; cable_link.c:76-78 claims it is reported.
12. sdkconfig.defaults:28-33.

Suggested order: 11 (free, unblocks 3/12) → 1, 4, 5 (low risk, ~410 KB) → 3, 9, 12 (internal RAM) → 2, 8 (A/B on a dial) → 6, 7 (product calls) → 10, 13 (tidy).
