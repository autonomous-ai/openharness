# Harness Max: first light

> 2026-11-17. Milestones 0 and 1 of the [Harness Max roadmap](../../plans/2026-11-19-harness-max-roadmap.md) (rewritten
> 19 Nov): the firmware runs on the board, the bar shows the cabled
> computer's agents side by side, and a tap talks to one. Written before the hardware arrives: nothing here has been
> on a bench yet.

## What it is

A desk bar: an ESP32-P4 with an 8.8" touch panel used on its side, 1920 x 480. It shows the agents of the computer it
is cabled to as lanes side by side, and a tap talks to one. It connects over the cable only, like the Harness Pro.

Later milestones, not in this one: answering and approving from the bar (permission prompts included), starting a new
agent from the bar, Wi-Fi.

## Hardware (bring-up board)

None of these values has been on a bench. They come from Waveshare's BSP (`waveshare/esp32_p4_platform` 2.0.1,
`waveshare/esp_lcd_ota7290b` 2.0.0) and wiki.

| Part | Values |
|---|---|
| Board | Waveshare ESP32-P4-NANO: ESP32-P4NRW32X (chip v3.x), 16 MB flash, 32 MB PSRAM, ESP32-C6 over SDIO (held in reset) |
| Panel | Waveshare 8.8-DSI-TOUCH-A: OTA7290B, 480 x 1920 native portrait, MIPI-DSI 2 lanes at 1300 Mbps, DPI 75 MHz, RGB565. PHY LDO channel 3 at 2500 mV. No reset line |
| Backlight | The display board's MCU at I2C 0x45: register 0x95 powers up (0x11, then 0x17), register 0x96 is the level 0x00..0xFF |
| Touch | GT9271 on I2C (0x14, else 0x5D), through `esp_lcd_touch_gt911`. INT and RST are not wired, so it is polled |
| I2C | Port 1, SDA GPIO7, SCL GPIO8, 400 kHz (the Pro's pins) |
| Audio | ES8311 (0x18): speaker and one analog mic. Amp enable GPIO53. I2S MCLK 13, BCLK 12, WS 10, DOUT 9, DIN 11 |
| USB | The cable uses the P4's own USB-Serial-JTAG (GPIO24/25), as on the Pro. The NANO does not route it to a connector (its USB-C is a CH343 on UART0), so bring-up wires GPIO24/25 to a USB cable. The product board exposes it |

The `esp_lcd_ota7290b` driver opens the I2C bus on port 1 by itself and waits 1 s for the display board's MCU, so the
bus is created before the panel.

## Design

### One copy of the Pro's code

Harness Max is its own ESP-IDF project (`devices/harness-max/firmware`, project `harness_max`). It compiles the Pro's
generic sources where they are, from `devices/harness-pro/firmware/main`:

- cable: `cable_frame`, `cable_json_guard`, `cable_features`, `cable_machines`, `cable_scroll`, `cable_link`, `pro_cable`;
- sys: `config_store`, `crash_record`, `device_mac`, `fw_update`, `last_words`, `ram_telemetry`;
- display: `terminal` (the compositor), `pro_canvas` with `pod/pod_draw`, `pro_frame`, `scroll`;
- app and audio: `pro_touch`, `voice_buffer`, `pro_recorder`, `pro_voice`;
- the project-local `components/esp_driver_usb_serial_jtag` and `bootloader_components/wdt_pc`.

Max's own code: the board (pins, table), the display (panel, touch, backlight, rotation, behind the `pro_display.h`
API), audio capture for the ES8311 (behind `audio_capture.h`), the app (lanes model, view, render and touch), and
`app_main`.

Changes to the Pro's shared files, with the Pro's behaviour unchanged:

- `terminal.h`: `HT_WIDTH` and `HT_HEIGHT` can be set apart; the Pro's stay 720.
- `app/pro_app_hooks.h`: what `pro_touch.c` and `pro_voice.c` ask of the app, apart from Pod's headers.
- `pro_display.h`: `PRO_DISPLAY_W` and `PRO_DISPLAY_H`; `pro_frame.c` checks each axis against its own.
- `pro_cable.c`: the hello's `board` comes from the board table (`pro`, `max`) instead of a literal.

### Turning the picture

The app draws landscape, 1920 x 480, in 24-line strips as the Pro does. Max's `pro_panel_submit` turns each strip into
the portrait framebuffer: landscape `(x, y)` lands on the panel at `(479 - y, x)`. One constant flips it if the panel is
mounted the other way. The turn is a pure function, tested on the host. If the bench shows the CPU copy is too slow,
the P4's PPA does it instead.

### The daemon

The hello says `board: "max"`. The daemon treats it as it treats the Pro where the reason is the P4's USB:

- `seq` numbering and `resync` (the same peripheral loses bytes from host to device);
- firmware updates over the cable, with the OTA key `harness-max` when the hello says `ota: "v1"`;
- the fleet's port verdicts;
- the desktop app names it "Harness Max".

No new message in this milestone.

### The screen

1920 x 480 at about 225 ppi: 1 mm is about 8.9 px, and a finger needs about 80 px.

```
┌──────────────────────────────────┬──────────┬──────────┬──────────┬─────┐
│ harness-web   Claude · Mac  Asks │ name     │ name     │ name     │ 1/2 │
│        ┌──────────────────────┐  │ machine  │ machine  │ machine  │  →  │
│  pet   │ Where should the ... │  │ bubble   │ bubble   │ bubble   │     │
│        └──────────────────────┘  │          │          │          │     │
│ Tap to │ [Inside] [Next] [Over]   │   pet    │   pet    │   pet    ├─────┤
│  talk  │                          │  state   │  state   │  state   │  +  │
│        │                          │          │          │          │ New │
└──────────────────────────────────┴──────────┴──────────┴──────────┴─────┘
```

- The Pro's dark Pets look, on Max's own tokens with the values of the Pro's `pod/home/ph.h` (the Pro's `theme.h`
  paper colour is only its clear colour and never shows): the room ground, warm paper speech bubbles, dark thought
  bubbles, lanes on the engine's gradient, the Pro's pets, and Inter faces. At the Pro's 258 ppi they come out about
  the same physical size.
- No rail: each agent's machine is on its lane and in the room, and with no computer on the cable the empty room says
  so. Its 220 px go to the lanes, which is what makes them readable from a desk.
- The room (820 px, from the left edge): one agent, large. Its name, engine, machine and state; its pet; a speech
  bubble with its question, a thought bubble with what it is doing and the step under it, or its failure or summary on
  paper; and the buttons: the answers, Yes and No, or Dismiss.
- The lanes: every other agent, three a page at 300 px each (about 34 mm), each with its name, machine, a short
  bubble, its pet and its state. A lane whose agent asks has a peach ring. Order: agents that need a person first, then
  working ones, then the rest in the roster's order.
- The side column (96 px, right edge): the pager, with the page ("1/2") and a peach dot when an agent on another page
  asks; tap it, or swipe sideways, for the next page. Under it New (New Harness) when the computer offers it.
- Voice goes to the agent in the room, always: tap its pet (Tap to talk under it). The pet listens, the bubble says
  who is listening, and the room offers Send and Cancel; everything outside the room rests until then. A permission
  prompt takes no voice, only Yes or No.
- Which agent the room shows: the oldest question waiting, when nobody is at the bar. After an answer the room moves
  to the next question if one waits, else it stays to show the agent at work. Tap a lane to see that agent; the
  computer opens it too (`agent.open`, as the Pro sends it).
- A question never takes the room from a person at the bar (a tap in the last 20 s, talking, or New Harness open):
  it shows the Pro's toast over the lanes for 5 s instead, and a tap on the toast opens it. Left alone for 20 s, the
  room goes back to the question waiting.
- Copy is short and in English.

## Tests

- Host tests: the lanes model, the view (the run budget, text inside its lane, the hit areas), the turn of a strip,
  and the app's callbacks.
- Renders: each screen to a 1920 x 480 PNG, and golden hashes of them.
- An ESP-IDF 5.5.4 build for esp32p4 that fails when `harness_max.bin` outgrows `ota_0`.
- The Pro's host tests, goldens and build pass unchanged.
- CI: `firmware-checks` runs Max's host tests; new jobs `max-firmware-build` and `max-golden`. A change under
  `devices/harness-pro/` runs them too, because Max compiles the Pro's sources.

## On the bench

When the board arrives: the panel lights, touch lands where the finger is, the picture is the right way up, and these
are recorded: the longest frame (full screen and one lane), the time to turn a strip, free internal RAM and PSRAM.

## Not in this milestone

Answering and approving from the bar, permission cards, a new agent from the bar, Wi-Fi, the OTA upload and release,
a wake word.
