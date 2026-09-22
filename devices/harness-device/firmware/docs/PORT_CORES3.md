# M5Stack CoreS3 port (`cores3` branch)

OpenHarness device firmware on the M5Stack CoreS3, packaged as an app the
[M5Launcher](https://github.com/bmorcelli/Launcher) installs from the SD card.

> **STATUS (2026-09-22): native 320x240 face on hardware.** LVGL renders the dial's UI directly at the
> panel's resolution (no virtual screen, no side bars), in the Apple Watch clone's frame: the time top-left,
> the dial's key as a circle top-right, WiFi and battery in the bottom corners. The PWR key is the screen's
> on/off again. Screenshots over the cable: `scripts/cores3-shots.py`. History:
> [`PORT_CORES3_DEBUG_LOG.md`](PORT_CORES3_DEBUG_LOG.md) (the virtual-screen era).

## Upgrade path (how upstream updates reach this port)

The port lives as a small set of commits on the `cores3` branch of a fork of
`autonomous-ai/openharness`. Upstream files are touched only in a handful of
narrow `#if defined(DEVICE_BOARD_M5CORES3)` hunks; everything else lives in new
files, so most upstream changes merge without touching the port:

| New (port-only) files | Purpose |
|---|---|
| `main/board/cores3_board.h/.c` | AW9523B expander + AXP2101 rails + LCD reset + backlight + ES7210 sequence |
| `main/ui/display_cores3.h/.c` | ILI9342C/E bring-up, the native async flush, backlight, debug snapshot |
| `main/board/cores3_clock.h/.c` | BM8563 RTC + the computer's UTC offset (from `welcome`) |
| `main/ui/geist_c3_*.c`, `main/ui/icons_c3.c/.h` | the dial's faces and icons at 0.6x (`scripts/gen_fonts.sh`, `tools/gen_c3_icons.py`) |
| `main/ui/ui_fonts.h` | Geist `extern`s (Montserrat only for `LV_SYMBOL_*`) |
| `main/wifi_sta.h/.c` | STA scan / join / NVS SSID+PSK |
| `main/wifi_cable.h/.c` | mDNS `_harness-dial._tcp:17420`, one TCP client, USB-bind only |
| `scripts/build-cores3.sh`, `scripts/flash-cores3.sh`, `scripts/update-upstream.sh` | build / flash / rebase tooling |
| `scripts/cores3-snap.py`, `scripts/cores3-shots.py` | screenshots over the cable (`debug.snap` / `debug.show`) |
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

## Buttons, the key on the glass, and sleep

The round dial has two keys: BOOT (back / stop turn) and PWR (the screen). The CoreS3 has only PWR, so the
dial's BOOT key is drawn on the glass instead (the circle in the top-right corner, as on the Apple Watch
clone), and PWR does what it does on the dial:

| Input | Round dial | CoreS3 |
|---|---|---|
| PWR key tap (AXP2101 PWRON) | screen on/off | screen on/off (`ptt.c`) |
| PWR long press | nothing | AXP2101 hardware: power-off at ~4 s |
| BOOT tap | back / stop turn (`ui_boot_pressed`) | the on-screen key: the same, then **back**: it closes whatever is open, then leaves for the Overview (`ui_key_pressed`) |
| Screen idle | panel off after 5 min | the same, backlight off too |

The key turns red whenever it would stop something (a voice turn, or the busy agent on screen). It sits
above every overlay, and a press on it is never taken for the notification pull or a tap-to-stop.
There is no factory-reset-at-boot gesture (no BOOT key): Settings → Reset device, behind the dial's own
confirm, does it.


## Rendering at 320x240

LVGL renders at the panel's own resolution (`BSP_LCD_H_RES/V_RES` = 320x240). The flush byte-swaps each
40-line strip in place (`lv_draw_sw_rgb565_swap`) and hands it to the SPI DMA; the DMA-done callback
completes the flush, so LVGL renders the next strip while this one travels. No framebuffer, no copy.

The layout is the dial's, scaled rather than rewritten: every geometry number in `ui_screens.c` is in the
dial's 466-pixel design and passes through `PX()`: identity on the dial, 0.6x here, which is the dial's
physical size on this glass (~326 ppi against ~200). Fonts and icons are generated at the same scale and
mapped onto the dial's names (`ui_fonts.h`, `icons_c3.h`), so one source serves both boards. Where the
rectangle wants something the circle does not, a few `DEVICE_BOARD_M5CORES3` values say so: the content
column (`SAFE_CONTENT_W` 500 → 300 px), the Overview's seats, the Settings row width, the lock grid, and
square full-screen overlays. Touch distances are halved (`touch.c`), the same finger travel as the dial;
scroll deltas go out in the dial's pixels.


## Fonts

The dial's Geist faces at 0.6x (`geist_c3_*`, generated by `scripts/gen_fonts.sh`), mapped in `ui_fonts.h`.
`LV_SYMBOL_*` stay on Montserrat, at 12/14/18/24.


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

## The clock

The daemon states its time and UTC offset in every `welcome` (`now`, `tzOffsetMin`). The CoreS3 sets its
system time and the BM8563 RTC from it, and keeps the offset in NVS, so the chrome shows the time from boot.
Until the time has been set once (a fresh RTC reports lost power), the time is simply not shown.


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

- One physical key: the BOOT key's role is on the glass (see "Buttons" above).
- Host-driven firmware updates (`fw_update.c`) need a second OTA slot; under
  Launcher's single-app partition the update request reports failure instead of
  flashing. Reinstall via the SD card instead.
- A USB **host** module on the CoreS3 can blank the panel; flash/use the USB-Serial/JTAG port
  (`/dev/cu.usbmodem*`), not a host dongle.
- WiFi STA is on the device; agents over WiFi need this checkout's daemon (see "WiFi and the
  cable"). OTA stays USB.
- **Not done:** GitHub PR. Work is on the local `cores3` branch, uncommitted as of this note.
  First upstream PR should be the USB hardware port with the WiFi menu off; LAN + bind as a
  follow-up with the daemon `TcpLink`.
