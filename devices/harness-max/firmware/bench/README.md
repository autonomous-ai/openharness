# Harness Max display bench

How long Harness Max's display path takes on an ESP32-P4, with the product's own scenes: the 38 screens of
`../test/max_render.c` (the goldens'), built and rasterised as `main/display/max_display.c` does it, the strip turn on
the CPU and on the PPA, a cached layer's copy, and the glass split over both cores. It prints a report every 5 s,
forever.

It is an ESP-IDF app of its own, never part of the product image (the product builds from `..` and never looks in
here). It runs on any ESP32-P4 v3.x with 32 MB of PSRAM, such as a Harness Pro, because it uses the SoC alone: the CPU,
the memory, the PPA and its 2D-DMA. It initialises no pin, bus, panel, touch, codec or LED, writes no flash (no NVS, no
otadata) and never marks its image valid. Its CPU, flash, PSRAM, cache and compiler settings are the product's
(`sdkconfig.defaults`; the build's `sdkconfig` matches `../sdkconfig` on every one of them).

`profile.sh` builds the same timing code (`bench_raster.c`, `bench_scenes.c`) for this computer, split by run kind:
where the renderer's time goes, without a board.

## Build

ESP-IDF 5.5.4, and a Python with Pillow for the font bake:

```sh
export PATH="$HOME/.espressif/tools/cmake/3.30.2/CMake.app/Contents/bin:$PATH"
. ~/esp/esp-idf-5.5.4/export.sh
cd devices/harness-max/firmware/bench
idf.py -DPRO_PYTHON=$HOME/.venvs/harness-fw/bin/python build
```

The image is `build/harness_max_bench.bin` (about 3.9 MB; the app slot is 0x7E0000). ESP-IDF reads `sdkconfig.defaults`
only when it creates `sdkconfig`: delete `bench/sdkconfig` after changing the defaults.

## Flash

Only the app, into the `ota_1` slot of a board whose bootloader (ESP-IDF 5.5.4) and partition table are the Pro's:
nvs 0x9000, otadata 0xf000, phy_init 0x11000, ota_0 0x20000, **ota_1 0x800000**, each slot 0x7E0000 (8064 KB).

```sh
esptool.py --chip esp32p4 -p PORT write_flash 0x800000 build/harness_max_bench.bin
```

The bootloader boots what otadata selects. The bench never confirms itself, so whether a reset goes back to `ota_0` is
the otadata entry's state:

- Selected the way an OTA update does (`esp_ota_set_boot_partition` with rollback on, state NEW): the first boot runs
  the bench (PENDING_VERIFY), the next reset rolls back to `ota_0`, the Pro's own firmware.
- Selected with `otatool.py switch_ota_partition --slot 1`: otatool writes the sequence number only and leaves that
  otadata sector's old state, so a reset may come back to the bench. Go back with
  `otatool.py switch_ota_partition --slot 0`.

The report is on the USB-Serial-JTAG console, the Pro's USB-C port (`idf.py -p PORT monitor`, or any terminal).

## Reading the report

Times are milliseconds, the best of a few runs on core 1 (where the product's render task runs), the CPU's cycle
counter at the clock the header names. Nothing scans PSRAM out to a panel meanwhile: on the product the panel's DMA
reads 480 x 1920 x 2 bytes 60 times a second (about 110 MB/s) from PSRAM, so PSRAM-bound numbers there are worse.

- **(a, e) whole glass**, one line per screen. `build`: `max_ui_render`, the scene the render task builds every frame.
  `cold`: the raster with no pet cell baked (the first frame, and every new pet frame). `warm`: the raster as a
  repaint. `2 cores`: the same strips alternating between the two cores, each into its own internal strip; `speedup`
  is warm over that. A full repaint is `build` + `warm` + the turn below for 20 strips.
- **(a) by run kind**: the warm raster of every screen once, run by run through `ht_raster`'s loop, split by kind:
  where a repaint's time goes, and what a pixel of each kind costs on the chip (`ns/px`; `background` is the fill
  under every strip).
- **(a) partial frames**: what changes most often, as `pro_frame_present` repaints it: the listening band (ten times a
  second while the person talks), the agent page's counter (once a second), an Overview cell's line.
- **(b) CPU turn**: `max_turn_pixels` of a 1920 x 24 strip, and of the 20 strips of the glass.
- **(c) PPA SRM turn**: each quarter turn and mirror the PPA has, against `max_turn_pixels`: exactly one should say
  `SAME`, and it should be `ccw 270` with no mirror (`MAX_TURN_CCW_DEGREES`, what the product asks for). Then its time
  into the internal band (the product's path: compare with (b)) and straight into a PSRAM framebuffer, and
  `product max_turn_ppa`: the product's own function (`main/display/max_turn_ppa.c`) on every strip shape the renderer
  sends, all of which must be the same as `max_turn_pixels`.
- **(d) a layer's copy**: a 1169 x 480 RGB565 layer (Overview's row of cells) copied PSRAM to PSRAM and PSRAM to the
  internal strips, by `memcpy` a row at a time and by the PPA, with MB/s: what drawing a cached layer would cost.

What to do with it:

- If `product max_turn_ppa` is not `8/8` or the PPA turn is slower than (b), the product should turn on the CPU: the
  PPA path is one commit, `Harness Max: the PPA turns the strips ...`; revert it.
- The full-repaint frame time (`build` + `warm` + 20 turns) against the 16-33 ms a moving row needs says whether motion
  can repaint whole strips or needs damage-sized frames, two cores, or cached layers ((d)).
