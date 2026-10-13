# Harness Pro firmware as its own project

Status: design, approved in conversation on 2026-10-11, awaiting written review.

## Goal

The Harness Pro (ESP32-P4, 720×720) gets its own firmware under `devices/harness-pro/`, unrelated to the round dial's firmware.

The two devices are two interfaces to the same daemon, the way a web client and a mobile client share a backend. The cable protocol is the contract between them, and each device names the features it wants in its hello.

The Pro's only interface is Pod, the iPod-style UI that was built and tested on the Pro on `dev/firmware-pro` (0c73edf72).

## Why

- On 2026-09-29, main's 977638b2c ("one firmware, three skins") deliberately removed every Pro source, the ESP32-P4 board and LVGL.
- `dev/firmware-pro` forked the round tree the day before that commit. Since then the round firmware on main has changed by about 36k added and 289k deleted lines across 89 files.
- On that branch the Pro build is the round tree with flags. `ui_habitat.c` has 7,876 lines, of which 284 are `#ifdef DEVICE_POD` or `DEVICE_PRO_COMPANION` sections. A trial merge with main conflicts in 36 files.
- Keeping the two firmwares in one tree couples them. Fixes do not carry across, and every merge is a port. Separating them ends that.

## Scope

**In scope:**
- A new ESP-IDF project at `devices/harness-pro/firmware`, for esp32p4 only.
- Pod moves in as it is: model, nav, views, pets, logos, drawing kinds.
- The P4 board layer, display and touch, compositor, fonts, cable link, audio capture, config, OTA client and Wi-Fi, carried over from what the Pod build compiles today.
- A slim app layer and a slim cable client that replace the round's `ui_habitat.c`, `ui_screens.h` and the Pod hooks inside them.
- The daemon support Pod relies on, ported onto main's `cli/src/cable` and gated by hello capabilities. This may include the small desktop part.
- Pro host tests in the firmware CI job, a README, and the Pod mockups gathered under `devices/harness-pro/mockup`.

**Out of scope:**
- Any change to `devices/harness-device`.
- Player 1, Living, Daemon and Studio, and the round's characters (octopus, tim, tux).
- A Pro OTA and release channel (board key, publishing). That is a later step; until then Pro images are flashed by hand, as today.
- Creature voice and device speech (`creatureVoice`, `cableSpeech`) unless the inventory in Phase 4 shows Pod uses them.

## Layout

```
devices/harness-pro/
  README.md                 build, flash, test, and the board's MAC/revision guard
  docs/cable.md             the Pro's capabilities and the messages they turn on
  mockup/                   Pod mockups (moved from harness-device/firmware/mockup)
  firmware/                 ESP-IDF project, IDF 5.5.4, esp32p4 only
    CMakeLists.txt  sdkconfig.defaults  partitions.csv  idf_component.yml  dependencies.lock
    main/
      app_main.c            bring-up: board, power latch, display, Wi-Fi/cable, audio, then Pod
      pro_app.c/.h          the app layer: display lock, frame loop, touch, voice, notices, focus
      board/                board_pro, power_pro, ptt_pro, pro_wifi, board_i2c, pins
      display/              ST7703 panel and bus, GT911 touch, strip display loop, compositor, pro_canvas, fonts
      cable/                cable_link, cable_frame, json_guard, features, pro_cable (the client)
      audio/                audio_capture, audio_client, voice_buffer
      sys/                  config_store, device_mac, fw_update, last_words, ram_telemetry
      pod/                  Pod, unchanged except for include paths
    scripts/                pod_gen_logos.py; import_pets.sh (a one-way copy from the round's assets)
    test/                   run.sh with the Pod host tests and pod_render
```

## Boundaries

- **`pod/` is pure C11** and knows nothing of ESP-IDF. Its interface is what it already exposes: `pod_model_*` feeds, `pod_nav_*`, `pod_ui_*` from today's `pod_glue`, and `pod_view` into an `ht_scene_t`.
- **`pro_app` is the only code that touches Pod and the platform together.** It owns the display mutex, the frame loop and damage/raster through the compositor, touch dispatch, the voice gate and recording, notices, and the clock.
- **`pro_cable` parses cable messages and calls a narrow `pro_app_*` API.** That API is one function per message family: hello/link state, agents, swarms, library, player context, turn started/activity/step/done/error, summary and full recap, question/close, focus, scroll echo, voice results, machines, and the fw-push hooks fw_update needs.
- **Nothing in the Pro project includes `ui_screens.h`** or implements stubs for features it does not have.
- **Messages for features the Pro does not have are ignored.** These are carry, draft, form, visit, workspace, selection, metrics and perf. The Pro does not ask for them in its hello, so a daemon should not send them.
- **The compositor (`terminal.c`/`.h`, `display_habitat`, `pro_canvas`) keeps only what Pod draws.** That is pro runs, text, rects, images and the Pod kinds. The round's mono and arc text paths go wherever no Pod screen needs them.
- **Pets and engine logos are Pro-owned generated sources.** `import_pets.sh` refreshes `pod/pets.c` from the round's assets when the owner asks. There is no build-time link to `devices/harness-device`.

## Daemon contract

The daemon serves each device by its hello. Main's daemon sends the round exactly what it sends today; the Pro's capabilities turn on more. The capabilities and what they enable:

| hello capability | the daemon then sends |
|---|---|
| `swarms: "members-v1"` | `swarms` items with `agentIds` and `members` (offline members included), size-capped |
| `recap: "long-v1"` | `summary.full`, the longer answer text, up to 1200 chars |
| `activity: "steps-v1"` | `turn.activity` with `action` (the latest progress paragraph), `elapsedSeconds`, and `step` lines for each tool started |
| `player: "library-v1"` | `player.library` pages and `player.context` |

Before porting, Phase 4 inventories the messages and fields that `dev/firmware-pro`'s daemon sends and Pod consumes. Only those are ported. Each one gets a spec proving that a hello without the capability gets nothing new. `devices/harness-pro/docs/cable.md` records the table above with field shapes.

## Phases

Each phase ends with something checkable.

1. **Project skeleton.** CMake, sdkconfig, partitions, the board layer, display and touch.
   - Check: `idf.py build` is clean. Flashed to the Pro, the panel lights with a test pattern and touch logs taps.
2. **Compositor and Pod.** Move them in and trim the compositor.
   - Check: `test/run.sh` passes on the host, and `pod_render` reproduces today's screens.
3. **`pro_app` and `pro_cable`.**
   - Check: flashed, the Pro reaches "session up" against the `dev/firmware-pro` daemon build and shows Tabs, Tab, Agent, Recap and Listening with live data.
4. **Daemon on main.** Inventory, then port, behind the capabilities.
   - Check: cli specs pass, including the round-unchanged specs. Flashed, the Pro runs against a daemon built from this branch of main: tool steps, recap, offline members, library and focus all work.
5. **Voice and notices.** Recording, send, the voice gate's reasons, and notices.
   - Check: the existing voice-gate and touch replays pass, and a recording sends on the device.
6. **CI and docs.** Add a step to the firmware job that runs `devices/harness-pro/firmware/test/run.sh`. Write the README and move the mockups.
   - Check: a PR into main with `ci/required` green, then merge with `make merge-pr`.

## Acceptance

- On the Pro (MAC e8:f6:0a:e7:63:7d, rev v3.2), the separate firmware does everything the `dev/firmware-pro` Pod build does today against a daemon built from main:
  - Tabs grid with the Working ribbon and Recent;
  - the Tab list;
  - the Agent screen with the LCD verb, activity and tool steps;
  - Recap with scroll echo;
  - Listening with the send button;
  - pane swipes, focus follow, offline members, and voice.
- `devices/harness-device` is byte-identical to main before this work. `git diff origin/main -- devices/harness-device` is empty.
- A round dial on main's firmware sees no change in the daemon's traffic. The capability specs prove it.
- The Pro project builds with only its own directory and ESP-IDF 5.5.4. It does not include headers or sources from `devices/harness-device`.
- The Pro host tests run in `firmware-checks`.

## Risks

- **`ui_habitat.c` holds Pod behaviour that is easy to lose.** It contains the turn and verb feeds, `pod_new_turn`, focus timing, voice-gate reasons, wake and clock. Phase 3 lists every `DEVICE_POD` and `DEVICE_PRO_COMPANION` section before writing `pro_app`, and each one is either moved or recorded as not needed.
- **The protocol drifts.** The Pro's client is a fork. A protocol change on main now needs a thought for both devices. The capability table and `docs/cable.md` are where that is checked.
- **Stack and memory.** The 6 KB `cable_link` stack and the PSRAM scene placement were hard-won. The frame-size guard and the small-stack test move with the code.
- **The power latch bricks a wrong-revision image.** The README carries the flash procedure with its chip and MAC check, unchanged.
