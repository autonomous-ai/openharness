# Harness Max roadmap

> 2026-11-19. Replaces the first ESP32 roadmap (17 Nov, written before any code) and the "later milestones" lines of
> [first light](../superpowers/specs/2026-11-17-harness-max-design.md). Code read at `main` `91f60b6a7b` and
> `feat/harness-max-v3` `6da0a272fd`.

## What Max is

A touch bar that sits under the monitor and shows the cabled computer's agents: who is working, who waits on the
person, who is done. One tap on an agent talks to it. A Harness agent's question or permission prompt is answered on
the bar. It runs the same software model as the Dial and the Pro (the Dial's app filter, `hello.appFilter:"v1"`), so
its edge is where it sits, in the line of sight, not a feature the Pro lacks.

## Where it stands

Three builds, all local branches (nothing pushed):

| Build | Branch | What it is |
|---|---|---|
| V1 | `feat/harness-max-all` | C firmware on the Pro's sources, the "room + three lanes" layout. Kept for history |
| V2 | `feat/harness-max-v2` | C firmware, the [Demo V2](../superpowers/specs/2026-11-18-harness-max-v2-design.md) pages in the dial's look |
| V3 | `feat/harness-max-v3` | Flutter (`devices/harness-max/flutter`) on an Orange Pi 4 Pro with an 11.9" 1480 x 320 touch bar. The build that is shown and tuned |

V3 today:

- Pages: Ambient, Overview with App Detail (three cells, the row scrolls, ordered by need: asking, working, failed,
  done, idle; the order holds while an agent is open), the open agent with the mic on (one tap), Attention, Inbox,
  Apps (Harness first, "+ New").
- Voice rules of 18 Nov: 5 s of quiet after speech sends; a mic that hears nothing for 5 s closes and sends nothing;
  X cancels; a tap anywhere else sends; only a 25–350 ms tap that moves under 1.2 mm counts; 10 min cap.
- A finished turn shows a small note bottom right for 6 s and never takes the glass; a question or a failure does
  (Attention, edge light).
- Chimes on the board's speaker: a question and a failure ring two 2 kHz beeps (110 ms, 160 ms apart), a done turn a
  soft two-note ding; one sound each at most every 30 s.
- The cable: hello `board:"max"`, `appFilter:"v1"`, no `ota`; agents, `apps`/`app.pick`, `agent.open`, `answer`,
  the reviewed path (`question.read`, `answer.reviewed`), `form` open, voice upload. Unit, widget and golden tests:
  413 pass (`flutter test test/ui test/model test/demo test/link`, 19 Nov).
- The demo (`deploy-orangepi.sh --demo`) is a scripted fake daemon; `--usb` runs against the Mac's real daemon over the
  board's USB gadget, `--tcp` over the LAN for development.

Not done anywhere: the ESP32-P4 bench (the board has not arrived), Wi-Fi, a wake word, product hardware.

## What `main` changed since the fork

`main` moved 76 commits between the fork (`1e17b388ce`, 17 Nov) and `91f60b6a7b` (19 Nov), most of them for the Dial.
A dry merge into V3 conflicts in five files: `cli/src/cable/cableSession.ts`, `cableFleet.ts`, `cableHost.spec.ts`,
`cli/src/services/devices.spec.ts`, `scripts/ci-plan.py`.

| Change on `main` | Commits | What it means for Max |
|---|---|---|
| A `question` frame is only a summary: `questions:[{key:"", q:<≤239 B>, options:[]}]`, no `engine`. The whole question comes from `question.read` | #4460 | **Breaks V3.** V3 reads the options from the frame (`cable_link.dart` `readAskItems`, `bar_model.dart` `onQuestion`), so every question turns into "answer it on the computer", Allow/Deny disappear, and a `shown:` question loses its app name |
| A question too big for a device (more than 4 questions or 6 options, a repeated key, over 6500 B) stays as a summary with no options | #4457 | Show its words with "answer it on the computer" |
| Notices outlive a restart of the devices process (`dial-notices.json`, 24 h) and come back only as silent drawer rows (`notif.replace`); a held question is never sent again as a `question` frame | #4453, #4457 | **V3 drops `notif.replace`**, so after that restart an open question never reaches the bar |
| `questionTier:"v1"` in the hello: a question already told comes back as `question{tier:"list"}`, filed without a ring | #4457 | Say it, and file `tier:"list"` silently |
| The drawer keeps a news row and a question row per agent, at most 8 rows, questions first; the bell counts agents; a full inbox (24) drops news, never a question | #4445, #4448, #4462 | V3 builds its own inbox on the bar; it should read the daemon's drawer instead (M3) |
| On the Harness window's tab the daemon sends `apps{shown:"harness"}` with Harness left out of the list; welcome feature `apps.switch` | #4441 | Add the Harness tile itself when `shown` is `harness`, or Harness vanishes from Apps |
| A voice discard is one `voice.abort{uploadId, why:"discarded"}`, before the next `voice.begin`, also after `voice.end` | #4467 | V3 sends the id already; check once-only and the abort after `voice.end` |
| New agent sources: cmux, opencode, VS Code (terminal and Claude tab), Cursor, Orca account homes, the ChatGPT app's Codex. All `answer:false` | #4406, #4409, #4427, #4461, #4421, #4452 | Icons for `cmux` and `opencode` (the others have one) |
| Agent status from the engines' hooks: done lands 1.5 s after the turn ends, an interrupted Codex turn ends without a ring, no "working" while a permission waits | #4428, #4429 | No code change; check the chimes against a real daemon |
| `focus` on the first agent right after `agents.end` when the device held none | #4452 | Ignored by V3 (it lands on Ambient); keep it that way |
| The menu-bar app is named "Harness" and Desktop installs it when a device is plugged in | #4426, #4432 | V3 has no not-linked screen yet; when it gets one, it names the menu-bar app "Harness" |

## Milestones

### M1: Follow `main` (next)

- Merge `main` into V3 and resolve the five conflicts. Max's own daemon changes go back on top of the new question
  frame: `board:"max"` gets `seq`/`resync` and the name "Harness Max" (`4b9bbeb852`); `HARNESS_CABLE_TCP` and the
  `permission:true` mark (`d85e26e71e`). The mark has to ride on the summary frame now.
- Questions: when the welcome lists `question.review`, open every question through `question.read`; read the
  permission mark and the `shown:` app from what the daemon still sends.
- Say `questionTier:"v1"`; file `tier:"list"` without a chime; read the question rows of `notif.replace`.
- Apps: the Harness tile when `shown` is `harness`; icons for `cmux` and `opencode`.
- Voice: one `voice.abort` per discard, also after `voice.end`.

Done when: with the branch CLI installed on the Mac and the bar on `--usb`, a Harness agent's question is answered on
the bar, a permission prompt is approved on the bar, and an open question is still on the bar after the Mac's devices
process restarts.

### M2: Daemon support on `main`

The daemon changes Max needs (`board:"max"`, the permission mark, `HARNESS_CABLE_TCP` for development) go to `main`
by pull request, so a released Harness drives the bar without the branch CLI. Each `main` change to `cli/src/cable` is
merged into V3 the same week until then: two days of `main` already gave five conflicts.

Done when: a released `harness` on the Mac runs the bar on `--usb`.

### M3: The daemon's inbox

Drop the inbox the bar builds for itself. Read the drawer (`notif.replace`, `notif.seen`), send `notif.read` when a
card is read, keep a news row and a question row per agent, and count agents on the bell. The bar, the Dial and the
Mac then agree on what is unread, and a restart of the bar loses nothing.

Done when: a notice read on the bar is read on the Dial, and a notice survives a restart of the bar's app.

### M4: The platform

V3 is Dart on Linux; the first plan was C on an ESP32-P4 with the 8.8" 480 x 1920 panel. The C code (V1/V2) lags V3:
voice still waits 4000 ms / 1600 ms (`max_ui_internal.h` `MAX_HEAR_MS`, `MAX_SILENCE_MS`), and it has no App Detail,
no order by need, no done note, no three chimes. It is ahead on OTA and on walking the New Harness form on the bar.

To decide, when the P4 board is on the bench (the first plan's bring-up list still holds: panel, touch, the picture's
turn, frame times, free RAM):

1. Port `bar_model.dart` to C and keep one behaviour on both, with V3's tests as the contract.
2. Ship a Linux bar (Orange Pi class) with the Flutter app, and stop the C firmware.

Option 2 also needs: its own USB vendor and product id (the gadget borrows the Dial's `0x303a:0x1001`), an update
path (today `deploy-orangepi.sh` over ssh; OTA by the daemon's `harness-max` key or a package), and a Flutter CI job
(CI runs only the C jobs).

The glass is part of it: V3's three cells and its sizes are made for the 11.9" bar at 127 ppi; the 8.8" panel is
about 225 ppi.

### M5: New Harness from the bar

V3 sends `form{op:"open", surface:"new"}` and the form opens on the Mac; V1/V2 walk the form on the bar. Starting an
agent by voice on a chosen machine needs an agent-create frame the daemon does not have. Decide the scope first.

### M6: Without the Mac

On a Linux bar Wi-Fi is already there; on the P4 it goes through the C5/C6 chip. Either way the bar talks to the
backend (`/api/device-ws`) and signs in by a QR code from the phone. Approving over the network stays refused, as
over TCP today (`PERMISSION_REFUSED`), until it has a security design of its own.

### M7: Product

Board, panel, enclosure, flashing station, release channel, radio certification (a certified module saves most of
it). Runs beside M4 to M6.

No wake word is planned: one tap talks.

## Decisions taken

- 17 Nov: the code lives in this repo beside the Pro (`devices/harness-max`); USB first; approvals from the bar, over
  USB only, for Harness agents only.
- 18 Nov: the pages of Demo V2 ("Diego + one tap"); one tap on an agent opens its mic; the voice rules above.
- 18 Nov: V3 in Flutter; the demo starts still (`--demo`), the old script is `--story`; a done turn does not take the
  glass.
- 19 Nov: App Detail; Harness first among apps; the order by need; the chimes.
- The machines rail of the first plan is gone: the app column (the Dial's app filter) replaced it.

## Open

1. The platform (M4).
2. The scope of New Harness (M5).
3. When the daemon changes go to `main` (M2): the branches stay local until the owner says.
4. At that merge, remove the demo (`--demo`, `main/demo/`, the `max-demo` launcher).

## Risks

| Risk | Effect | What we do |
|---|---|---|
| The cable protocol changes daily on `main` | V3 breaks against a released daemon (it already does for questions) | M1 now, then merge `main` weekly until M2 |
| The demo hides gaps of the real path | New Harness, the inbox and empty apps behave differently with the real daemon | Test each milestone on `--usb`, not only `--demo` |
| Approvals only over USB | A LAN demo cannot approve | Demo approvals on `--usb` |
| Two codebases (Dart and C) drift | The P4 build shows an older bar | Decide M4 before more C work |
