# CoreS3 port — DEBUG LOG & HANDOVER NOTES

Read this together with [`PORT_CORES3.md`](PORT_CORES3.md) (the port's design + build/deploy
guide). This file is the working notebook: what was tried, what each experiment proved, what is
still broken, and exactly how to continue. Written 2026-09-19, device on the bench connected at
`/dev/cu.usbmodem1101`, all work on branch `cores3` of the local clone at
`/Users/jay/openharness-cores3` (upstream: `autonomous-ai/openharness`).

## Current status (handover snapshot)

- Firmware builds and boots healthy on the M5Stack CoreS3. Logs: PSRAM 8MB OK (quad), AW9523B +
  AXP2101 rails up, panel probed + initialized (ILI9342C path), ES7210 mic + AW88298 speaker
  ready, cable link up (device↔daemon hello/pong flowing over USB-Serial-JTAG), PWR-key tap fires
  the action callback, screen never sleeps.
- **OPEN: the panel stays black.** LVGL's render pipeline is proven live by counters
  (invalidations → renders → flushes; last capture: 378 invalidations, 26 renders, 94 flushes by
  tick 5.2s), and the backlight is on — but the visible result is a uniformly black screen.
  Everything is plumbed; the pixels reaching the panel are wrong/empty (see "Open issue" below).
- 378+ invalidations and renders were seen *after* the UI settled, so the pipeline runs; the
  question is what the flushed pixels contain.

## Hardware map established (all validated in-source)

| Block | Working config | Source of truth |
|---|---|---|
| PSRAM | **QUAD** mode @80MHz (octal fails MSPI tuning on this unit) | m5stack/M5Unified, bmorcelli/Launcher (`qio_qspi`), 78/xiaozhi (`CONFIG_SPIRAM_MODE_QUAD=y` for cores3) |
| XIP (code/rodata from PSRAM) | **OFF** (`SPIRAM_FETCH_INSTRUCTIONS`/`RODATA` unset) | none of the working CoreS3 projects enable it; ON garbled every big-font glyph |
| Panel | ILI9342C, SPI3: SCLK 36, MOSI 37, CS 3, DC 35, 40MHz, **invert ON, no swap/mirror** | esp-bsp + M5GFX |
| Panel init | **M5GFX Panel_ILI9342 list0 verbatim** (starts `0xC8 = FF 93 42` "unlock external commands") | M5GFX `Panel_ILI9342.cpp`; the esp_lcd_ili9341 generic ILI9341 defaults are wrong for this panel |
| Panel revision probe | touch I2C 0x38: VENDID(0xA8) must be 0x11 and FIRMID(0xA6) 0x10 (C) / 0x12 (E) — **this unit reads 0x64/0x05/0x02**, falls back to C | M5GFX `Panel_M5StackCoreS3::initPanelByTouchVersion` |
| Panel reset | AW9523B (0x58) P1_1, low 10ms → high, settle 120ms | M5GFX `rst_control` |
| Backlight | AXP2101 DLDO1, reg = (level+641)>>5, 0 = LDO off | M5GFX `Light_M5StackCoreS3` |
| Touch | FT6336U via `esp_lcd_touch_ft5x06`, x_max 320 / y_max 240, INT unused (poll) | esp-bsp |
| Mic | ES7210 @0x40 + M5Unified register sequence applied after `esp_codec_dev_open` | M5Unified `_microphone_enabled_cb_cores3` |
| Speaker | AW88298 @0x36 via `aw88298_codec_new` (esp_codec_dev ≥1.5), pa_gain 15 | esp-bsp `bsp_audio.c` |
| PMIC | AXP2101 @0x34 — same chip as the dial; `board/power.c` reused unchanged | — |
| Buttons | PWR tap (AXP2101 IRQ) = action button (`ui_boot_pressed`); screen always on (idle-off compiled out) | port decision, see PORT_CORES3.md |

## The render pipeline (how it is wired now)

- LVGL PARTIAL render mode, 2 internal DMA draw buffers 466×29×2 B (dial architecture, unchanged).
- The display is a **virtual 466×466 surface**; `ui/display_cores3.c` downscales each flushed area
  by 29/50 (0.58) onto the 320×240 panel. Window fitted to the UI's real content bounds:
  virtual y 22 (notification pill) → 434 (Voice button bottom) maps exactly onto panel rows
  0..239; OFF_X = −43 centers the 466px face (270px) on the 320px panel.
- Flush: nearest-neighbour resample of the partial buffer into a 320×16-row internal staging
  chunk, `esp_lcd_panel_draw_bitmap` per chunk with a color-done semaphore (async queue depth 10 —
  **depth 0 is illegal**, it reaches `xQueueCreate(0,…)` and trips a FreeRTOS assert in
  `spi_bus_add_device`).
- Touch coordinates are scaled up panel→virtual in `touch_read` (`panel_to_virtual`).

## Root causes found, one line each

1. **Boot loop right after PSRAM init** = octal PSRAM unusable on this unit (PSRAM ID read
   garbage that changed every boot, "MSPI timing tuning fail"). Fix: quad mode.
2. **White + corrupted strips** = generic ILI9341 driver init on an ILI9342 panel (the panel
   keeps extended commands locked until `0xC8 = FF 93 42`; power/VCOM regs differ). Fix:
   M5GFX's Panel_ILI9342 command list as the vendor config.
3. **Assert `xQueueGenericCreate (pxNewQueue)`** = `trans_queue_depth = 0` in the panel-IO config
   reaching `xQueueCreate(0, …)`. esp_lcd does not support 0; use 10 + color-done callback.
4. **Uniform white with INVON** = the GRAM was never written (zeros display white when inverted).
   Distinguish "pixels not written" from "polarity" by panel edges staying unwritten (bars) —
   uniform color means never-flushed, not wrong colors.
5. **White bars either side** = panel columns outside the mapped window never flushed (negative
   OFF_X ⇒ dest starts at x=24). Fix: extend the dest window to the panel edge when the flush
   area touches a virtual edge.
6. **swap_xy=true garbles content** — the driver only flips MADCTL (MV=1); partial windows are
   streamed row-major while the panel fills column-major. Use no swap (esp-bsp does the same).
7. **Garbled glyphs in the big Geist fonts** = `.rodata` mapped through the PSRAM cache
   (`CONFIG_SPIRAM_RODATA`/`FETCH_INSTRUCTIONS`). Fix: both off — PSRAM for heap only.
8. **LVGL DIRECT render mode hung the LVGL task** before the first flush (task stopped
   heartbeating; `draw_buf_flush`'s `while(draw_task_head)` dispatch loop with `LV_OS_NONE`).
   Reverted to PARTIAL — do not revisit without a plan to debug inside
   `lv_draw_dispatch_wait_for_request` (busy-waits on `_draw_info.dispatch_req`).
9. **Flash failures ("chip stopped responding")** = stray readers on the port + high baud +
   flashing stale artifacts. Fixed in `scripts/flash-cores3.sh`: kills port holders, builds
   first, flashes at 115200, retries 3×.
10. **Diagnostics trap**: `HEARTBEAT_MS` is 60 s and the first beat prints `up=0s` (tick starts
    ~2.2 s in) — short captures look like a hang. Capture ≥70 s before concluding anything.

## Open issue (where to continue): black screen with the pipeline running

State at handover: counters prove invalidations→renders→flushes flow; the screen is black.

Next steps, in order:

1. **Dump flushed pixels.** In `lvgl_flush_cores3` (TEMP block already in place) log a few
   samples of the *source* buffer (`src` rows) for a known area — if the framebuffer slice is
   black, LVGL is rendering nothing visible (screen tree/loading state issue); if it has content,
   the panel write path drops it.
2. **Check the GRAM window.** With no swap the ILI9342C window is CASET 0..319 / RASET 0..239 —
   verify with a direct `draw_bitmap(0,0,320,240)` of a solid color right after init (the earlier
   RGB band self-test did this and the user never confirmed seeing it — re-add
   `panel self-test bands` from git history if needed).
3. **Try 20MHz pixel clock** (BSP_LCD_PIXEL_CLK_HZ) — 40MHz may be marginal on this unit; the
   corruption pattern (some items garbled) is not typical signal noise, but it is a 1-line test.
4. **Try `RGB_ELEMENT_ORDER_BGR`** and `mirror` flips — color order and mounting orientation are
   per-unit unknowns (this unit's touch fingerprint does not match M5Stack's).
5. If bands render but LVGL content does not, compare a flushed `src` row against what the panel
   shows for the same row (stride/offset bug in the resample), then check
   `lv_display_set_color_format(RGB565_SWAPPED)` vs the panel's COLMOD (driver sends 0x55).

Debug tooling already in place (all marked TEMP in `ui/display.c` / `ui/display_cores3.c`):
`refr stats` (invalidations/renders/flushes every 5 s), `refr tmr` (paused flag + counters in the
60 s heartbeat), `flush#` first-two-flushes log. Remove them once the screen is verified.

## Chronology (condensed)

| Build | Change | Observed | Conclusion |
|---|---|---|---|
| 1 | upstream dial config as-is | boot loop after PSRAM init, no app logs | octal PSRAM timing (see #1) |
| 2 | quad PSRAM | boots; abort in `esp_lcd_new_panel_io_spi` → queue assert | queue depth 0 (see #3) |
| 3 | queue depth 10 | boots, UI runs, **screen white + corrupted** | ILI9341-generic init wrong (see #2) |
| 4 | M5GFX C-list init, invert ON | corruption gone, uniform white | GRAM never written (INVON shows zeros white) |
| 5 | invert OFF | user: "inverted and garbled, some text" | invert ON is correct; data path now alive |
| 6 | swap OFF, invert ON | "mic ok (bottom cut), cog fine, two text tiles garbled" | MV garble + font garble + geometry crop |
| 7 | XIP off, geometry 29/50, edge fix | "scaling right, items still garbled, white bars" | margins bug (see #5); text garble persisted → |
| 8 | direct mode attempt | LVGL task hung before first flush | direct mode + LV_OS_NONE dispatch hang (see #8) |
| 9 | back to PARTIAL + all fixes | pipeline counters flow; **screen black** | current state — see "Open issue" |

## Conventions for the next agent

- Build + flash only via `scripts/flash-cores3.sh /dev/cu.usbmodem1101` (it builds first —
  flashing stale artifacts bit us twice).
- Capture logs with: `. ~/esp/esp-idf/export.sh` then
  `(echo reset; sleep N) | idf.py -B build-cores3 -p /dev/cu.usbmodem1101 monitor`.
  The monitor's `reset` command from stdin is the reliable way to catch a full boot; esptool
  resets can land in download mode when other handles hold DTR/RTS.
- Serial log greps that matter: `refr stats`, `refr tmr`, `flush#`, `ILI9342`, `app_ready`,
  `alive`. `alive` prints once a **minute**.
- TEMP diagnostics are marked `// TEMP bring-up diagnostics` in `ui/display.c` and
  `ui/display_cores3.c` — remove after visual verification, keep `refr tmr` if useful.
- Working tree is on branch `cores3`, uncommitted; commit once the screen is verified.
- M5Burner registry upload was researched but deliberately deferred until the port renders:
  `cores3` category exists on the M5Burner API; publish path = m5-burner-js CLI with an M5Stack
  community-account token, or the m5stack/M5Stack-Firmware repo PR route. Not started.
