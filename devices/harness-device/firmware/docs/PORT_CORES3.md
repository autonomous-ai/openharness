# M5Stack CoreS3 port (`cores3` branch)

OpenHarness device firmware on the M5Stack CoreS3, packaged as an app the
[M5Launcher](https://github.com/bmorcelli/Launcher) installs from the SD card.

> **STATUS (2026-09-19): hardware bring-up essentially complete — screen pipeline live but the
> panel still renders black.** Board bring-up, audio, USB link, buttons and the render/flush
> counters all verified on hardware. The one open issue (flushed pixels not visible) plus the
> full investigation history live in [`PORT_CORES3_DEBUG_LOG.md`](PORT_CORES3_DEBUG_LOG.md) —
> read that first when continuing this work.

## Upgrade path (how upstream updates reach this port)

The port lives as a small set of commits on the `cores3` branch of a fork of
`autonomous-ai/openharness`. Upstream files are touched only in a handful of
narrow `#if defined(DEVICE_BOARD_M5CORES3)` hunks; everything else lives in new
files, so most upstream changes merge without touching the port:

| New (port-only) files | Purpose |
|---|---|
| `main/board/cores3_board.h/.c` | AW9523B expander + AXP2101 rails + LCD reset + backlight + ES7210 sequence |
| `main/ui/display_cores3.h/.c` | ILI9342C/E bring-up, 466→320×240 downscale flush, brightness |
| `scripts/build-cores3.sh`, `scripts/flash-cores3.sh`, `scripts/update-upstream.sh` | build / flash / rebase tooling |
| `docs/PORT_CORES3.md` | this file |

Edited upstream files (guarded, so the round-dial build is byte-identical):
`board/board_pins.h`, `board/board.h`, `board/board.c`, `ui/display.c`,
`ui/touch.c`, `audio_capture.c`, `ptt.c`, `app_main.c`, `main/CMakeLists.txt`,
`main/idf_component.yml`.

### When upstream moves

```bash
. ~/esp/esp-idf/export.sh
./devices/harness-device/firmware/scripts/update-upstream.sh   # fetch + rebase + rebuild
```

The script fetches `upstream` (set it once: `git remote add upstream
https://github.com/autonomous-ai/openharness.git`), rebases `cores3` onto
`upstream/main`, and rebuilds the image. Conflicts, when they happen, live in the
files listed above — resolve, `git rebase --continue`, rebuild.

Prefer *upstreaming* this port when it is hardware-tested: the upstream README
explicitly invites hardware ports ("Contribute a hardware port"). A PR that lands
turns every future update into a plain `git pull` — no branch to maintain. Until
then the rebase flow above is the plan.

## Hardware map (validated against M5GFX / M5Unified / esp-bsp)

| Block | CoreS3 | Notes |
|---|---|---|
| Panel | ILI9342C/E, SPI3: SCLK 36, MOSI 37, CS 3, DC 35, 40 MHz | `esp_lcd_ili9341` driver + invert; E-revision gets vendor cmds (touch FIRMID picks) |
| Panel reset | AW9523B (0x58) P1_1 | no GPIO reset line |
| Backlight | AXP2101 DLDO1 (0x99) | M5GFX `(level+641)>>5` mapping |
| Touch | FT6336U @0x38, INT via expander | `esp_lcd_touch_ft5x06` driver |
| Mic | ES7210 @0x40, I2S1: MCLK 0, BCK 34, WS 33, DIN 14 | M5Unified register sequence applied after open |
| Speaker | AW88298 @0x36, I2S1 DOUT 13 | `esp_codec_dev` AW88298 driver (esp-bsp-validated) |
| PMIC | AXP2101 @0x34 | same chip as the dial; battery/PWR-key code reused as-is |
| USB | GPIO19/20 → USB-Serial-JTAG | identical link to the daemon; no firmware change |

## Buttons and the always-on screen (port decision)

The round dial has two keys and sleeps its panel after 5 idle minutes. The CoreS3
has exactly one physical key and this port keeps the screen on whenever the
device is on, so the key map was re-cut (`main/ptt.c`):

| Input | Round dial | CoreS3 port |
|---|---|---|
| PWR key tap (AXP2101 PWRON, I2C-IRQ) | toggle screen on/off | **action button** — same as the dial's BOOT tap: back / stop turn (`ui_boot_pressed`) |
| PWR long press | — (never reaches the firmware) | AXP2101 hardware: power-off at ~4 s (reg 0x27 = 0x00, as M5Unified sets it) |
| BOOT tap (GPIO0) | back / stop turn | n/a — CoreS3 has no exposed BOOT key; GPIO0 is the ES7210 MCLK |
| BOOT hold ≥ 800 ms | screen on/off | n/a |
| Voice | touch only: double-tap starts, tap stops | unchanged (see `ui/touch.c`) |
| Screen idle | panel off after IDLE_MS (5 min), double-tap/PWR wakes | **always on** — the idle-off in `ui/display.c` is compiled out; no key controls the panel |

Implementation notes:

- The screen-never-sleeps rule lives in one place: the idle check in
  `ui/display.c`'s LVGL task is guarded by `#if !defined(DEVICE_BOARD_M5CORES3)`.
  `display_sleep()`/`display_wake()` still exist (sleep-mode plumbing), they just
  never fire on this board — and `lvgl_flush_cores3` still acks LVGL if a flush
  ever lands while asleep.
- The PWR tap is latched by the AXP2101 IRQ and read via
  `power_take_pwrkey_tap()` (unchanged from the dial — same PMIC, same wiring
  through `board/power.c`); `pwr_action()` dispatches it to `ui_boot_pressed()`
  on CoreS3 and to the screen toggle on the dial.
- Consequence: the factory-reset-at-boot gesture (BOOT held at power-on,
  `app_main.c`) does not exist on CoreS3. Nothing on this device needs it — NVS
  holds only brightness and voice-language — and clearing those means reinstalling.

## The virtual round screen

The 8,400-line UI is designed for the 466×466 round AMOLED. Rather than rewrite it, LVGL still
renders a 466×466 virtual display (partial render mode, the dial's proven architecture — a
direct-mode full PSRAM frame was tried and hung LVGL 9.5's draw dispatch, see the debug log);
the flush callback downscales each dirty area by 29/50 (0.58) onto the 320×240 panel and touch
coordinates are mapped back up by 50/29. The window is fitted to the UI's real content bounds —
the notification pill at virtual y=22 through the Voice button bottom at y=434 fills the panel's
240 rows exactly; the 466px face centers on the 320px panel with dark side margins. See
`main/ui/display_cores3.c`.

## Build

```bash
. ~/esp/esp-idf/export.sh
./devices/harness-device/firmware/scripts/build-cores3.sh
# → devices/harness-device/firmware/build-cores3/interns_commander.bin
```

## Install via M5Launcher (the normal path)

1. Put the `.bin` on the CoreS3's SD card — from the host: remove the card and
   copy, or use the Launcher's file transfer (WebUI over WiFi, or USB when the
   device is plugged into the computer running Launcher 2.4.6+ USB MSC).
2. On the device: Launcher → SD → select `interns_commander.bin` → Install.
   Launcher repartitions the 16MB flash to fit the app, reboots into it, and
   shows a boot screen on every power-up (tap during it to get back to Launcher;
   the `APP` menu item reboots into the app).

## Direct USB flash (development only)

```bash
. ~/esp/esp-idf/export.sh
./devices/harness-device/firmware/scripts/flash-cores3.sh /dev/cu.usbmodem*
```

This esptool-flashes bootloader + partition table + app straight to the device —
it bypasses Launcher (a Launcher install overwrites it again). The device then
enumerates as a USB serial port the Harness daemon talks to, exactly like the
round dial.

## Known deltas vs the round dial

- One key, remapped: the PWR key is the action button (back / stop turn) and the
  screen is always on — see "Buttons and the always-on screen" above. The
  factory-reset-at-boot gesture has no CoreS3 equivalent (no BOOT key).
- Host-driven firmware updates (`fw_update.c`) need a second OTA slot; under
  Launcher's single-app partition the update request reports failure instead of
  flashing. Reinstall via the SD card instead.
- Rendering the 466×466 virtual screen scaled down costs CPU on the LVGL task; if a screen
  ever feels heavy, shrink `DRAW_LINES` in `ui/display.c` or drop the LVGL pool.
- Touch is initialized but not yet user-verified; `touch_chip_name()` logs "no-touch" for the
  FT6336U (cosmetic, one-line fix in `ui/touch.c`).
- **Open: the panel renders black** — render/flush pipeline verified live by counters, pixels
  not visible. Continue from [`PORT_CORES3_DEBUG_LOG.md`](PORT_CORES3_DEBUG_LOG.md) "Open issue".
