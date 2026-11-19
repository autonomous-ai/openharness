# Harness Max as a Linux program

The Max firmware's own sources, built as a Linux (or macOS) program: the same app, lanes, compositor and cable
protocol as the ESP32-P4 image, over Linux drivers. A board change is a build target. `../sources.cmake` is the one
list of portable sources; `../main/CMakeLists.txt` adds the ESP32-P4 drivers to it, this directory adds:

- `esp/`: the FreeRTOS and ESP-IDF calls the shared sources make, on pthreads and the C library (the frame's helper
  task is a thread). NVS is a text file,
  `~/.config/harness-max/nvs`. The firmware updater refuses every image (the version is `0.0.99-dev` and the board
  `harness-max-linux`, which the daemon never offers one).
- `display/`: `pro_display.h` and the frame path's strips (`../main/display/max_strips.h`: both tasks' strips copied
  into the glass under one lock) over an SDL window (`MAX_LINUX_OUTPUT=sdl`, the mouse is the finger) or DRM/KMS plus
  evdev touch (`MAX_LINUX_OUTPUT=drm`, `/dev/dri/card0`). `glass_fit.c` scales and turns the glass to the output, and
  maps a touch back. DRM keeps two buffers: each frame is painted whole into the one off screen (what it changed and
  what the frame before changed) and flipped to on the next vblank, so nothing tears. Where the driver refuses the
  second buffer or a flip, the log says so once (`no second scanout buffer` / `page flip refused`) and the one buffer
  on screen is painted as each strip lands, as before.
- `audio/`: `audio/audio_capture.h` and the chimes (`../main/app/max_chime.h`) over SDL (macOS) or ALSA (Linux): the
  microphone is the capture device `HARNESS_MAX_MIC` names (`default` when unset). No microphone: recording fails as
  on a device whose codec does not answer. The chimes are V3's as tuned on the bar (`bar_chime.c`): each between 50 ms
  of near silence before and 300 ms after, with no sample of digital silence, which the board's codec mutes on. They
  play on the ALSA device `HARNESS_MAX_SPEAKER` names, else the board's codec (`plughw:CARD=sndi2s4,DEV=0`), whose
  DAC is set to `HARNESS_MAX_SPEAKER_VOLUME` (0..255, 171 when unset) once before the first; a speaker that fails
  gives way to the screen's HDMI audio (`plughw:CARD=allwinnerhdmi,DEV=0`). The simulator plays the same samples on
  the default output. A chime is dropped while one plays or the microphone is open.
- `cable/`: `cable_link.h` with the far end picked when the program starts: `--live` (the default) takes a real daemon
  over TCP in the USB framing, `--usb` a real daemon over the USB cable through a gadget's serial port (`/dev/ttyGS0`),
  `--demo` runs the scripted daemon in `../main/demo` inside the program for a person to drive: every agent rests and
  nothing moves by itself. Talking to an agent starts its turn with the mockup's line; rate-limiter, landing-hero,
  firmware-max and harness-cli play their case (a failed test run, a question only Orca answers, a permission prompt, a
  question the bar answers by tap or by voice) on the 1st, 3rd, 5th... words, their line in between. New Harness
  agents stay until a re-plug (14 agents at most). `--story` runs the same daemon playing its 160 s story by itself, in
  a loop (the old `--demo`).

The glass is 1920 x 480 by default, the ESP32-P4 panel's, so the bar shows exactly what a Harness Max draws: the
Orange Pi's 1480 x 320 bar shows it at 1280 x 320 in the middle, 100 px of black either side, and a touch on the black
does nothing. `-DMAX_GLASS_H=415` builds the bar's own shape at the device's width (1480 x 320 scaled by 0.771), which
fills the bar but is drawn by no device. A build directory keeps the height it was first configured with (CMake's
cache): one configured before 480 became the default stays 415 until `-DMAX_GLASS_H=480`.

## The simulator (macOS)

Needs Homebrew's `sdl2` (sdl2-compat) and `pkg-config`, CMake (3.20 or newer for `ctest --test-dir`; ESP-IDF's
works), Python with Pillow (the fonts are baked
at build time), and ESP-IDF's cJSON (`~/esp/esp-idf-5.5.4`, else `-DCJSON_DIR=.../components/json/cJSON`).

```sh
cmake -S devices/harness-max/firmware/linux -B build/max-sim            # -DMAX_GLASS_H=415 for the bar's own shape
cmake --build build/max-sim -j
ctest --test-dir build/max-sim                                         # the host tests of this directory
build/max-sim/harness-max                                              # waits for a daemon on port 7531
build/max-sim/harness-max --demo                                       # the demo, driven by the person
build/max-sim/harness-max --story                                      # the demo playing its story by itself
build/max-sim/harness-max --story --screenshot 8 lanes.bmp             # saves the glass after 8 s and quits
```

A daemon reaches `--live` with `HARNESS_CABLE_TCP=localhost:7531` (or `<address>:7531` for a board), the dev-only TCP
transport of `cli/src/cable/cableTcp.ts`. `--port N` listens on another port.

**`--live` is for development only.** The port is open on every interface with no authentication: anyone on the
network can drive the bar and read what the daemon sends to it. Use it on a trusted network. For the same reason the
daemon answers no permission prompt over TCP: approving takes `--usb`.

The daemon here is the branch's: `cli/scripts/install-cli.sh` installs this tree's CLI as `harness` on the Mac (a
`-dev` build that no release replaces on its own; `harness update --force` goes back to the release).

## The Orange Pi 4 Pro's bar

The bar is the 11.9" 1480 x 320 HDMI panel, which the board drives as 320 x 1480 portrait: the program turns the
picture a quarter and scales 1920 x 480 to 1280 x 320 in the middle of it, and turns touch back. From the Mac:

```sh
devices/harness-max/firmware/linux/deploy-orangepi.sh                    # the Mac's daemon over the USB cable
devices/harness-max/firmware/linux/deploy-orangepi.sh --live             # the Mac's daemon over TCP
devices/harness-max/firmware/linux/deploy-orangepi.sh --demo --no-build  # the demo, without building again
devices/harness-max/firmware/linux/deploy-orangepi.sh --story --no-build # the demo's story, playing by itself
```

It copies the sources to the board, builds there (`MAX_LINUX_OUTPUT=drm`, `MAX_GLASS_H=480`), runs the host tests,
installs `~/harness-max/bin/harness-max` and restarts `harness-max.service` (`orangepi/`), which starts it through the
Phase 0 boot wrapper for its fbcon and HDMI hotplug handling. `--no-build` only switches the installed bar to the mode.
The board comes from `HARNESS_MAX_BOARD` / `HARNESS_MAX_SSH_OPTS` or near-demo's `~/.config/near/board.env`. The first
run asks for the board's sudo password once to install the unit, the USB gadget's script (`orangepi/harness-max-usb`)
and a sudoers rule for switching. The board needs `cmake pkg-config libdrm-dev libasound2-dev python3-pil` from apt.

With `--usb` the bar is a USB device on the board's one Type-C port, with the Harness devices' USB ids: the cable to the
Mac carries the cable protocol, as a Harness Max's does, and powers the board (the port is also its power input). The
gadget exists while the app runs. The microphone is the USB one Near's voice service uses, which stops while the bar
runs (`HARNESS_MAX_MIC` in the unit).

Switching the bar. Near and Harness Max Demo V3 (`../../flutter`) both run under Near's `near-app.service`, which
starts the Flutter bundle `~/near/mode.env` names; `near-demo` and V3's `deploy-orangepi.sh` each write that file.
`harness-max.service` conflicts with `near-app` and `near-voice`, so starting either side stops the other (one DRM
master at a time), and this script leaves `~/near/mode.env` and V3's `near-voice` drop-in as they are:

| To | On the Mac | On the board |
| --- | --- | --- |
| Harness Max (this build) | `deploy-orangepi.sh [--usb / --live / --demo / --story] --no-build` | `sudo systemctl start harness-max` |
| Near | `near-demo` | `sudo systemctl start near-app`, when `~/near/mode.env` names Near |
| Harness Max Demo V3 | `devices/harness-max/flutter/deploy-orangepi.sh [mode] --no-build` | `sudo systemctl start near-app`, when `~/near/mode.env` names `near/app-max` |

The demo (`--demo`, `--story`, `../main/demo`) is temporary: it goes once this branch is merged into main.

The unit has no `[Install]`: a reboot comes back to `near-app`, with the bundle `~/near/mode.env` names (Near, or V3
when V3 was deployed last).

## Known

- Touch near the top right of the bar reads 35-40 px left of the finger. The program maps the panel's raw axes as
  libinput and flutter-pi do, and the Near app records the same offset on this panel, so it is the panel's own; it is
  not corrected here. Make targets near that corner wider than they look.
- The board bakes the text in Liberation Sans, the Mac in Helvetica (the Pro's font choice in `../sources.cmake`).
- Frame time on the bar (measured 2026-11-17, the unit's A76 pair, `ondemand` governor): a clock or status change
  0.4-0.6 ms, a lane change up to 9 ms, a full-screen change about 47 ms, the first frame 58 ms (102 ms when not
  pinned to the A76 pair, hence `CPUAffinity=`). The scaled paint is at most 3 ms of a frame; the rest is the
  renderer. The program idles at about 2% of one core. These predate the page flip: a frame now also waits, at most a
  refresh, for the last one's flip before it is painted, and paints the last frame's change again into the other
  buffer.
