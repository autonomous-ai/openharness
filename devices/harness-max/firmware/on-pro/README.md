# Harness Max on the desk Harness Pro

A stopgap image: the Max's screens, cable and voice running on a Harness Pro, to see them on real ESP32-P4 hardware
until a P4 board with the 8.8" 1920 x 480 panel is on the bench (roadmap M2, its option 1). Not the product: the product
builds from `..` and never looks in here.

- **Glass.** The Max draws its 1920 x 480 glass as on the bar; at the end of each frame the blocks it changed are shrunk
  by 3/8 (every 8 x 8 glass pixels into 3 x 3, each the area average) into a 720 x 180 band across the middle of the
  Pro's 720 x 720 panel (`main/max_shrink.h`, host test `../test/test_max_shrink.c`). Text is 37.5% of its 8.8" size;
  above and below the band is black.
- **Touch.** The Pro's GT911, taken back to the glass; a touch off the band is cancelled.
- **Audio.** The Pro's microphones (ES7210) record voice as on the Pro; every Max chime is the Pro's notification beep.
- **Board.** The Pro's own drivers (panel, backlight, touch, I2C, power latch, audio), compiled where they are,
  untouched. To the daemon it is a Max (`hw` "harness-max", `board` "max"); the `-dev` version is never offered an image.

## Build

```sh
. ~/esp/esp-idf-5.5.4/export.sh
idf.py -B build -DPROJECT_VER=0.0.99-dev build   # -DPRO_PYTHON=<python with Pillow> if the fonts' bake cannot find one
```

## Load it on the Pro, and put the Pro back

Only into the Pro's spare slot (`ota_1`), never over its own firmware (`ota_0`), with the bench script that backs up and
restores `otadata` and `ota_1` byte for byte (`harness-pro-device/pro_bench.sh`). Stop the daemon first, which holds the
port: `date +%s > ~/.harness/flasher/flashing` BEFORE `harness stop`, then:

```sh
pro_bench.sh load build/harness_max_on_pro.bin <backup-dir>   # boots the image once, on trial
pro_bench.sh read 20 boot.txt                                  # its console (optional)
rm ~/.harness/flasher/flashing && harness start                # the daemon greets it as a Max
```

The image is never confirmed, so any reset of the Pro (its cable pulled and put back included) boots the Pro's own
firmware again. To leave no trace in `ota_1` and `otadata`, with the daemon stopped as above:

```sh
pro_bench.sh restore <backup-dir> && pro_bench.sh verify <backup-dir>
```
