# Harness Pro

Firmware for the Harness Pro: an ESP32-P4 with a 720x720 touch display. It shows the Pod face and talks to the
Harness daemon over the cable protocol.

## Build

Needs ESP-IDF 5.5.4 (installed at `~/esp/esp-idf-5.5.4`) and Python with Pillow (the build generates the fonts).

```sh
. ~/esp/esp-idf-5.5.4/export.sh
cd devices/harness-pro/firmware
idf.py -B build -DPROJECT_VER=0.0.99-pod build
```

- `PROJECT_VER=0.0.99-pod` keeps a dev build from being overwritten by the daemon's OTA update.
- The picture and touch are drawn in the panel's own orientation; there is no turn and no setting.

## Flash

```sh
devices/harness-pro/firmware/scripts/flash.sh [--build-dir DIR]
```

Warning: a wrong-revision image bricks the board, because of its power latch. The script checks the chip revision
(ESP32-P4 v3.2) and the MAC before it writes anything, and exits with status 2 if either differs. Never bypass it.
The script stops the daemon for the flash and starts it again afterwards.

## Host tests

No board needed. Python 3, Pillow, a C compiler, and an ESP-IDF checkout with `components/json` (set `IDF_PATH`;
default `~/esp/esp-idf-5.5.4`).

```sh
bash devices/harness-pro/firmware/test/run.sh
python3 devices/harness-pro/firmware/test/test_tree_isolation.py
python3 devices/harness-pro/firmware/test/test_fonts.py
```

`run.sh` also runs the app, hello and voice-gate tests. It can also check the Pets render time (`test/test_ph_perf.sh`: each screen within 85% of its recorded host time in `test/ph_perf_baseline.txt`). That check is opt-in, because absolute microseconds recorded on a Mac are flaky on shared or Linux CI machines: run it with `PH_PERF=1` (`PH_PERF_RECORD=1` prints fresh numbers).

Golden screens: `firmware/test/golden.sh --check` renders every Pod screen at five instants and compares hashes with
`test/golden.txt` (or `golden-liberation.txt` when `PRO_FONT` is Liberation). Run it after any change to drawing or
assets; it must match. Rewrite the baseline (`golden.sh` without `--check`) only for an intended visual change.

Fonts: the generator uses Helvetica on macOS and the bundled Liberation Sans elsewhere. Tests and CI set
`PRO_FONT=devices/harness-pro/firmware/fonts/LiberationSans-Regular.ttf`. The generated `pro_fonts.c` is a build
artifact: never commit it.

## Pets

`firmware/scripts/import_pets.sh <round-habitat-dir>` copies the round dial's `pets.c` and `pets.h` into
`firmware/main/pod/`. It is a one-way copy, run only on request. It then runs `prune_pets.py`, which drops what Pod
never plays (the alert scenes, the small working and done loops) and Codex's row.

Codex is HD and is not imported: `firmware/scripts/upscale_codex.py` upscales the art into `firmware/assets/codex/hd`,
`firmware/scripts/gen_pro_codex.py` turns that into `firmware/main/pod/pets_codex.c` (`pod_codex_pet`), and
`pod_pet_for("codex")` returns it ahead of `ht_pets`. It is drawn at zoom 8 in the Agent room and on the voice screen; the cards, Inbox and Recap draw it below 1x, in sixteenths.
The generator copies the round's Codex timings and geometry as literals, so a retime on the round does not propagate: update them by hand.
`test/codex_size.py` holds its on-screen size.

## Size

No Wi-Fi: the Pro talks over the cable only, and the module's ESP32-C5 is held in reset. Fonts 42 and 56 carry masks
only for `# > _ ?`, and font 32 only for `> _` (`test_fonts.py` fails on any other character drawn at those sizes). The image is about 1.87 MB;
`docs/size-baseline.txt` has the before and after.

## Layout

- `docs/`: the cable contract and the port inventory.
- `firmware/main/app/`: app layer, touch, and the glue between the Pod model and the cable.
- `firmware/main/audio/`: microphone capture, recorder and the voice state machine.
- `firmware/main/board/`: board pins, I2C, power latch, the C5 held in reset, push-to-talk button.
- `firmware/main/cable/`: cable link, frame parsing, JSON guard, features, machines, scroll.
- `firmware/main/display/`: panel and bus, GT911 touch, compositor, canvas, terminal, fonts.
- `firmware/main/pod/`: the Pod model, navigation, views, pets and engine logos.
- `firmware/main/sys/`: config store, device MAC, last words, RAM telemetry.
- `firmware/fonts/`: bundled Liberation Sans for tests and CI.
- `firmware/scripts/`: font generator, flash, pet import, logo generator.
- `firmware/test/`: host tests, host stubs and the tree-isolation check.

## Daemon contract

The device follows [docs/cable.md](docs/cable.md). A capability in the hello turns on extra daemon output; a daemon
that predates one ignores it. The six capabilities:

- `swarms: "members-v1"`: agent ids and members on each swarm tab.
- `recap: "long-v1"`: the full answer text on a summary.
- `activity: "steps-v1"`: step, action and elapsed time on turn activity.
- `stats: "turn-v1"`: the counts on a finished turn (tests, commits, tokens).
- `player: "library-v1"`: the paged player library request and reply.
- `ota: "v1"`: the daemon may offer firmware over the cable.

## Further reading

- [Design spec](../../docs/superpowers/specs/2026-10-11-harness-pro-firmware-design.md)
- [Implementation plan](../../docs/superpowers/plans/2026-10-11-harness-pro-firmware.md)
- [Port inventory](docs/port-inventory.md)
