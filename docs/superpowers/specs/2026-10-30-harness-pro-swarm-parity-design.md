# Harness Pro: the round dial's Swarm chat, PM and Buddy

Status: spec · 2026-10-30 · requester: Diego · base: `origin/main` 5754fc4b7
Mockup: `devices/harness-pro/mockup/pro-swarm-parity/index.html` (main checkout, gitignored), screens 1A–3D, header A chosen.
Builds on: `2026-10-28-round-dial-swarm-chat-design.md` (the chat on a project's face) and
`2026-10-29-round-dial-pm-buddy-spec.md` (the PM and the Buddy). Wire reference: `devices/harness-pro/docs/cable.md`.

## Why

Since 2026-10-28 the round dial has shown the chat the desktop has open in each Swarm project. It alerts on that chat's
new messages, and since 2026-10-29 it has had a Buddy screen per project. The Harness Pro has none of this:

- Its hello (`pro_cable.c:220-240`) says `swarmCard v1` and `superTab wait-v1`, but not `swarmChat` or `swarmBuddy`. The
  daemon therefore sends it the older frames: the Lead's last message only, and no notices.
- It ignores `supertab.focus` with an empty Lead (`handle_supertab_focus`, `pro_cable.c:656`, `id_fits` needs a
  non-empty id). The daemon sends that frame when the desktop opens a Swarm tab with no project open, such as its Chat
  with PM or a DM (`cableSession.ts` `pushSwarmFocus`). So a Pro does not follow the desktop into that Swarm.
- A tap on a Lead that runs on another machine does nothing (`pod_glue.c` `talk_target`: "empty for a remote Lead: no
  talk"). The round posts those words into the Lead's chat by its Swarm id (`swarm.remote`, #2232).

## Decisions (Diego, 2026-10-29/30)

1. **Scope: the round's Swarm work, all of it.** That is the face chat, alerts, PM | Buddy, voice to a remote Lead or a
   Buddy, and the empty-Lead focus. Nothing that the round does not do. No new device features.
2. **Approach A: the Pro speaks the round's protocol.** Its hello adds `swarmChat: "v1"` and `swarmBuddy: "v1"`, and it
   honours the same frames. The daemon gets no new frames. Its one change is a token budget for the Pro (§ Daemon).
3. **Three phases, one PR each, mockup first** (this spec covers all three):
   1. the face chat, notices and the empty-Lead focus;
   2. PM | Buddy;
   3. voice.
4. **PM | Buddy is two buttons at the top of the Lead view**, not a vertical swipe. A vertical drag on the Pro already
   scrolls the message.
5. **Header A** (mockup 2A): with Buddies on, the pill takes the top band. The Swarm and project names share one line,
   and the bubble keeps its 7 rows at y 150.
6. **A group chat's name is shown as its title alone**, with no "#".
7. **A Buddy that is down shows "offline"** under its name (mockup 3B).

## Behaviour

### Phase 1: the chat the desktop has open

- **Face chat.** The Lead view shows the chat the daemon names for the Lead (`chat`, `chatId`, `chatName` in
  `supertab`). The daemon decides it, as for the round: the conversation the desktop has open in this project, else the
  Lead conversation.
- **Chat name** (mockup 1B, 1C). When `chat` is not `lead`, `chatName` is drawn under the project:
  - `ph_sb_22`, `PH_ROOM_MUTED`, centred at cy 120, cut with "…" at 640 px.
  - The bubble does not move. When `chat` is `lead`, the view is exactly today's (1A).
- **Who row.** It stays the Lead's: pet, "Lead" and the status line.
  - For a `swarmChat` device the daemon sends `state: work` only for a working group, and never `ask` or `stuck`
    (`chatLead`).
  - The bubble's ask/stuck edge therefore no longer appears for these Leads, as on the round.
- **Recap.**
  - `supertab.recap` carries `chatId`. A recap whose `chatId` is not the Lead's current `chat_id` is dropped.
  - After a chat switch, the bubble shows "…" until the new chat's recap arrives. This is the race the round fixed in
    #2232.
- **Notices** (mockup 1D, 1E). `supertab.notice {tab, lead, chat, chatId, id, text, at}`:
  - **Toast:** the `ph_toast` card. The name is the project, followed by "· <Swarm name>" in the Super Tab tag style
    (`ph_sb_22`, `#8EA3BD`). The line is the text's first sentence, and the timer runs as for an agent's notice.
  - **Notices row:** one per Lead, keyed by (tab, lead), with the newest replacing the older one.
    - It uses the inbox bubble. The name line is "<project> · <Swarm name>" (tag in `#6B4FA3`), with the age at the
      right.
    - The avatar is the Lead's pet.
    - It has no ask edge and no diamond badge, because those mark a Super Tab question.
    - Order: after the asking agents, merged with the agent entries newest first.
  - **Tap** on the toast or the row: open that Lead's view (`pod_nav_follow_lead`) and send `supertab.select`, as a tap
    on a Swarm card's pet does.
  - **`supertab.notice.read {tab, lead, chatId}`:** remove the row whose `chatId` matches, and end its toast if it is
    up.
  - **Sound:** a notice uses the beep and wake of an agent's alert notice. A Pro that is muted stays silent.
- **Empty-Lead focus.** `supertab.focus {tab, lead: ""}` opens that Swarm's Lead view:
  - on the Lead it last showed in that Swarm (kept in RAM per Swarm id, lost on reboot);
  - else on its first Lead.
  - A Swarm not in the list yet waits `POD_FOLLOW_PENDING_MS`, as a named Lead does today.
  - The quiet-window and talking rules of `apply_lead_focus` apply unchanged.

### Phase 2: PM | Buddy

- **The pill** (mockup 2A). It is shown only when the Lead carries `buddies: true`.
  - Geometry: 300 × 44 at (210, 16), radius 22, track `#34302C`. It has two 150 px segments, "PM" and "Buddy"
    (`ph_sb_22`).
  - The selected segment is filled: PM in `PH_ROOM_INK` with dark text, Buddy in lilac `#C49BFF` with dark text. The
    Swarm purple `#B79CFF` is too close to lilac to mark PM.
  - With the pill, the header is one line centred at cy 94: the Swarm name in Swarm purple (`ph_sb_26`), " · " muted,
    then the project (`ph_sb_34`). Cut with "…" at 640 px, the project's end last.
  - The chat name, when shown, moves to cy 130. The bubble stays at y 150, 7 rows.
  - With Buddies off the view is exactly phase 1's.
- **Switching.**
  - A tap on a segment sends `supertab.side {tab, side: "pm" | "buddy"}`. The view changes when the daemon's next
    `supertab` frame says so (`side`, and the face chat it carries).
  - The pressed segment shows pressed at once, so the tap is seen.
  - The newest of the dial and the desktop wins. That is the daemon's rule (`cards.ts` `side()`, cleared when the
    desktop's open chat changes).
  - The side is per Swarm and kept across a horizontal swipe to another Lead.
  - The pill is a hit, so `talk_target` skips it as it skips `POD_A_BACK`.
- **Buddy screen** (mockup 3A–3C). It shows when the face chat is `chat: "buddy"`.
  - **Avatar.** The Buddy's avatar replaces the pet:
    - the desktop pattern (`desktop/lib/super_tabs/avatar_art.dart`), from `buddy.cells` (15-bit half, mirrored
      `[0,1,2,1,0]` over 5 rows) and `buddy.color`;
    - a disc of 120 px centred in the pet's 150 px box, the pattern at 56 % with cells rounded at 20 %;
    - no engine badge.
    - It is a port of the round's drawing (`supertab.c` / `ui_habitat.c`) to `ht_pro` primitives.
  - **Name.** In place of "Lead", the Buddy's `name` in lilac (`ph_sb_34`).
  - **Status.** Under the name, "offline" in `PH_ROOM_MUTED` while `live` is false, else nothing.
  - **Bubble.** The Buddy's last message in that chat (the recap).
  - **No Buddy** (`buddies: true`, no `buddy`):
    - no bubble and no who row;
    - a dashed 120 px circle with "+" centred at x 360;
    - "No Buddy here yet" (`ph_sb_34`, muted) and "Add one in the Harness app." (`ph_rg_28`, muted) under it.
    - The Pro cannot add a Buddy.
- **The Buddy's quiet notice** (mockup 3D). A `supertab.notice` with `chat: "buddy"` raises:
  - no toast, no Notices row and no beep;
  - a 12 px lilac dot at the Buddy segment's top right, while the PM side is shown.
  - Opening the Buddy side clears the dot. The daemon reads the notice when the Buddy chat becomes the open chat and
    sends `supertab.notice.read`. The Pro also clears the dot locally on the tap, so it never lingers on a lost frame.

### Phase 3: voice

- **Tap target.** Tapping the Lead view starts listening, as today, with these targets:
  - **PM side, local Lead:** its harness id, as today. The daemon posts into the face chat (`swarmSay`).
  - **PM side, remote Lead:** the Lead's Swarm id. This is sent only when the daemon's welcome lists `swarm.remote`
    (new `CABLE_FEATURE_SWARM_REMOTE` in the Pro's `cable_features`). An older daemon gets no target, as today.
  - **Buddy side:** the same id as on the PM side. The device names no chat. The daemon finds the Lead by that id
    and posts into the face of the side it holds for the Swarm (`swarmFaceOf`: `lead.sideChat ?? lead.chat` for a
    `swarmBuddy` session), which is the Buddy chat, as the person.
    - A Buddy post that fails is a voice error ("Could not reach your Buddy. Try again."), never a terminal turn.
- **Pet and name.** While listening and sending, the pet is the engine of the chat being spoken to: the Lead's on the
  PM side, `buddy.engine` on the Buddy side. The Pro's talk view shows a name on top and no "Sending to" label, so on
  the Buddy side the name is the Buddy's, in lilac. That is the Pro's form of the round's "Sending to your Buddy".
- **Refusals.** A post the backend refused comes back as `voice.error` and shows through the existing
  `handle_voice_error` → `PRO_VOICE_ERROR` path. It never becomes a terminal turn; that rule is in the daemon already.

## Wire

No new frame types. Everything below is what the daemon already sends to a round with the same hello.

| Hello flag (Pro → daemon) | Phase | Effect |
|---|---|---|
| `swarmChat: "v1"` | 1 | Lead entries carry `chat`, `chatId`, `chatName`; `supertab.recap` carries `chatId`; `supertab.notice` and `supertab.notice.read` are sent |
| `swarmBuddy: "v1"` | 2 | Lead entries carry `buddies` and `buddy {chatId, name, engine, cells, color, live}`; the face may be `chat: "buddy"`; the Pro may send `supertab.side` |
| welcome `features: swarm.remote` (daemon → Pro) | 3 | the Pro may name a remote Lead by its Swarm id in `voice.begin` |

- The Pro never sends `swarmReview`; the round does not either.
- A daemon from before ignores the hello flags it does not know, and the Pro gets today's frames. The Pro then behaves
  as today, because every new field is optional when parsed.

## Daemon

The one change is in `cli/src/cable/cableSession.ts` `fitFrame`:

- **Problem.** The Pro's JSON guard rejects any frame over 512 tokens whole (`cable_json_guard.c`, `CABLE_JSON_TOKENS`).
  `fitFrame` sizes the `supertab` frame by bytes only.
  - A `swarmBuddy` frame with 12 Leads, each with a Buddy, comes to about 440–480 tokens: 12 × (chatLead fields, plus
    `buddies`, plus a `buddy` object of 7 keys).
  - A Swarm with many Leads could therefore blank the Pro's Swarm view.
- **Fix.** For a device whose hello says `board: pro`, `fits()` also requires `jsonTokens(frame) <= SWARM_TOKENS_MAX`
  (480, the budget the `swarms` frame already uses). Its last step already deletes `buddy` blocks from the least
  urgent Lead up, and that step is what brings the token count down.
- The round keeps byte-only fitting and gets byte-identical frames.

## Firmware

All changes are in `devices/harness-pro/firmware/main/`.

| File | Change |
|---|---|
| `cable/pro_cable.c` | hello flags (phase 1: `swarmChat`, phase 2: `swarmBuddy`); `read_leads` parses `chat`, `chatId`, `chatName`, `buddies`, `buddy`; `handle_supertab` reads `side`; `handle_supertab_recap` reads `chatId`; new `handle_supertab_notice`, `handle_supertab_notice_read`; `handle_supertab_focus` accepts an empty Lead; `supertab.side` sender |
| `cable/cable_features.{h,c}` | `CABLE_FEATURE_SWARM_REMOTE` for `swarm.remote` (phase 3), handed to the glue through `pro_app_features` |
| `cable/cable_types.h`, `pod/pod_model.{h,c}` | `pod_lead_t`: `chat` (enum lead/pm/group/buddy), `chat_id[ID_MAX]`, `chat_name[49]` (as `project`), `buddies`, `has_buddy`, `buddy {chat_id, name, engine, cells, color, live}`, `buddy_unread`; `pod_swarm_t`: `side`; `pod_unread_t` gains `tab[ID_MAX]` and `chat_id[ID_MAX]`: a Swarm notice is an unread entry whose `agent` is the Lead id and whose `tab` is set, so the 16 cap, the order, the toast and the inbox rows are shared with agent notices |
| `pod/home/ph_lead.c` | chat name line, pill and header A, Buddy who row, no-Buddy view, lilac dot |
| `pod/home/ph_avatar.c` (new) | the Buddy avatar disc and pattern |
| `pod/home/ph_inbox.c` | Swarm notice rows merged into the list |
| `pod/home/ph_toast.c` | a Swarm notice's toast (project · Swarm name) |
| `app/pod_glue.{h,c}` | the last Lead shown per Swarm (`pod_ui_t.lead_seen[SWARMS_CARD_MAX]`, set while a Lead view is on); empty-Lead focus in `apply_lead_focus`; pill hits; notice taps; `talk_target` for a remote Lead and the Buddy side |
| `app/pro_app.c`, `pro_app_api.h` | the new model entry points under the app lock |

The limits are the existing ones: `SWARM_LEADS_MAX`, `ID_MAX` 48, `CABLE_NAME_MAX` 40. A 48-byte `chatName` fits `chat_name[49]`; anything longer is cut on a character.

## What does not change

- The Swarm card on Home, its pages and its pets.
- The horizontal swipe between Leads, the vertical scroll of the message, and `supertab.open` / `supertab.select` and
  their echo suppression.
- Agent notices, Super Tab questions and their toasts.
- The round dial, which gets byte-identical frames.

## Design (docs/feature-design-rules.md)

Reviewed revision: ______  Reviewer (another engine): ______

1. **Growth:**
   - Swarm notices share the unread list's `POD_UNREAD_MAX` (16) and its 6 h TTL, the oldest going first. The glue
     keeps one last Lead per Swarm in a fixed array of `SWARMS_CARD_MAX`.
   - The daemon keeps nothing new. [ ]
2. **Concurrency:**
   - Frames are parsed on the cable task into staging, and the model is changed under `pro_app_lock`, as for
     `supertab` today.
   - A pill tap and a desktop change can race. The daemon's newest-wins rule settles it, and the Pro draws what the
     next `supertab` says. [ ]
3. **Read cost:**
   - No new reads. The daemon already computes the face chat, recaps and notices for the round.
   - With both a round and a Pro attached, each session reads as it does today for one round. [ ]
4. **Scale:** 12 Leads with Buddies stay at or under 480 tokens (test). Beyond that, Buddy blocks drop first, then the
   view shows "No Buddy here yet" for those Leads. That is a known limit, logged by `fitFrame`. [ ]
5. **Compatibility:**
   - A new Pro with an old daemon gets today's frames.
   - An old Pro with a new daemon is unchanged, because it does not say the flags.
   - The round is unchanged.
   - Readers of the frames: `cableSession.ts`, `cable_client.c` (round), `pro_cable.c`. [ ]
6. **Migration and rollback:**
   - CLI first (the token budget), then firmware. Each is safe alone.
   - Rolling back the Pro firmware stops the flags, and the Pro returns to today's view. [ ]
7. **Audience:**
   - The face chat, PM recaps and Buddy chats are the signed-in person's own (`visibleState`, `groupView`).
   - The daemon owns the USB device only for the console user, never the Team account. [ ]
8. **Identity:** reads and voice posts run as the signed-in person (`backend(this.core, …)`), as for the round. [ ]
9. **Failure:**
   - A lost `supertab.side` leaves the old side, and the pressed segment returns to it on the next frame.
   - A lost `notice.read` leaves a row the person can tap, and the next replay drops it.
   - A frame over the guard is rejected whole. The daemon budget prevents that, and the guard's log line names it. [ ]
10. **Platforms:** daemons on macOS, Linux and Windows alike. Firmware ESP32-P4 only. [ ]

## Testing

Each phase is one PR, with the failing test first.

- **Daemon** (`cli/src/cable/cableSession.spec.ts`), phase 1 PR:
  - A `board: pro` `swarmBuddy` session with 12 Leads, every name at 48 bytes and a Buddy each: every `supertab` frame
    has `jsonTokens` ≤ 480. The least urgent Leads' `buddy` blocks go first.
  - A round session with the same data gets byte-identical frames to today.
- **Firmware host tests** (`devices/harness-pro/firmware/test`: `test_pod_model.c`, `test_ph_glue.c`, `test_ph_views.c`,
  `test_pro_app.py`, golden):
  - **Parse:** `chat`, `chatId`, `chatName`, `buddies`, `buddy`, `side`. Over-long strings are cut on a character, and
    wrong types are skipped without losing the frame. A frame without the fields parses as today.
  - **Recap:** a recap for another `chatId` is dropped, and the bubble shows "…" after a chat switch.
  - **Focus:**
    - an empty Lead opens the Swarm on its last Lead, else the first;
    - an unknown Swarm waits, then drops;
    - the quiet window still holds a focus.
  - **Notices:**
    - add, replace per Lead and the 16 cap;
    - `notice.read` removes the matching `chatId` only;
    - a tap opens the Lead and sends `supertab.select`;
    - a Buddy notice adds no row and no toast, and sets only the dot.
  - **Pill:** a tap sends `supertab.side` with the right side and does not start a talk. The pill is absent without
    `buddies`.
  - **Voice:**
    - a remote Lead's tap names its Swarm id only with `swarm.remote`;
    - the Buddy side names the Lead with the Buddy side;
    - `voice.error` ends the voice state with the message.
  - **Views (golden, run count constant per screen):** 1A–1C, 2A, 3A–3D, and Notices with a Swarm row. Ink stays
    inside 720 × 720.
  - `bash test/run.sh` and `make device-test`.
- **On Diego's Pro** (dev build 0.0.99, flashed with the repo scripts after Diego's yes, never force-flashed):
  1. The desktop opens a group, then the Lead chat: the Pro follows, and the name line comes and goes.
  2. The desktop opens another Swarm's Chat with PM: the Pro moves into that Swarm.
  3. A new Lead message makes a toast and a row. Opening the chat on the desktop removes both.
  4. The PM and Buddy buttons work both ways with the desktop, and the lilac dot shows and clears.
  5. Voice works for a remote Lead and for the Buddy. A refused post shows as a voice error.
  6. `raster_max_us` in the alive line is no higher than before, and the link shows corrupt 0.

## Unverified

- That 12 Leads with Buddies and 48-byte names exceed 480 tokens. The estimate is 440–480. The daemon test measures it
  first, and if it fits, the budget is kept as a guard.
- ~~How a voice turn names the Buddy side.~~ Checked 2026-10-30: it does not. `voice.begin` carries the Lead's id
  (its local harness, or its Swarm id when remote), and the daemon takes the side it holds (`swarmFaceOf`,
  `cableSession.ts:2758`).
- ~~Whether the fonts exist.~~ Checked 2026-10-30: `ph_sb_22`, `ph_sb_26`, `ph_sb_34` and `ph_rg_28` are in the Pro's
  set.
