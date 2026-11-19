# Harness Max roadmap

> 2026-11-19. Replaces the first ESP32 roadmap (17 Nov, written before any code) and the "later milestones" lines of
> [first light](../superpowers/specs/2026-11-17-harness-max-design.md). Code read at `main` `91f60b6a7b` and
> `feat/harness-max-v3` `6da0a272fd`. Rewritten the same day after the owner's call on the platform (below).

## What Max is

A touch bar that sits under the monitor and shows the cabled computer's agents: who is working, who waits on the
person, who is done. One tap on an agent talks to it. A Harness agent's question or permission prompt is answered on
the bar. It runs the same software model as the Dial and the Pro (the Dial's app filter, `hello.appFilter:"v1"`), so
its edge is where it sits, in the line of sight, not a feature the Pro lacks.

## The target (owner's call, 19 Nov)

- **Hardware:** the Harness Pro's, or its equal: an ESP32-P4 (chip v3.2, as the Pro's WT01P4C5-S1 module), with the
  Waveshare [8.8-DSI-TOUCH-A](https://www.waveshare.com/8.8-dsi-touch-a.htm) panel: 480 x 1920 used on its side as
  1920 x 480, OTA7290B over MIPI-DSI 2 lanes, GT9271 touch, about 225 ppi.
- **Software:** one C firmware, `devices/harness-max/firmware`, built on the Pro's sources from `main` and following
  the Dial's protocol as Diego moves it. The bar the owner tuned in V3 (Flutter) is ported to it.
- **Until the P4 and the 8.8" panel are on the bench,** the Orange Pi 4 Pro with its 11.9" 1480 x 320 bar stands in. It
  runs the same C code through the Linux port (`firmware/linux`) and draws the panel's exact 1920 x 480 picture,
  scaled 2/3 to 1280 x 320 with black bars of 100 px left and right.
- The owner's Harness Pro on the desk (ESP32-P4 v3.2, 720 x 720) is a build target only for now: V4 is built for the
  P4 and checked against its flash layout, and not flashed onto it.

## Where it stands

Four builds, all local branches (nothing pushed):

| Build | Branch | What it is |
|---|---|---|
| V1 | `feat/harness-max-all` | C firmware on the Pro's sources, the "room + three lanes" layout. Kept for history |
| V2 | `feat/harness-max-v2` | C firmware, the [Demo V2](../superpowers/specs/2026-11-18-harness-max-v2-design.md) pages in the dial's look |
| V3 | `feat/harness-max-v3` | Flutter on the Orange Pi. Frozen: the reference for how the bar behaves, not the product |
| V4 | `feat/harness-max-v4` | C firmware: V2's pages, V3's changes, `main`'s protocol. Runs on the Orange Pi (M1) |

What V3 settled, which V4 carries into C:

- Overview is App Detail: three cells to the glass, the row scrolls, ordered by need (asking, working, failed, done,
  idle), the order held while an agent is open; one tap opens an agent across the row with the mic on, the others
  dimmed slivers (.62).
- Voice rules of 18 Nov: 5 s of quiet after speech sends; a mic that hears nothing for 5 s closes and sends nothing;
  X cancels; a tap anywhere else sends; only a 25–350 ms tap that moves under 1.2 mm counts; 10 min cap.
- A finished turn shows a small note bottom right for 6 s and never takes the glass; a question or a failure does
  (Attention, edge light).
- Chimes: a question and a failure ring two 2 kHz tones (110 ms, 160 ms apart), a done turn a soft two-note ding; one
  sound each at most every 30 s.
- Apps: Harness first, with its symbol. "Following <App> on your Mac" when the computer turns the bar.
- The demo is driven by the person (`--demo`: every state stands, nothing moves by itself); `--story` keeps the loop.

Not done anywhere: the P4 and 8.8" bench, Wi-Fi, a wake word, product hardware.

## What `main` changed since the fork

`main` moved 76 commits between the fork (`1e17b388ce`, 17 Nov) and `91f60b6a7b` (19 Nov), most of them for the Dial.
A dry merge into the branch conflicts in five files: `cli/src/cable/cableSession.ts`, `cableFleet.ts`,
`cableHost.spec.ts`, `cli/src/services/devices.spec.ts`, `scripts/ci-plan.py`.

| Change on `main` | Commits | What it means for Max |
|---|---|---|
| A `question` frame is only a summary: `questions:[{key:"", q:<≤239 B>, options:[]}]`, no `engine`. The whole question comes from `question.read` | #4460 | The bar must open every question through `question.read`; before V4 it read the options from the frame and answered nothing on the bar |
| A question too big for a device (more than 4 questions or 6 options, a repeated key, over 6500 B) stays as a summary with no options | #4457 | Show its words with "answer it on the computer" |
| Notices outlive a restart of the devices process (`dial-notices.json`, 24 h) and come back only as silent drawer rows (`notif.replace`); a held question is never sent again as a `question` frame | #4453, #4457 | The bar reads the drawer's question rows, or an open question is lost after that restart |
| `questionTier:"v1"` in the hello: a question already told comes back as `question{tier:"list"}`, filed without a ring | #4457 | Say it, and file `tier:"list"` silently |
| The drawer keeps a news row and a question row per agent, at most 8 rows, questions first; the bell counts agents; a full inbox (24) drops news, never a question | #4445, #4448, #4462 | The bar still builds its own Inbox; reading the daemon's drawer instead is M5 |
| On the Harness window's tab the daemon sends `apps{shown:"harness"}` with Harness left out of the list; welcome feature `apps.switch` | #4441 | The bar adds the Harness entry itself |
| A voice discard is one `voice.abort{uploadId, why:"discarded"}`, before the next `voice.begin`, also after `voice.end` | #4467 | Fixed in the Pro's `pro_recorder`/`pro_voice`, which Max compiles |
| New agent sources: cmux, opencode, VS Code (terminal and Claude tab), Cursor, Orca account homes, the ChatGPT app's Codex. All `answer:false` | #4406, #4409, #4427, #4461, #4421, #4452 | App names for `cmux` and `opencode` |
| Agent status from the engines' hooks: done lands 1.5 s after the turn ends, an interrupted Codex turn ends without a ring, no "working" while a permission waits | #4428, #4429 | No code change; check the chimes against a real daemon |
| `focus` on the first agent right after `agents.end` when the device held none | #4452 | The bar keeps its page |
| The menu-bar app is named "Harness" and Desktop installs it when a device is plugged in | #4426, #4432 | A not-linked screen, when the bar gets one, names the menu-bar app "Harness" |

## Milestones

### M1: V4, the tuned bar in C on `main` (now)

- Merge `main` into the branch. Max's daemon changes go back on top of the new question frame: `board:"max"` gets
  `seq`/`resync` and the name "Harness Max" (`4b9bbeb852`); `HARNESS_CABLE_TCP` and the `permission:true` mark
  (`d85e26e71e`), which now rides on the summary frame.
- The firmware follows `main`'s protocol: `question.read` for every question, `questionTier:"v1"`, the drawer's
  question rows, the Harness entry for `shown:"harness"`, the new app names.
- V3's changes in C: App Detail, order by need, voice rules, the done note, three chimes, Harness first, "Following
  <App>", the person-driven demo.
- The Orange Pi build draws 1920 x 480, scaled 2/3.
- The P4 image (`harness_max.bin`) builds for esp32p4 and fits `ota_0` (0x7E0000).

Done when: the Orange Pi runs V4 in `--demo` at 1280 x 320 with every V3 case; the host tests and goldens pass at
1920 x 480; the P4 image fits; and with the branch CLI on the Mac and the bar on `--usb`, a Harness agent's question
is answered and a permission prompt approved on the bar, and an open question survives a restart of the Mac's devices
process.

Status, 19 Nov: everything above is in `feat/harness-max-v4` and the Orange Pi runs it in `--demo` (Ambient, Apps
with V3's icons, App Detail, an agent opened with the mic on, checked on the bar). The host tests pass at 480 and 415,
the 38 goldens match, the Linux build's tests pass on the Mac and on the board, and `harness_max.bin` is 0x431d40
bytes of `ota_0`'s 0x7e0000 (47% free). Not yet run: `--usb` against the Mac's real daemon, which needs the branch CLI
installed on the Mac.

Frame speed, 19 Nov evening (`feat/harness-max-v4-perf`, in V4). The bench (`devices/harness-max/firmware/bench`)
ran on the desk Pro's chip from its spare `ota_1` slot, the Pro's own firmware in `ota_0` untouched and its `ota_1`
put back byte for byte after. Before: a whole glass took 27 ms (App Detail) to 57 ms (an agent) to rasterise on one
core, plus 14 ms to turn; the listening band 26 ms a frame. After the faster compositor (fills, veil and outlined
rects, byte-identical), the strips shared by both cores and the PPA turning each strip into the framebuffer while the
next is drawn (`main/display/max_present.c`): a whole glass 15–20 ms end to end (50–65 fps), the row shifted 40 px
(86% of the glass changes) 16.6 ms, the listening band 9.7 ms; every framebuffer pixel as the old path's on all 38
screens. Reports: `bench/results/`. The Orange Pi flips two buffers on vblank (no tearing) and its longest raster fell
from 24.7 ms to 4.1 ms.

Motion, 19–20 Nov (`feat/harness-max-v4-motion`, in V4 at `e9c3c9ae80`). V3's row motion runs in C by the clock:
the width animation when an agent opens and closes (420 ms, V3's curve), the panel fading in and out, the slivers
blurred and moving, the swipe that follows the finger and snaps, and V3's loops (the chip's dot, the rail's sweep,
the asking glow, the talk band, the toast and notes). While App Detail rests, the render task paints ahead each open
and close the finger can start (`main/app/max_ui_warm.c`), so the first frame of a motion is a warm one. On the
chip, without the panel: an open 36 fps (27.6 ms mean, 37.8 ms worst), a close 42 fps (23.5 / 41.3 ms), the first
frame 18 ms (open) and 36 ms (close), down from 76 ms and 182 ms cold; the swipe 55–61 fps; the loops over 200 fps.
Two fixes came with it: a race in ESP-IDF 5.5.4's PPA driver left a frame's last strip waiting (`max_strips.c` now
kicks it, and falls back to the CPU instead of aborting), and the Pro's `ht_damage` lines up the scenes' common tail
when a run is added or dropped (the listening band 64k px a frame, from 735k). The paint-ahead first held the UI lock
for 17 ms a step on the chip (88 ms at worst); it now makes its images out of the lock a band of rows at a time: on
the chip a step's p50 is 2.6–2.8 ms and p95 3.0–3.1 ms, the longest under the lock 3.9 ms, so a tap never waits
longer; a pet below 1x is copied a band at a time as its bake would be, and the bands wait while the row moves. Still
open: 5 steps of an open's 1111 still run past 4 ms (36 ms at worst), the bakes of pets drawn straight on the glass,
which the glass's own frame needs in the arena; the paint-ahead takes 2.7 s (open) and 2.9 s (close) after App
Detail lands. Reports: `bench/results/2026-11-20-*`.

Night of 20 Nov (in V4 at `e97f7dd664`). The Max no longer changes a file of the Pro's or the Dial's: the six Pro
files it needs changed are its own copies in `devices/harness-max/firmware/main/pro_fork/` (each with its upstream
path and blob, `scripts/check_pro_forks.py` says when `main` moves them), so `git diff 91f60b6a7b --
devices/harness-pro` and `-- cli/src/core` are empty; the CLI's and Desktop's Max paths are gated on `board:"max"`,
and the TCP dev cable lives in the devices' process. Every pixel is as V4's before the copies (`test/raster_same.sh`,
440 scenes x 5 clips, both glasses). On the chip, without the panel (`bench/results/2026-11-20-...-final.txt`): an open
52.7 fps, a close 52.4 fps (first frame 16 ms and 22 ms), the paint-ahead's longest step 3.3 ms (none over 4 ms), the
swipe 63 fps, the slivers' drag 66 fps (54 before), the loops 455 fps, a whole glass 16.3 ms; the listening band is
64,556 px a frame again (a padding byte the chip's GCC copied from the stack had made every glow repaint, 337,600 px).
The Orange Pi's unit runs the A76 pair at its top clock while the bar runs (a tap after a rest painted at 416 MHz,
56 ms), the scaled paint blends one axis at a time (9.0 ms a whole picture, from 12.2), a frame waits for its own
flip (finger to glass 25 ms, from 42), and a frame's damage is up to eight rectangles; a 3 h soak of `--story` held
17.8 MB, 2.5% of a core, 27–31 ms worst frames and no warning. Still open: a sliver's kept layer is built cold in its
first frame (67 ms on the chip), which needs the work split over both cores or a cheaper blur.

Deviations from V3 that remain: the pages switch without V3's cross-fade (a cross-faded frame costs 6–10 whole
glasses); the cell pets hold their pose; the words and chips fade without V3's blur; the overlay, the asking chip and
the halo fade as tints toward the ground, not by alpha (only off on a ground that is not black); the rail and glow
stand still while an agent opens or closes; a moving pet's size steps on the motion's 16 ms frames (15 ms at most
behind the clock); with four or more different Claude or Codex agents the paint-ahead pool is full, so the later
frames of the last motion are cold; a swipe is not painted ahead.

### M2: On Pro hardware

The owner's Harness Pro is a P4 v3.2 with a 720 x 720 ST7703I panel, GT911 touch, ES7210 mics and an ES8311 speaker.
First V4 is only built for it (19 Nov). Next, decide one of:

1. Flash V4 onto the Pro with a board entry for the Pro's pins and panel, the 1920 x 480 picture drawn as a 720 x 180
   band: the chip, cable, touch, mic and speaker run for real before the 8.8" panel arrives. The Pro's own firmware
   comes back by `flash.sh` or the daemon's OTA.
2. Wait for a P4 board with the 8.8" panel (M3).

### M3: The 8.8" panel on a P4

The bring-up list of first light holds: the panel lights, touch lands where the finger is, the picture is the right
way up, and these are recorded: the longest frame (full glass, one cell, the open agent's slide), the time to turn a
strip, free internal RAM and PSRAM. The bench's frame times are without a panel: the panel's refresh reads about
110 MB/s more from PSRAM, so they are measured again here, and the P4 gets a second framebuffer flipped on refresh
(today it draws into the one being scanned, which tears during motion).

Done when: V4 runs on the P4 with the 8.8" panel against the Mac's daemon, as on the Orange Pi.

### M4: Daemon support on `main`

The daemon changes Max needs (`board:"max"`, the permission mark, `HARNESS_CABLE_TCP` for development) go to `main`
by pull request, so a released Harness drives the bar without the branch CLI. Until then, each `main` change to
`cli/src/cable` is merged into the branch the same week: two days of `main` already gave five conflicts.

Done when: a released `harness` on the Mac runs the bar.

### M5: The daemon's inbox

Drop the inbox the bar builds for itself. Read the drawer (`notif.replace`, `notif.seen`), send `notif.read` when a
card is read, keep a news row and a question row per agent, and count agents on the bell. The bar, the Dial and the
Mac then agree on what is unread, and a restart of the bar loses nothing.

### M6: New Harness from the bar

The C build walks the New Harness form on the bar (V1/V2); V3 only opened it on the Mac. Starting an agent by voice
on a chosen machine needs an agent-create frame the daemon does not have. Decide the scope first.

### M7: Without the Mac

Wi-Fi through the P4's companion chip (C5 on the Pro's module, C6 on many boards). The bar talks to the backend
(`/api/device-ws`) and signs in by a QR code from the phone. Approving over the network stays refused, as over TCP
today, until it has a security design of its own.

### M8: Product

Board, panel, enclosure, flashing station, OTA release under the `harness-max` key, radio certification (a certified
module saves most of it). Runs beside M3 to M7.

No wake word is planned: one tap talks.

## Decisions taken

- 17 Nov: the code lives in this repo beside the Pro (`devices/harness-max`); USB first; approvals from the bar, over
  USB only, for Harness agents only.
- 18 Nov: the pages of Demo V2 ("Diego + one tap"); one tap on an agent opens its mic; the voice rules above.
- 18 Nov: V3 in Flutter for the Orange Pi; the demo starts still; a done turn does not take the glass.
- 19 Nov: App Detail; Harness first among apps; the order by need; the chimes.
- 19 Nov: the product is the C firmware on the Pro's hardware with the 8.8" panel; V3 becomes the reference; the
  Orange Pi runs the C build at the panel's exact 1920 x 480; the desk Pro is built for, not flashed.
- 19 Nov: V3's row motion comes to the C build (the width animation, the slivers' blur and motion, the swipe that
  follows the finger); the bench may run on the desk Pro from its spare `ota_1` slot, put back after; the Pro's
  compositor gets faster where its pixels stay byte for byte the same (the Pro gains it at its next build).
- The machines rail of the first plan is gone: the app column (the Dial's app filter) replaced it.

## Open

1. M2: flash V4 onto the desk Pro, or wait for the 8.8" panel.
2. The scope of New Harness (M6).
3. When the daemon changes go to `main` (M4): the branches stay local until the owner says.
4. At that merge, remove the demo (`--demo`, `main/demo/`, the `max-demo` launcher).

## Risks

| Risk | Effect | What we do |
|---|---|---|
| The cable protocol changes daily on `main` | The bar breaks against a released daemon | M1 now, then merge `main` weekly until M4 |
| App Detail's motion on the P4's strip renderer | Frames too long, a stutter | Measured on the chip without the panel (20 Nov): open 52.7 fps, close 52.4 fps, swipe 63 fps, slivers 66 fps, first frames warm, paint-ahead steps under 4 ms; a sliver's first cold frame 67 ms; measure again with the panel in M3 |
| One framebuffer on the P4 | Motion tears on the 8.8" panel | A second framebuffer flipped on refresh, verified at M3 |
| The Orange Pi shows the picture at 2/3 | Smaller than the 8.8" panel's pixels, larger than its millimetres | Judge type sizes in mm: 1280 px on the 11.9" bar is about 255 mm wide, the 8.8" panel about 217 mm |
| The demo hides gaps of the real path | The inbox and empty apps behave differently with the real daemon | Test each milestone on `--usb`, not only `--demo` |
| Approvals only over USB | A LAN demo cannot approve | Demo approvals on `--usb` |
