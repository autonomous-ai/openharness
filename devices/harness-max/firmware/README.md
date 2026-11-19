# Harness Max firmware

Firmware for the Harness Max: an ESP32-P4 with an 8.8" touch panel used on its side, 1920 x 480. It shows the cabled
computer's agents as lanes and talks to the Harness daemon over the Pro's cable protocol (the hello says
`board: "max"`). The design is `docs/superpowers/specs/2026-11-17-harness-max-design.md`.

Nothing here has been on a bench yet. The pins, addresses and module settings come from Waveshare's BSP
(`waveshare/esp32_p4_platform` 2.0.1, `waveshare/esp_lcd_ota7290b` 2.0.0) and wiki: see `main/board/pins_max.h` and
`sdkconfig.defaults`.

## What is whose

The Max compiles the Pro's generic sources where they are (`devices/harness-pro/firmware/main`: the cable, `sys/`, the
compositor, the strip path, the finger's contact rules, the recorder) at its own glass size, and the Pro's
`components/esp_driver_usb_serial_jtag` and `bootloader_components/wdt_pc` sources. Its own code is the board
(`main/board/`), the panel, touch, backlight and turn behind the Pro's `pro_display.h` (`main/display/`), the ES8311
behind the Pro's `audio/audio_capture.h` and the chimes (`main/audio/`), the lanes screen and the app (`main/app/`), and `app_main.c`.
A change under `devices/harness-pro/` can break the Max: build both.

## Build

Needs ESP-IDF 5.5.4 (installed at `~/esp/esp-idf-5.5.4`) and Python with Pillow (the build bakes the Pro's fonts).

```sh
. ~/esp/esp-idf-5.5.4/export.sh
cd devices/harness-max/firmware
idf.py -B build -DPROJECT_VER=0.0.99-dev build
```

- `PROJECT_VER=0.0.99-dev` keeps a dev build from being overwritten by the daemon's OTA update.
- `-DPRO_PYTHON=/path/to/python` when the first `python3` on the PATH has no Pillow; `-DPRO_FONT=/path/font.ttf` picks
  the text face as on the Pro.
- The app draws landscape; `main/display/max_turn.c` turns every strip into the panel's portrait framebuffer, and every
  touch back. If the picture comes out upside down, set `MAX_TURN_FLIPPED` to 1 in `main/display/max_turn.h`: the
  finger turns with it.

The same sources also build as a Linux program: a simulator window on the Mac, and the Orange Pi 4 Pro's bar for
demos. See `linux/README.md`.

## Flash

The bring-up board is a Waveshare ESP32-P4-NANO. Its USB-C is a CH343 USB-UART bridge on UART0, which flashes with the
usual auto-reset:

```sh
idf.py -B build -p /dev/cu.wchusbserialXXXX flash
```

The image needs a v3.x P4 (the NANO's P4NRW32X); it does not boot on a v1.x chip. The Max has no power latch, so a
wrong image is fixed by flashing again.

## The cable: GPIO24 and GPIO25

The daemon talks to the Max over the P4's own USB-Serial-JTAG, as to the Pro: it is also the console, so a panic and
the boot log go out the same wire. On the P4 it is GPIO24 (D-) and GPIO25 (D+). The NANO does not route these to a
connector, so for bring-up wire them to a USB cable: GPIO24 to D- (white), GPIO25 to D+ (green), GND to GND, and power
the board from its own USB-C. The product board brings them to its USB port.

## Host tests

```sh
bash devices/harness-max/firmware/test/run.sh
bash devices/harness-max/firmware/test/golden.sh --check
```

`run.sh` runs the lanes model, view and touch tests, the app layer (`test/test_max_app.c`: `main/app/max_app.c` over
the real model, with the cable, the recorder and FreeRTOS as host fakes) and the strip turn (`test/test_max_turn.c`).
The chimes' samples, which both boards render (`main/audio/max_chime_pcm.c`), are checked by `linux/`'s `test_chime`.
`golden.sh --check` renders each screen to 1920 x 480 and compares hashes. The Pro's `test/run.sh` also runs the strip
path at 1920 x 480.

## On the bench

When the board arrives, check and write the numbers here:

1. It boots: the PSRAM (hex, 200 MHz) and flash (QIO) settings are the module's as documented, never seen running.
2. The panel lights and the picture is the right way up (else `MAX_TURN_FLIPPED`). The backlight follows the
   brightness setting; asleep, register 0x96 at 0 is dark.
3. Touch: the boot log names the address that answered (0x14 or 0x5D); a tap lands where the finger is.
4. The heartbeat line (`alive ... raster_max_us=... frame_max_us=...`): the longest frame for a full screen and for one
   lane, and the time `pro_panel_submit` spends turning a strip. If the CPU turn is too slow, the P4's PPA does it.
5. Free internal RAM and PSRAM from the heartbeat (`heap=`, `psram=`). The strip and the turned band take 2 x 90 KB of
   internal RAM.
6. Audio: the chimes (`main/app/max_chime.h`: a question's or a failure's two tones, a finished turn's two soft notes)
   at the Pro beep's loudness, and a recording at a usable level (the mic gain is 36 dB, a guess).
7. The C6 stays in reset (GPIO54 low) and draws no current to speak of.
