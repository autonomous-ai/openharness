# Harness Max: Demo V2, pages in the dial's look with one tap to talk

Replaces "The screen" of [first light](2026-11-17-harness-max-design.md) on the branch `feat/harness-max-v2`. The room
and its lanes stay in git history (`feat/harness-max-all`). The look follows Diego's "Harness bar" mockup, in the
dial's tokens. The boss's rule holds: one tap on an agent starts voice.

## The pages

Six pages, one at a time, full glass (1920 x 480, or the demo bar's 1920 x 415; heights below are for 480 and scale
with `MAX_Y`, the text keeps its size).

1. **Overview.** The app column on the left (the shown app's icon and name, and a grid glyph when there are other
   apps: a tap opens Apps), up to five agent cells, and the bell column on the right (a round button, a yellow badge
   with the unread count: a tap opens Inbox). A cell: a status rail along its top (working lavender, waiting yellow,
   done green, failed red, idle dark), a glow of that colour from the top, fading to none down it (.20 at its top,
   a waiting one's breathing .20 to .05, none at rest; the mockup's .08, then .14, did not show on the black ground and
   .25 was a touch too bright, owner 20 Nov), the pet, the name, and the status word
   in the status colour ("Needs you", "Done", "Failed", "Resting", or the spinner word). More than five agents: a
   sideways swipe pages them; dots under the cells show the page, a yellow dot marks a page with a waiting agent.
   Order: the ring's own order (the daemon's fixed order per app), so an agent keeps its place.
2. **Agent** (one page for reading and talking). The strip on top: Back (chevron, the app's icon and name) and one
   segment per agent of the ring with its status rail; the agent shown is bold with a thicker, glowing rail. Under it,
   left, the agent's pet (it puts its headphones on while it listens) and its engine label in the engine's colour.
   Right of it:
   - not working: "status · ago" ("Done · 2m ago"), then what it last said (its summary, its question, its failure),
     three rows at most; nothing said: "What's next?"; under it "Tap to talk".
   - working: the spinner word large in lavender, the activity under it, the last three steps in a row; at the right
     the turn's clock large, over a thin flow bar.
3. **Attention.** An agent needs the person: its question, or a turn that ended (done, failed). A light runs around the
   whole glass's edge (yellow for a question, green for done, red for failed) and the bar chimes. The pet on the left,
   "name [app] asks" (or "is done", "failed"), and the question.
   - The agent takes answers on the bar (caps `a`, and the question is one the inbox holds): its options as buttons,
     and "Say it" (voice, unless it is a permission prompt). A permission prompt shows its command in mono and Allow
     (green) / Deny (red outline).
   - It does not (another app's agent): "Answer it in <App>", and a tap anywhere brings it up on the computer
     (`agent.open`), with the notice "<name> is up in <App>", back to Overview.
   - A tap outside the buttons does the same bring-up. After an answer the next waiting question takes the page, else
     Overview. A done or failed turn's page goes back to Overview by itself after 8 s.
4. **Inbox.** Opened from the bell. A header column (Close, "Inbox", "N unread") and the notices as cards, newest
   first, at most 12: pet, name in the kind's colour, app, the word ("asks", "done", "failed"), how long ago, the text
   in two rows. Unread cards are lit with a dot. A tap: an agent of the ring that still waits and takes answers opens
   Attention; any other opens it on the computer (`agent.open`; the daemon turns to its app when it is another app's).
   Leaving Inbox marks every card read.
5. **Apps.** "APPS" header column, then one card per app the daemon lists (196 wide, a little wider than the mockup's
   176, owner 20 Nov; six fit whole): icon, name, "N agents", a dot per agent's state, "Shown" on the shown app's card. A tap picks the app (`app.pick`) and goes back to Overview. When the
   computer offers New Harness, a last "+ New" card opens it.
6. **Ambient.** The clock large, the date, "All quiet". Shown when no agent works or waits and nobody touched the bar
   for 60 s; with no computer on the cable it says "Not connected" instead; with no agents, "No agents yet". A tap goes
   to Overview. A turn that starts, or an agent that asks, leaves it.

## One tap to talk

- A tap on a cell opens that agent's page with the mic already open (`agent.open` and a recording, one tap). A waiting
  agent's cell opens Attention instead. An agent without voice (caps without `v`) opens its page with the mic closed
  and "Talk to it in <App>" in place of "Tap to talk".
- While it records, the band takes the page's bottom (from the pet's right edge): "● Listening" with the recording's
  clock, a green waveform from the mic's level, "Tap to send" by its ring (no countdown since 20 Nov), and X. Above
  the band the page keeps its words, smaller (two rows; the working page hides its steps).
- A tap on the page sends; the quiet after speech sends nothing (since 20 Nov; 5 s of quiet sent it before). X cancels.
  Nothing heard in 10 s: the mic closes, the band says "Mic closed · tap to talk", and the page stays to be read. A tap
  on the page then opens the mic again. The full voice rules (owner, 20 Nov) are in "Voice rules" below.
- After a send (since 20 Nov, the Pro's voice screen): the notice "Sent to <name>", and the agent's page stays up. Its
  pet plays the SEND scene (the letter into the mailbox) once and the band says "Sending", its clock stopped. Once the
  daemon takes the words (or the agent's turn begins) and the scene has played (Claude 2.64 s, Codex 2.1 s, Muse
  2.82 s; at once for an engine with no pet), the agent's pane shrinks back into the row (Overview), its cell showing
  the new state: Working at once on the daemon's word ("Starting…" until its turn says more). An error ("Didn't catch
  that", "Not sent") shrinks it back at once, with the words why. With neither in 30 s it shrinks back anyway and the
  agent's state before comes back. Words that answered a question: the next question waiting takes the glass instead
  of Overview (owner, 20 Nov: success, failure or Working, the pane shrinks back and the status updates).
- On the strip, a tap on another agent sends what was said (when something was heard; else it cancels) and shows that
  agent with the mic closed. Back does the same and goes to Overview. A sideways swipe browses the ring the same way.
- The words are not shown as they are spoken: the daemon transcribes the recording after it is sent.

### Voice rules (owner, 20 Nov 2026): the Pro's, with two changes

On 20 Nov the owner replaced the 18 Nov rules below with the Harness Pro's (`devices/harness-pro/firmware/main/app/`
`pod_glue.c`, `pod_nav.c`, `main/audio/pro_voice.c`), but for two things. They are in the ESP32 firmware V4
(`devices/harness-max/firmware/main/app/max_ui_internal.h`, `max_ui_touch.c`, `max_ui_model.c`, `max_ui_agent.c`),
which the Orange Pi build runs too. Demo V3 (Flutter) still has the 18 Nov rules.

The two changes from the Pro:

1. **A cell's tap opens the agent's page at once and its mic 1 s later** (`MAX_TALK_DELAY_MS`; at once was hurried).
   The band says "Mic opens in a moment…"; a tap on the page opens it then; X, the link dropping or leaving the page
   opens none. "Tap to talk" on the page opens the mic at once.
2. **Nothing heard 10 s after the mic opened: it closes and nothing is sent** (`MAX_HEAR_MS`); the band says "Mic
   closed · tap to talk". Once speech was heard the mic stays open until a tap sends it, X cancels it or the cap sends
   it.

Everything else is the Pro's:

- A tap opens the mic (a cell, the page, Say it), however long the finger was down.
- While the mic is open any tap sends: a lift within 24 px (`MAX_TAP_SLOP`, the Pro's `POD_TAP_SLOP`) of where it went
  down, however long it was down, anywhere on the glass but X, a dimmed agent beside the open one included (it opens
  nothing). A finger that went farther than 24 px (out and back too) or a swipe does nothing; the mic stays open.
- The quiet after speech sends nothing.
- No guard: a tap right after the mic opened, a send or X acts at once. A tap before the recorder actually started
  sends nothing and says "Not sent".
- X cancels (the Max has no side button, which the Pro cancels with).
- 600 s is the longest recording: then it is sent.
- The recording's agent leaving the ring drops it, heard or not.
- When the clock opens or ends the talk under a finger, that touch acts on nothing when it lets go.
- After a send the page stays on the SEND scene and takes no second recording until the send settles: the scene played
  once (`max_pet_send_ms`) and the daemon took the words or the agent's turn began (a turn started after the tap, or
  any turn event once the words were taken); an error at once; else 30 s (`MAX_SENT_WAIT_MS`, the Pro's
  `POD_SENT_WAIT_MS`). Settled, the pane shrinks back into Overview by the row's own move (420 ms, then the scroll
  back). The words taken, the agent is Working on the bar's word alone (the Pro's `pod_model_sent`) until a turn
  event, or 30 s, when its state before comes back. Leaving the page lets the send go where it is.

### Voice rules (owner, 18 Nov 2026, replaced on the firmware 20 Nov): the Dial's, with two changes

Kept as Demo V3's; the firmware runs the 20 Nov rules above.

The owner set these after reading how the Dial records and sends (`devices/harness-device`: `ui/habitat/gestures.c`,
`ui_habitat.c`, `audio_client_habitat.c`; daemon `cli/src/cable/cableSession.ts`). They are in Demo V3 now
(`devices/harness-max/flutter/lib/model/bar_model.dart`, tests in `test/model/talk_test.dart`). **They are to be applied
to the real code as well**: the ESP32 firmware's model (`devices/harness-max/firmware/main/app/max_ui_internal.h`
`MAX_HEAR_MS` / `MAX_SILENCE_MS`, `max_ui_touch.c`, `max_ui_model.c`) and the live cable mode, which already shares the
Flutter model.

1. **5 s of quiet sends.** After speech, 5 s of quiet stops the recording and sends it. Nothing heard 5 s after the mic
   opened: the mic closes and nothing is sent. (Was 1.6 s and 4 s.) The Dial itself never stops on quiet.
2. **X cancels; a tap anywhere else on the glass sends.** While the mic is open the whole glass is one Send, a dimmed
   agent beside the open one included (it no longer moves the mic to that agent), and the tap does nothing else. X
   drops the recording, at once, whatever the guard below says.
3. **Everything else as the Dial:**
   - A send is the Dial's tap: down 25..350 ms, the finger within 1.2 mm (`kTapSlop` 8 px of the canvas) of where it
     went down. Anything else is the dead zone: a press of 350 ms or more, the Dial's 650..1800 ms draft hold (the bar
     has no draft page yet, so it is dead too), a flick under 25 ms, a finger that slid. Nothing happens; the mic stays
     open, and the 5 s quiet still sends.
   - A touch that opens the mic (a cell, the page, Say it) lets go before 650 ms; held longer it opens nothing.
   - The mic opening, a send and a cancel each take the touches that begin within 450 ms after them as part of the
     same intent (the Dial's `ht_gesture_guard`), so a double tap neither opens and sends nor sends and opens again.
   - When the clock ends the talk (the quiet send, the mic closing, the agent leaving the ring) under a finger, that
     touch acts on nothing when it lets go (the Dial cancels a live gesture when its view changes).
   - Ten minutes is the longest recording (the Dial's 600 s, the daemon's `VOICE_MAX_BYTES`): then it is sent.
   - The recipient is always the open agent; the daemon transcribes after the send, and an empty transcript is the
     daemon's "Didn't catch that".

## Who takes the glass

- A question, or a turn that ends loud (a failure, an alert summary), takes Attention, unless a person is talking or
  New Harness is up: then only the toast (5 s, a tap opens Attention) and the bell's badge.
- Every such event is also a notice in Inbox, unread.
- The daemon decides the shown app (it follows the app in front on the computer after 1 s, and a pick on the bar wins
  until the person brings another app forward). A new ring while the person talks to an agent that left it sends what
  was said, then shows Overview.

## The daemon

The Max says `appFilter: "v1"` in its hello, so the daemon sends what it sends the dial (spec
`docs/specs/2026-11-14-dial-app-filter.md`): `apps {shown, apps: [{id, name, count, waiting}]}` before each ring, the
shown app's ring in `agents`, each agent with `host` and `caps` (letters `s v f a`; left out, all four), and it takes
`app.pick {app}`. pro_cable parses them for the Max; the Pro ignores `pro_app_apps`. With no `apps` frame (an older
daemon), the app column shows the computer's name and there is no Apps page.

## Tokens (the dial's, as Diego's mockup)

Ground #000000, ink #EAEAF0, words #EFE7DE, recap #D6D6D2, dim #ADA6AD, rest #9A9AA6, faint #585863, card #1C1E26,
rim #3D3F47, line #16161C, lavender #C6AAEF. Status: done #0DBC79, waiting #E5E510, failed #FF6B6B (rail #CD3131),
voice #00FF2F. Engines: claude #FF9E64, codex #8FB4FF. Inter faces (`ph_*`); the clocks in `ph_num_230` and `ph_bd_84`
(digits only: the colon is drawn).

## Motion

Only while something moves: the band's waveform and clocks (10 frames a second while recording), the edge light (12
a second while Attention is up), the agent page's and Attention's pet (its own player). The cells' pets hold one
frame. Nothing moves on Overview or Ambient beyond the clocks.

## Tests

Host tests per file as before (model, touch, ask, form, view, app, demo), both glass heights, golden screens re-recorded:
one per page and state (Overview with 1 and 5+ agents, Agent reading / working / listening / mic closed, Attention
question / permission / outside app / done, Inbox, Apps, Ambient, not connected). pro_cable's tests cover `apps`,
`host`, `caps` and `app.pick`.
