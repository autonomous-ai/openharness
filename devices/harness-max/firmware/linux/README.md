# Harness Max as a Linux program

The Max firmware's own sources, built as a Linux (or macOS) program: the same app, lanes, compositor and cable
protocol as the ESP32-P4 image, over Linux drivers. A board change is a build target. `../sources.cmake` is the one
list of portable sources; `../main/CMakeLists.txt` adds the ESP32-P4 drivers to it, this directory adds:

- `esp/`: the FreeRTOS and ESP-IDF calls the shared sources make, on pthreads and the C library. NVS is a text file,
  `~/.config/harness-max/nvs`. The firmware updater refuses every image (the version is `0.0.99-dev` and the board
  `harness-max-linux`, which the daemon never offers one).
- `display/`: `pro_display.h` over an SDL window (`MAX_LINUX_OUTPUT=sdl`, the mouse is the finger) or DRM/KMS plus
  evdev touch (`MAX_LINUX_OUTPUT=drm`, `/dev/dri/card0`). `glass_fit.c` scales and turns the glass to the output, and
  maps a touch back.
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
  `--demo` runs the scripted daemon in `../main/demo` inside the program.

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
build/max-sim/harness-max --demo                                       # the demo
build/max-sim/harness-max --demo --screenshot 8 lanes.bmp              # saves the glass after 8 s and quits
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

Switching the bar (each service stops the other; there is one DRM master at a time):

| To | On the Mac | On the board |
| --- | --- | --- |
| Harness Max | `deploy-orangepi.sh [--usb / --live / --demo] --no-build` | `sudo systemctl start harness-max` |
| Near | `near-demo` | `sudo systemctl start near-app` |

The demo (`--demo`, `../main/demo`) is temporary: it goes once this branch is merged into main.

The unit has no `[Install]`: a reboot comes back to Near.

## Known

- Touch near the top right of the bar reads 35-40 px left of the finger. The program maps the panel's raw axes as
  libinput and flutter-pi do, and the Near app records the same offset on this panel, so it is the panel's own; it is
  not corrected here. Make targets near that corner wider than they look.
- The board bakes the text in Liberation Sans, the Mac in Helvetica (the Pro's font choice in `../sources.cmake`).
- Frame time on the bar (measured 2026-11-17, the unit's A76 pair, `ondemand` governor): a clock or status change
  0.4-0.6 ms, a lane change up to 9 ms, a full-screen change about 47 ms, the first frame 58 ms (102 ms when not
  pinned to the A76 pair, hence `CPUAffinity=`). The scaled paint is at most 3 ms of a frame; the rest is the
  renderer. The program idles at about 2% of one core.
