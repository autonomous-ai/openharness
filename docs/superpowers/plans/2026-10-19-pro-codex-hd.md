# Harness Pro Codex HD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Codex pet draws from HD frames (AI-upscaled at build time, resampled to display size, dithered) and is never scaled up on the device. Its size, scenes and timings stay the same, and it stays within the device budgets.

**Architecture:**
- A one-shot script turns the 192 × 208 Codex frames into committed HD PNGs.
- A Pro-owned generator encodes them, plus the overlays drawn at HD scale, into `main/pod/pets_codex.c` (`pod_codex_pet`).
- The firmware widens `ht_cell_frame_t.rows`, prefers `pod_codex_pet` for "codex", caps Codex's zoom at 8, and drops the smooth path.

**Tech Stack:** C11 (ESP-IDF 5.5.4; host tests with cc), Python 3 + Pillow, and Real-ESRGAN ncnn (build-time tool only).

**Spec:** `docs/superpowers/specs/2026-10-19-pro-codex-hd-design.md`

Paths are relative to `devices/harness-pro/firmware/` unless they start with `docs/`.

## Global Constraints

- Claude, Muse and Fo stay byte-identical. Only Codex changes.
- Codex keeps today's scenes, step counts, `step_ms`, loops and levels.
- Codex on-screen ink box: each side within ±3% of today, on every screen in the spec's table.
- Codex zoom on the Agent room and voice screen is exactly 8. Codex is never drawn above 8.
- `pets_codex.c.obj` ≤ 1.35 MB. `harness_pro.bin` ≤ 4.0 MB.
- Host perf for the Codex screens (`agent:cli`, `agent:be`, `talk:be`, `talk:be:send`) must not exceed the base (6acbd7a05) values.
- No new heap or PSRAM allocations.
- No file in this tree, except `.md`, may contain `harness-device` (`test/test_tree_isolation.py`). Paths into the round's tree and to the Real-ESRGAN binary are command-line arguments, never literals.
- Real-ESRGAN binary: `scratchpad/esrgan/tool/realesrgan-ncnn-vulkan` (v0.2.5.0 macOS, sha256 of the zip `e0ad0558…333a`). Model `realesrgan-x4plus-anime`, `-s 4`.
- Commit only when the owner asks. Commit steps are offers.

## Review Focus

1. **Listening at mic levels 0–4.** The bars, scaled by K, must stay inside the bubble at swing max (test in Task 3).
2. **The relax plane passes behind the robot.** The cut-out uses the HD robot alpha, so no halo is left (gate in Task 1's sheet, assert in Task 3: the overlay has no pixel inside the robot's alpha on depth < 0 steps).
3. **The small pet below 1× on Recap and Inbox (Tabs cards show the logo).** These now come from 224-high frames, and `pod_pet_draw_flat`'s bake arena (360 K px) must still fit (test in Task 4: render inbox and recap with Codex, no arena overflow; parity holds).
4. **A frame of more than 255 rows.** `ink_rows`, `row_inked`, `pod_cell` and extent scans must use the widened field without truncating (test in Task 2).
5. **An `import_pets.sh` re-run.** It would restore Codex into `pets.c`. `pod_pet_for` must still pick `pod_codex_pet` (test in Task 4: lookup order, independent of prune).

---

### Task 1: Size baseline, source frames, HD upscale (owner gate)

**Files:**
- Create:
  - `test/codex_size_baseline.txt`
  - `test/codex_size.py`
  - `assets/codex/src/{idle,review,waiting,running,listening,waving}/NN.png`
  - `scripts/upscale_codex.py`
  - `assets/codex/hd/**`
- Gitignored mockup: `devices/harness-pro/mockup/pro-codex-quality/hd-sheet.png`

**Interfaces:**
- `test/codex_size.py [--record]`
  - Builds `pod_render` the way `test/pod_render.py` does and renders these screens: `agent:cli` (ask), `agent:be` (working), a relax screen for a Codex agent (use the existing screen spec that gives a finished Codex agent, or add a `pod_render` screen name if none exists), `talk:be`, `talk:be:send`, `tabs`, `recap:<codex agent>`, `inbox`.
  - For each, it measures the Codex ink box: the bounding box of pixels inside the pet's square whose colour is blue-dominant, b > r + 40.
  - `--record` writes `screen x0 y0 x1 y1` lines to `test/codex_size_baseline.txt`.
  - Without `--record`, it exits 1 if any side differs by more than 3%.
- `scripts/upscale_codex.py --esrgan BIN [--models DIR] [--src DIR] [--out DIR]`
  - Defaults: `assets/codex/src` and `assets/codex/hd`.
  - Scene loops (running, listening, waving, idle): ESRGAN ×4, then premultiplied Lanczos to round(192·K) × round(208·K), with K = 1.6.
  - Small-pet loops (idle, review, waiting): ESRGAN ×4, crop to the union alpha box of the 18 frames ×4, then Lanczos to height 224.
  - It writes `hd/scene/<loop>/NN.png` and `hd/small/<loop>/NN.png`, RGBA, straight alpha.

- [ ] **Step 1: Record the baseline before touching anything.** Run `python3 test/codex_size.py --record`. Commit-offer the baseline file alone.
- [ ] **Step 2: Copy the source frames.** Take them from `devices/harness-device/firmware/assets/pets/codex/` (pass the path on the command line; do not write it into a file) into `assets/codex/src/`. These are 6 loops; `listening` has 4 frames, `waving` 4, the others 6.
- [ ] **Step 3: Write and run `scripts/upscale_codex.py`.** Expected: 20 scene PNGs (running 6, listening 4, waving 4, idle 6) and 18 small PNGs under `assets/codex/hd/`, with `du -sh assets/codex` ≤ 6 MB.
- [ ] **Step 4: Owner gate.** Build `hd-sheet.png` (every HD frame beside today's, at device size) and publish it in the `pro-codex-quality` page. Wait for approval before Task 3.

---

### Task 2: `ht_cell_frame_t.rows` to uint16

**Files:**
- Modify:
  - `main/pod/pod_types.h:11-12`, to `uint16_t cols, rows; uint8_t cell;`
  - Every narrowing use (`grep -rn "rows" main/pod main/display`): casts, `uint8_t` locals and loops in `pod_draw.c` and `pod_pet.c`.
- Test: `test/test_pod_draw.c`

**Interfaces:**
- Produces: `ht_cell_frame_t.rows` is `uint16_t`. Positional initialisers stay `{cols,rows,cell,palette,cells,row_at}`.

- [ ] **Step 1: Write the failing test** `test_tall_frame`. Build a 4 × 300 packed frame: rows 0 and 299 inked, the rest empty. Draw it with `pod_cell` at z 8. Check one run at y = 0 and one at y = 299, and that `ink_rows` (through `pod_pet_ink_h` or a direct helper) reports 0..300.
- [ ] **Step 2: Run** `test/run.sh`. Expected: a compile error or a FAIL (300 is truncated to 44).
- [ ] **Step 3: Widen the field** and fix the uses.
- [ ] **Step 4: Run** `test/run.sh` and `test/golden.sh --check`. Expected: both pass, with golden unchanged, which proves no visible change.

---

### Task 3: `gen_pro_codex.py` → `main/pod/pets_codex.c`

**Files:**
- Create: `scripts/gen_pro_codex.py`, `main/pod/pets_codex.c` (generated), `test/test_pro_codex.py`
- Modify:
  - `main/CMakeLists.txt`: add `"pod/pets_codex.c"` beside `pets.c`.
  - `main/pod/pod_pet.h`: `extern const ht_pet_t pod_codex_pet;`
  - `test/run.sh`: run `python3 "$fw/scripts/gen_pro_codex.py" --check` and `python3 "$here/test_pro_codex.py"`.

**Interfaces:**
- Consumes: `assets/codex/hd/**` (Task 1) and `rows` uint16 (Task 2).
- Produces:
  - `const ht_pet_t pod_codex_pet = {"codex",w,h,NULL,pxc_loops,pxc_step_ms,&pxc_work,&pxc_listen,&pxc_send,pxc_frames,NULL,0,&pxc_relax,NULL};` where `w,h` is today's Codex `ht_pet_t` w,h (44,56).
  - Every other symbol is `static`, with the prefix `pxc_`.
- **Port, keeping the same behaviour.** Port from the round generator `devices/harness-device/firmware/scripts/gen_pets.py` @ 6acbd7a05, but do not put that path in the file:
  - `CODEX_LOOPS`, `CODEX_STATE_LOOPS`, `codex_pet_states` (small pet)
  - `XWORK_STEPS`, `XLISTEN_FRAMES`, `XSEND_STEPS`, the `X*_MS` values, `generate_pack_scene`, `listen_bubble`, the `BAR_*` constants, `send_overlay`
  - `generate_codex_relax`, `codex_relax_step`, `relax_loop_at`, `relax_plane`, `XRELAX_MS`, `XLOOP`, `XHAND`, `XROBOT_AT`, `XTHROW`, `XCATCH`
  - `exact_overlay`, `pack_rows`, `cell_frames`, `rgb565`, `rgb565_panel`
- **Changes from the round generator:**
  - Robot frames come from `hd/scene` and `hd/small` instead of the 1× PNGs, so drop the 1× resizes.
  - All 1× coordinates and sizes (canvas `CW, CH, RX, RY`, overlay drawing, `BAR_*` geometry including min and swing, `XLOOP`, `XHAND`, `XROBOT_AT`, plane scale, trail radii) are multiplied by K = 1.6.
  - Overlays are drawn on a 4K canvas and Lanczos-downsampled by 4.
  - Every frame and overlay pixel is composited over `(0x22,0x1F,0x1D)`, with alpha set to 255 if it is ≥ 24, else 0 (owner gate: soft edge kept).
  - `quantise_robot` uses `dither=Image.Dither.FLOYDSTEINBERG`. A pixel is transparent only by alpha; drop the round's "pure black is transparent" rule.
  - `exact_overlay` quantises like the robot, with ≤ 255 colours, because overlays are now anti-aliased.
  - Remove the round's `assert w < 256 and h < 256`. Keep `cols ≤ 480`, `rows ≤ 65535` and packed length < 65536 (`pack_rows`).
  - `dx`, `dy` are 0, because the Pro fits scenes by extent.
- `--check`: exit 1 with `main/pod/pets_codex.c is stale: run scripts/gen_pro_codex.py` when the output differs.
- Normal runs print frames and bytes per scene, and the total.

- [ ] **Step 1: Write the failing `test/test_pro_codex.py`.** It parses `main/pod/pets_codex.c` and asserts:
  - The scene `steps` and `step_ms` equal the round's: work 28 × 120, listen 15 × 80 with 5 levels, send 15 × 140, relax 24 × 120. The small-pet step_ms are idle and working 46, done 43, asking 42.
  - Every `*_pal[N]` has N ≤ 256.
  - The sum of the array element counts is ≤ 1.35 M.
  - `pxc_listen_bars` exists. For every x it has `x + w ≤` the bubble overlay's width (in scene coordinates).
  - In relax, for steps 4..18 where the plane is behind the robot, no inked overlay cell lies inside the robot's inked cells. Decode both frames with a small RLE decoder in the test.
- [ ] **Step 2: Run it.** Expected: FAIL, because the file is missing.
- [ ] **Step 3: Implement and run** `python3 scripts/gen_pro_codex.py`.
- [ ] **Step 4: Run** `python3 test/test_pro_codex.py && test/run.sh`. Expected: pass. `pod_codex_pet` is compiled but not used yet.

---

### Task 4: Firmware uses the HD Codex

**Files:**
- Modify:
  - `main/pod/pod_pet.c:15-20`: `pod_pet_for("codex")` returns `&pod_codex_pet`, whatever `ht_pets` holds.
  - `main/pod/pod_pet.c:79,92,378-405`: replace `smooth` with `hd`, which is `pet == &pod_codex_pet`. For an hd pet `zmax = 8`, and `play_rest` uses the same cap. Remove the `pod_cell_smooth` branch.
  - `main/pod/home/ph_talk.c:73`: drop the Codex 13 special case.
  - `main/pod/home/ph_agent.c:28`: fix the comment.
  - `main/pod/pod_draw.[ch]`: delete `pod_cell_smooth` if `grep` finds no caller.
  - `scripts/prune_pets.py`: also drop the `codex` row and everything only it reaches. Then run it on `main/pod/pets.c`.
  - `test/test_pod_pet.c:341,469-480` and `test/test_ph_talk.c:133`: update the Codex expectations.
  - `README.md` "Pets": add the Codex HD pipeline (`upscale_codex.py`, then `gen_pro_codex.py`).
- Test: `test/test_pod_pet.c` and `test/codex_size.py` (Task 1).

**Interfaces:**
- Consumes: `pod_codex_pet` (Task 3).

- [ ] **Step 1: Write the failing C tests.**
  - `test_codex_is_hd`: `pod_pet_for("codex") == &pod_codex_pet`.
  - `test_codex_room_z8`: for each of WORK, LISTEN, SEND, RELAX, REST and ASK, render the room exactly as `ph_room_pet` does (side 260, zoom8 16). The run of the main frame must be exactly `frame->cols` wide, and no run may come from `pod_cell_smooth`.
  - The same at side 260, zoom8 13 (the voice screen).
- [ ] **Step 2: Run** `test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement the changes above.**
- [ ] **Step 4: Run the checks:**
  - `test/run.sh`
  - `python3 test/codex_size.py` (±3% against the Task 1 baseline)
  - `python3 test/test_tree_isolation.py`

  Expected: all pass. If parity fails on the room scenes, adjust K in `upscale_codex.py` and the generator together and re-run Tasks 1 and 3. K is one constant shared through `assets/codex/hd/K.txt`, which the generator reads.

---

### Task 5: Baselines, size, device, owner check

- [ ] **Step 1: Render for the owner.** Render `agent:be`, `agent:cli`, `talk:be`, `talk:be:send`, the relax screen, `tabs`, `recap`, `inbox` and the strip from `test/pod_pet_strip.c`. Put them in `devices/harness-pro/mockup/pro-codex-quality/firmware.html`, publish it, and wait for approval.
- [ ] **Step 2: Host perf.** Run `PH_PERF=1 test/test_ph_perf.sh`. The Codex screens must be ≤ their base values. Then re-record with `PH_PERF_RECORD=1` and add a dated comment line.
- [ ] **Step 3: Golden.** Run `test/golden.sh`, then the Liberation variant, then `--check`.
- [ ] **Step 4: Size.** Run `idf.py -B build-pod -DPROJECT_VER=0.0.99-pod build`. Check that `pets_codex.c.obj` ≤ 1.35 MB and `harness_pro.bin` ≤ 4.0 MB.
- [ ] **Step 5: Device.**
  - Flash one unit with `FLASH_PORT=<port> bash scripts/flash.sh --build-dir build-pod`.
  - Read `frame_max_us` on a Codex room, the way `docs/size-baseline.txt` describes. It must be ≤ 21,273.
  - Append the size and frame entry to `devices/harness-pro/docs/size-baseline.txt`.
- [ ] **Step 6: The owner checks the device.** Then offer the commit, PR, merge and release per `AGENTS.md`.
