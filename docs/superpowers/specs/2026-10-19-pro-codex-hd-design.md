# Harness Pro: Codex pet in high quality

Date: 2026-10-19. Status: approved in brainstorming (option E).

## Goal

Draw the Codex pet on the Harness Pro without jagged edges or colour banding. Use the same art, the same scenes and the
same on-screen size, and stay within the device's flash, RAM and frame-time limits. Claude, Muse and Fo do not change.

## Why it looks rough today

- **The art is small.** It is the official Codex Pets art, and its cells are fixed at 192 × 208. Codex Pets' own
  sprite-sheet contract says "cells are always 192x208". There is no larger original.
- **The device scales it up.** The Pro shows that art at about 1.6× (the room) and 13/8 (the voice screen), scaled
  live by `pod_cell_smooth`. Alpha is 1-bit, so the edges step.
- **Colours are cut.** Each scene is cut to ≤ 255 colours with no dither, then to RGB565, which bands the gradients.

## Decision (owner)

Option E of `devices/harness-pro/mockup/pro-codex-quality/`:
1. Upscale every Codex frame 4× with Real-ESRGAN (`realesrgan-x4plus-anime`) at build time.
2. Resample each frame to the exact size the device shows it at.
3. Anti-alias its edge over the room ground.
4. Dither when quantising.

The device then copies frames 1:1 instead of scaling them.

## Design

### Assets (build-time only)

- `devices/harness-pro/firmware/assets/codex/src/<loop>/NN.png` holds the 192 × 208 frames the Pro uses: idle,
  review, waiting, running, listening, waving. They are copied once from the round's Codex assets, so the Pro tree
  stays self-contained.
- `scripts/upscale_codex.py --esrgan <binary> [--models <dir>]` runs `realesrgan-x4plus-anime` ×4 on every source
  frame. It resamples the result with premultiplied Lanczos to the HD size in the next bullet, and writes
  `assets/codex/hd/scene/<loop>/NN.png` (20 frames) and `assets/codex/hd/small/<loop>/NN.png` (18 frames) as RGBA.
  - The HD files are committed. The build and the tests never need Real-ESRGAN.
  - Re-run the script only when the source art changes.
- **HD sizes**, against the 192 × 208 source:
  - **Scenes** (work, listen, send, relax): K = 1.6, which gives 307 × 333 canvases. That is the size the Agent room
    shows today, so the room draws at exactly z = 8.
  - **Small pet** (idle, review, waiting): today's 2× cells (crop to the union box, height 112) × 2, so height 224.
    The room shows that 1:1.

### Generator

- `scripts/gen_pro_codex.py [--check]` writes `main/pod/pets_codex.c`, which holds `const ht_pet_t pod_codex_pet`.
- It ports the round generator's Codex parts:
  - the small-pet loops
  - the work, listen and send pack scenes
  - the listening bubble and its code-drawn bars
  - the send plane
  - the relax plane loop
  - the frame encoder: `pack_rows` and `cell_frames`
- It works from the HD frames. The listening bubble, plane and trail are drawn at 4× scale and downsampled to K.
- All 1x geometry is multiplied by K: overlay `at`, the bars' x, cy, w, radius, min and swing, and the plane's path.
- Every timing and loop is unchanged.
- Each frame is composited over `PH_ROOM_BG` (#221F1D), with alpha cut at 24 (owner gate 2026-10-19: the soft edge is kept, blended into the room ground; Recap and Inbox grounds are close to it, and Tabs cards show the engine logo, not the pet). Each scene shares one palette of
  ≤ 255 colours, quantised with Floyd–Steinberg dither, then RGB565.
- `--check` fails when the file is stale. `test/run.sh` runs it.

### Firmware

- **`ht_cell_frame_t.rows`** goes from `uint8_t` to `uint16_t` (`pod_types.h`), because HD scenes are up to 333 rows.
  Initialisers stay positional and unchanged.
- **Lookup.** `pod_pet_for("codex")` returns `&pod_codex_pet`. `prune_pets.py` drops Codex from the imported
  `pets.c`.
- **Drawing.** Codex is an HD pet:
  - Its zoom is capped at 8 (it is never scaled up), in both `draw()` and `play_rest()`.
  - Below 1x (Inbox, Recap) it is fitted in sixteenths (`pod_cell16`): frames twice as large make eighths twice as coarse, which shrank those pets by a fifth.
  - The callers' 13 and 16 zoom8 for Codex stop mattering, and `ph_talk.c`'s Codex special case goes.
  - The `smooth` path is removed. `pod_cell_smooth` is deleted if nothing else calls it.
- **No new buffers.** No code is added to the frame path beyond the cap.

## Budgets (acceptance)

| Measure | Today | Limit |
|---|---|---|
| Codex on-screen ink box, per screen (agent rest/ask/work, talk listen/send, Recap (relax), Inbox) | measured before the change | each side within ±3% of today |
| Codex zoom on the Agent room and voice screen | 13–16 eighths, smooth | exactly 8 (1:1) |
| `pets_codex.c.obj` | Codex part of `pets.c` (about 380 KB) | ≤ 1.35 MB (raised from 1.3 MB after measuring: 1.32 M elements with the soft edge kept) |
| `harness_pro.bin` | 0x2e3b30 (≈ 3.03 MB) of an 8 MB slot | ≤ 4.0 MB |
| Host perf of the Codex screens (`agent:cli`, `agent:be`, `talk:be`, `talk:be:send`) | 334 and the base values recorded from 6acbd7a05 | ≤ their baselines (no slower) |
| Device `frame_max_us` with a Codex room | 21,273 | ≤ 21,273 |
| RAM | — | no new heap or PSRAM use |

## Testing

- **Size parity, recorded first.** `test/codex_size_baseline.txt` records today's Codex ink boxes per screen, from
  `pod_render`. A new test in `test_pod_pet.c` (or a script over `pod_render`) checks the ±3% rule after the change.
- **Zoom.** On the Agent room and the voice screen, the Codex frame run is exactly the frame's cols wide, so it is
  drawn at z 8.
- **Data.**
  - Every Codex scene keeps today's step count, `step_ms` and level layout.
  - Palettes are ≤ 255.
  - `rows` > 255 decodes correctly: a `pod_cell` round trip on a 300-row frame.
- **Suites.** `test/run.sh`, `gen_pro_codex.py --check` and `test_tree_isolation.py` must pass. Golden and the perf
  baseline are re-recorded after the owner approves the look.
- **Device.** Flash one Pro with `scripts/flash.sh`, record size and frame time in `docs/size-baseline.txt`, and have
  the owner check it on the device.

## Out of scope

- Claude, Muse and Fo.
- New scenes.
- The round dial.
- Streaming pets over USB.

## Risks

- **The upscaler invents detail.** E was reviewed on one frame. Gate: before firmware work, review an HD contact sheet
  of every frame next to today's.
- **Overview cards.** Cards draw Codex scenes below 1×, from larger sources now. Parity and golden cover the look.
  Perf must not regress.
