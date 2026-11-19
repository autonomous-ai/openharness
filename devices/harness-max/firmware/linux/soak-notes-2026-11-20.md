# Harness Max on the Orange Pi: long frame, soak, touch (2026-11-20 night)

Worktree `feat/harness-max-v4-opi` from `b0c36a4e9f`. Times are the Mac's (+07); the board keeps UTC.

## 02:06 baseline (the V4 `--demo` that was running, deployed 01:33)

- `alive up=60s frames=4 raster_max_us=4543 frame_max_us=49900`: a ~50 ms frame among the first four frames, with no
  recording (one touch). `app: first frame at 60 ms` (the app was up at 20 ms).
- `alive up=120s frames=750 raster_max_us=4836 frame_max_us=56571`: the 56.5 ms frame came in the minute of the
  kmsgrab + libx264 recording (746 frames).
- Idle afterwards: asleep after 5 min, RSS ~14 MB (systemd Memory: 14.4M), CPU 20.5 s in 32 min.
- Thermal ~55 C on every zone.

## Instrumentation (temporary, not committed)

`main/display/max_prof.h` + phases in `max_present.c`, `out_drm.c` (paint / flip / the frame's own flip wait, touch
edges on esp_timer's clock, the first flip after a touch edge and its vblank) and a `prof` line in `max_app.c`'s
render task: every frame with `MAX_PROF=all` in `~/harness-max/mode.env`, else frames over `MAX_PROF` us (20000
default), plus a `prof: minute` line (frames, max, over 20 / 33 ms) each alive.

## Goal 1: the 56 ms frame (02:10-02:25)

Not the recording, not the paint-ahead (it runs after the frame, outside `frame_us`), not audio. It is the CPU clock:

- The unit pins the app to the A76 pair (cpu6/7), whose governor was `ondemand` (`/etc/default/cpufrequtils`) with
  `sampling_rate=200000` (200 ms) and `up_threshold=25`. Idle, the pair sits at 416 MHz; a tap's first frames run
  there until ondemand's next look, then jump to 2002 MHz.
- At 416 MHz a whole-picture frame is 50-57 ms, almost all `glass_fit_paint` (47-49 ms for 400k picture pixels). The
  same frame at 2 GHz: paint 9.8-12.4 ms. The baseline's 56571 us matches a tap on Orca (Apps -> App Detail,
  831k glass pixels) measured at 56979 us with no recording.
- `schedutil` is worse here (no energy model, no uclamp in this kernel: it hovers at 780-1014 MHz, motion frames
  33-36 ms). `performance` on the pair: max frame 27.6 ms, p99 19 ms, every motion frame on its refresh.

Fixes (committed):

1. `ceb7cc3725` `glass_fit_paint` in two passes (one axis, then the other, rounding once): bit-exact with the 2 x 2
   blend (host test against the old code over 8 fits and 320 damage rectangles), whole picture 12.2 -> 9.0 ms on an
   A76 at 2 GHz (bench on the board, malloc target). SWAR lanes and band sizes 4..128 gained nothing more: what is
   left is per-pixel arithmetic, which only NEON would cut.
2. `1213664055` the unit sets cpu6's governor to `performance` (ExecStartPre) and puts back the one it had
   (`/run/harness-max-governor`, ExecStopPost). Checked: stop -> ondemand, start/restart -> performance.
3. `28e2188ec9` a frame waits for its own flip at the end of `max_output_show`, not for the last one's at the start:
   the next scene is built after the vblank with the finger's latest. App Detail tap (release) to glass: 42 ms mean
   (n=6, 34-50) before, 29 ms (21-37) after; Ambient/Apps taps 12-23 ms. Motion frames unchanged (one a refresh).
4. `d436b1bb0e` a frame's damage is kept as up to 8 rectangles instead of one around all: in `--story` the pets at
   both ends made every frame a whole-picture paint (8.9 ms for 22-56k changed glass pixels).

## Goal 2: soak (`--story`, the committed code + the temporary instrumentation)

Started 02:36:15 (19:36:15 UTC), pid 27662. Sampler on the board: `/tmp/hm-soak.sh` (every 60 s, pinned to cpu0) ->
`/tmp/hm-soak.log`. dmesg at the start: 1735 lines, 0 iommu, 0 WARNING, 0 call traces; 54 error/fail lines, all
`sunxi:sound-mach: simple_dai_link_of failed`, two ~150 ms before each app start's `sunxi-hdmi` hpd/edid lines (when
the unit's ExecStartPre runs `harness-max-usb`; not checked further).

| Mac time | up | RSS / peak | thr / fds | CPU (1 min) | frames/min | worst frame / min | CPU temp max | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 02:58 | 21 min | 17832 / 17832 kB (flat since minute 1) | 9 / 5 | 1.7-3.3 % | 666-1206 | 26.4-27.4 ms (no frame over 33) | 53.4-57.4 C | no W/E line; grab OK (an Ask with its glow) |
| 03:24 | 47 min | 17832 / 17832 kB | 9 / 5 | 2.3-2.6 % | 666-1206 | 26.7-28.7 ms | 53.6-54.6 C | no W/E line |
| 03:53 | 76 min | 17832 / 17832 kB | 9 / 5 | 2.4-2.6 % | 666-1206 | 26.9-28.7 ms | 53.4-54.0 C | no W/E line, no new dmesg line |
| 04:21 | 104 min | 17832 / 17832 kB | 9 / 5 | 2.4-2.6 % | 666-1206 | 26.7-30.7 ms | 53.4-54.2 C | one frame over 30 ms at 03:56 (f=73542: 27776 glass px after a whole-picture frame, so the whole picture again into the other buffer, paint 13.1 ms where 9 is usual, then 17.5 ms for its flip); no W/E line |
| 04:50 | 133 min | 17832 / 17832 kB | 9 / 5 | 2.4-2.6 % | 666-1206 | 25.5-30.7 ms | 53.4-54.6 C | 9 alive lines say `asleep`: the glass sleeps after 5 min without touch and the story's next alert lights it (a whole-picture repaint and flip); 9+ such cycles, all clean; no W/E line |
| 05:20 | 162 min | 17832 / 17832 kB | 9 / 5 | 2.4-2.5 % | 666-1206 | 26.6-30.7 ms | 52.7-54.6 C | 150025 frames, 0 over 33 ms (1990 over 20 ms: `frame_max_us` counts the frame's own flip wait, so a whole-picture frame reads 26-28); one pid all along; no W/E line |
| 05:37 | 180 min | 17832 / 17832 kB | 9 / 5 | 2.4-2.5 % | 666-1206 | 26.6-30.7 ms | 52.7-54.6 C | 165553 frames, 0 over 33 ms; grab OK (an Ask, its buttons and the edge glow); no W/E line |

End of the soak (05:37, 3 h 0 min): one pid all along, no restart, RSS 17832 kB from minute 1 to 180 (peak the same),
9 threads and 5 fds throughout, CPU 2.4-2.5 % of one core, the pair at 2002 MHz throughout, the CPU zones 52.7-54.6 C
(57.4 at the start, after the builds). Per-minute worst frame by half hour: 27.6, 28.7, 30.7, 27.7, 28.9, 27.4 ms: no
drift. Kernel since the app started (uptime 15052 s): only 5 SD/eMMC re-tunings (`sunxi_mmc_host-402x000.sdmmc`, each
with one `[ERR]: wait dma hold bit clear timeout`, every 50-60 min, the host's own), no DRM, iommu, WARNING or call
trace line. Sampler stopped. No leak, crash, stall or drift.

## Goal 3: touch (05:45, the final code + the temporary instrumentation, `--demo`, `MAX_PROF=all`)

One `drive.sh`-style run (`/tmp/hm-touch.py` on the board, uinput): Ambient -> Apps -> Orca's App Detail (5 agents),
open landing-hero / X, open auth-refactor / X, landing-hero again / X, a swipe each way (800 px in 250 ms), open
auth-refactor / X. `lat` = the touch edge's kernel time to the vblank of the first flip queued after the render task
read it.

- Release to glass, 12 releases (10 taps, 2 swipe ends): 15.2-34.1 ms, mean 24.6 (App Detail's 8 taps: 15.2-31.4, mean
  24.5; Ambient/Apps 15.8, 26.8). Split: edge to read 0.6-3.6 ms (the 4 ms poll while a finger is down), read to the
  render task's next frame 0.2-14.3 ms (it is in a running motion's flip wait), the frame's work 0.4-11.1 ms, queued
  to vblank 1.7-16.8 ms. The first measurement with the frame waiting at its start: App Detail 42.3 mean (34-50).
- Press to the first changed frame (App Detail, an open card animating): edge to read 0.8-19.2 ms (the 20 ms poll
  while no finger is down: the Pro's touch task, not changed), read to frame 0.4-16.4 ms, total 28-49 ms; the second
  swipe's press 51.5 ms, as nothing changes until the finger passes the drag slop.
- Motion: 801 frames in 7 runs (four opens, ~3 s each as an open card animates until its X, the close in the same run;
  two swipes, 45-46 frames each in 760-780 ms; one 16-frame run of 260 ms): no gap over 18 ms between frames, so a
  frame every refresh. Work per frame (without the flip wait): p50 1.7 ms, p99 10.3, max 11.5 (a swipe's whole-picture
  frames, 9-10 ms of paint). `fus` over 20 ms: 4 frames, each a whole-picture frame and its flip wait (22.6-26.4 ms).

What is left is the vblank pipeline (a frame read mid-refresh waits for the next, then for its own) and the press poll:
nothing more on Max's side short of a NEON paint.

## End state (05:45)

The instrumentation is out of the tree (saved in the session's scratchpad as `final-prof.patch`); README's frame-time
paragraph has the numbers (`84d1e9d50b`). Mac ctest 7/7, `test_glass_fit` 552610 checks; the board's ctest 8/8 on each
deploy. The fixes are committed on `feat/harness-max-v4-opi` only (5 commits on `b0c36a4e9f`; they merge cleanly onto
`feat/harness-max-v4`'s `dc52e52a01`), so the board was put back on the merged V4: its unit reinstalled (the bar
stopped first, so the governor went back to `ondemand`), then `deploy-orangepi.sh --demo` from
`autonomous-harness-max-v4` (`dc52e52a01`, board ctest 8/8). Until the fixes merge, the board has V4's paint, the
`ondemand` governor (the 50-57 ms first frames after a rest) and the wait at a frame's start.
