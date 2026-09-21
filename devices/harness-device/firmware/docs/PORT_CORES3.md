# M5Stack CoreS3 port (`cores3` branch)

OpenHarness device firmware on the M5Stack CoreS3, packaged as an app the
[M5Launcher](https://github.com/bmorcelli/Launcher) installs from the SD card.

> **STATUS (2026-09-19): usable on hardware.** Panel, Geist text, audio, USB cable, Settings → WiFi
> (STA join + NVS), and CoreS3-only tile layout are on the device. LAN cable (`_harness-dial._tcp`)
> is in firmware + this checkout's daemon; the installed OpenHarness app does not have it yet.
> Do not open an upstream PR until WiFi-to-agents is tested with USB unplugged. History:
> [`PORT_CORES3_DEBUG_LOG.md`](PORT_CORES3_DEBUG_LOG.md).

## Upgrade path (how upstream updates reach this port)

The port lives as a small set of commits on the `cores3` branch of a fork of
`autonomous-ai/openharness`. Upstream files are touched only in a handful of
narrow `#if defined(DEVICE_BOARD_M5CORES3)` hunks; everything else lives in new
files, so most upstream changes merge without touching the port:

| New (port-only) files | Purpose |
|---|---|
| `main/board/cores3_board.h/.c` | AW9523B expander + AXP2101 rails + LCD reset + backlight + ES7210 sequence |
| `main/ui/display_cores3.h/.c` | ILI9342C/E bring-up, 466→320×240 compositor, brightness |
| `main/ui/ui_fonts.h` | Geist `extern`s (Montserrat only for `LV_SYMBOL_*`) |
| `main/wifi_sta.h/.c` | STA scan / join / NVS SSID+PSK |
| `main/wifi_cable.h/.c` | mDNS `_harness-dial._tcp:17420`, one TCP client, USB-bind only |
| `scripts/build-cores3.sh`, `scripts/flash-cores3.sh`, `scripts/update-upstream.sh` | build / flash / rebase tooling |
| `docs/PORT_CORES3.md` | this file |

Daemon (this checkout, not the App Store / Applications binary):
`cli/src/cable/tcpLink.ts`, `cli/src/cable/dialBind.ts` — USB mints a bind token; TCP welcome must present it.

Edited upstream files (guarded, so the round-dial build keeps Geist and the AMOLED path):
`board/board_pins.h`, `board/board.h`, `board/board.c`, `ui/display.c`,
`ui/touch.c`, `ui/ui_screens.c` (`#include "ui_fonts.h"` + CoreS3 layout), `audio_capture.c`,
`ptt.c`, `app_main.c`, `cable_link.c/.h`, `cable_client.c`, `config_store.c/.h`,
`main/CMakeLists.txt`, `main/idf_component.yml` (`espressif/mdns`).

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
  holds brightness, voice-language, WiFi SSID/PSK, and the USB bind token — and clearing those means reinstalling.

## The virtual round screen

The 8,400-line UI is designed for the 466×466 round AMOLED. Rather than rewrite it, LVGL still
renders a 466×466 virtual display (partial render mode — a direct-mode full PSRAM frame hung
LVGL 9.5's draw dispatch under `LV_OS_NONE`). Each flush is copied into a full 466×466 PSRAM
framebuffer, then the panel is sampled from that complete image: integer 1/2 plus a 2×2 RGB565
box average (~233×233 centred in 320×240, black bars). Touch maps back by ×2. Non-integer
nearest-neighbour (29/50) shredded 4-bpp glyphs; scaling only the dirty rectangle garbled later
paints because the 2×2 kernel needed neighbours outside the flush. `esp_lcd_panel_draw_bitmap`
wants packed rows of the dirty width: a 320-wide staging buffer made the first full-screen paint
look fine and every later text invalidate look like noise — which is why swapping Geist for
Montserrat changed nothing on the panel. See `main/ui/display_cores3.c`.

## Fonts

Geist is compiled on CoreS3 (same faces as the dial). A packed-row bug in the compositor
(`esp_lcd_panel_draw_bitmap` needs tightly packed dirty-width rows, not a 320-wide staging
buffer) made later text invalidates look like noise. That was mistaken for a font bug and
briefly aliased to Montserrat; Montserrat lacks `›` `✓` `✗` `…`, so those showed as rectangles.
Geist is back. `LV_SYMBOL_*` (bell, close) stay on Montserrat (FontAwesome). Emoji are stripped
by `utf8_filter`.

Also required for readable text: native RGB565 + byte-swap in the flush (not `RGB565_SWAPPED`,
lvgl#9387); skip AMOLED software-dim (AXP2101 DLDO1 only); opaque overview circles.

## WiFi and the cable

USB is still authorization. Settings → WiFi scans, joins, and stores SSID+PSK in NVS
(`config_store` keys `wssid`/`wpass`). Optional local `main/provisioned_config.h` (gitignored)
can seed those on boot.

After WiFi has an IP, the device advertises `_harness-dial._tcp` on port 17420. One TCP client.
While USB is plugged in, USB always wins (writes always go to USB-Serial-JTAG; LAN bytes are
ignored). A USB `welcome.bind` (64 hex chars) is stored in NVS (`wbind`). A TCP welcome without
that token is dropped — a second OpenHarness on the same LAN cannot steal the session.

The LAN client is `cli/src/cable/tcpLink.ts` + `dialBind.ts` in **this** tree. Run `harness` from
this checkout, plug USB once (mints the token), then unplug. The Applications-folder desktop app
does not speak this yet.

## CoreS3-only tile layout (`DEVICE_BOARD_M5CORES3` in `ui_screens.c`)

- Agent tile: engine mark 80px **above** tab pill then session title (not beside the name).
- Title / Thinking… / recap column `TILE_COL_W` 454. Name clip 26 glyphs (dial is 15). Recap 64
  glyphs, two-line fit. Agent mic at virtual y=383.
- Empty tab: pill is **Switch tab** (opens the tab list). Empty “New Harness” rows are omitted
  from the picker so you are not stuck with a nameless entry. Does not close the tab on the Mac.

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
- A USB **host** module on the CoreS3 can blank the panel; flash/use the USB-Serial/JTAG port
  (`/dev/cu.usbmodem*`), not a host dongle.
- WiFi STA is on the device; agents over WiFi need this checkout's daemon (see "WiFi and the
  cable"). OTA stays USB.
- **Not done:** GitHub PR. Work is on the local `cores3` branch, uncommitted as of this note.
  First upstream PR should be the USB hardware port with the WiFi menu off; LAN + bind as a
  follow-up with the daemon `TcpLink`.
