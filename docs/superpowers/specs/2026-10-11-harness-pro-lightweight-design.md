# Harness Pro firmware, lightweight pass (option A)

Status: approach A chosen by the owner on 2026-10-11 ("viet plan lam A thoi").

## Goal

Make the Pro firmware (`devices/harness-pro/firmware`) lighter in flash, RAM and frame time. The balance between the three was the owner's choice. What the Pod shows must not change: every screen renders byte-identical to today.

## Owner decisions

- Balance flash, RAM and performance; no visual change.
- Remove Wi-Fi. The Pro talks to the daemon only over the USB cable.
- Option A only: no change of asset format. Compressed assets (option B) and `-Os`, stack trims and hardware rotation (option C) are out of scope.
- Pod has no Relaxing scene. Since 2026-10-10 an idle pet shows its Rest loop.

## Baseline (2026-10-11, build `0.0.99-pod`, `POD_PANEL_TURN=180`)

- **Image:** 3,093,612 B. The large contributors:

  | Contributor | Size |
  |---|---|
  | `pets.c` | 1,257,169 B |
  | `pro_fonts.c` | 707,003 B |
  | `engine_logos.c` | 251,266 B |
  | esp_hosted, lwip, sdmmc, protobuf and their strings | about 350 KB |

- **Internal RAM:** about 384 KB free (heartbeat `heap=`).
- **Frame time:** `raster_max_us` about 43,000 and `frame_max_us` about 44,500 with a pet animating. About 25,000 on a still screen.
- **Pet wake:** it ticks every 33 ms (`POD_PET_STEP_MS`), but scenes step only every 46–217 ms.

## Changes

1. **Fonts 42 and 56.**
   - Pod draws only `#` at 42 (`pod_chrome.c`) and `>_` at 42 and 56 (`pod_pet.c` `mark_default_big`).
   - `gen_fonts.py` keeps the full glyph table for both sizes, so widths and advances stay the same, but bakes masks only for `# > _ ?`. Every other glyph gets an empty mask.
   - A test fails if any source draws another character at 42 or 56.
   - Estimate: −515 KB.
2. **Unreachable pet data.**
   - Pod never plays the relax and alert scenes, and never plays codex's WORKING and DONE small loops.
   - A Pro-owned `scripts/prune_pets.py` rewrites the imported `pets.c` without them and sets their pointers to NULL. `import_pets.sh` runs it after every copy.
   - Measured: −294 KB.
3. **Logos.**
   - `pod_gen_logos.py` stops emitting the 72 px logo for engines that have a pet (claude, codex, muse), because those engines draw their pet instead.
   - Estimate: −47 KB.
4. **Wi-Fi.**
   - Removed:
     - `board/pro_wifi.c`/`.h` and the `pro_wifi_start` call;
     - the `esp_hosted` and `esp_wifi_remote` components;
     - the REQUIRES on `esp_wifi`, `esp_netif` and `esp_event`;
     - the coprocessor block and `HTTPS_OTA_ALLOW_HTTP` in `sdkconfig.defaults`.
   - The ESP32-C5 coprocessor is held in reset (GPIO13, active-high), so it does not run its own firmware.
   - `nvs_flash` and `mbedtls` stay, because `config_store` needs them.
   - `partitions.csv` is not changed.
   - Estimate: about −350 KB flash and 10–30 KB internal RAM.
5. **Pet raster.**
   - Today `cell_raster` (`pod/pod_draw.c`) searches a 4-slot row cache up to five times per pixel.
   - The rewrite fetches the source rows and edge flags once per output row:
     - one path for z = 8;
     - a zoomed path with an 8-slot cache.
   - Its scratch is a render-only static, so render-task stacks stay within `run.sh`'s 4096 B cap.
   - Output is byte-identical. The host prototype was 1.6–3x faster.
6. **Pet wake cadence.**
   - While a pet is on screen, the clock wakes at the pet's next step boundary instead of every 33 ms.
   - A scene with bars or waves drawn in code, or any other animation on screen, keeps the rate it needs.

## Acceptance

- Every `pod_render` screen is byte-identical to the baseline captured before Task 1.
- `test/run.sh` passes with Helvetica and with Liberation, and `test_tree_isolation.py` and `test_fonts.py` pass.
- Image at most 2.0 MB.
- On the device:
  - `raster_max_us` at most 30,000 with a pet animating;
  - no PANIC and session up;
  - `heap=` not lower than the baseline;
  - Tabs, Agent, Recap, Listening and voice still work.
- `devices/harness-device` is unchanged.

## Risks

- **A future string at 42 or 56 would draw blank.** The character test turns that into a test failure.
- **Re-importing pets brings the pruned data back** unless the prune runs too. `import_pets.sh` runs it, and a test checks that the pruned pointers are NULL.
- **Wi-Fi removal leaves the C5 floating.** Holding it in reset is part of the change. The device check confirms boot and that `heap=` goes up.
