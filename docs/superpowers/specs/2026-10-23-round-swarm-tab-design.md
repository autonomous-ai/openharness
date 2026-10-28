# Round dial: the Swarm tab

Status: design from the owner-approved mockup and the owner's decisions (2026-10-23). Mockup:
`devices/harness-device/mockup/round-swarm/index.html` (gitignored, main checkout; 27 screens rendered by the Round firmware
code at 669e65df9, which is identical to the firmware on origin/main f67349146). Builds on the Harness Pro Swarm card
(#1537, #1548; `docs/plans/2026-10-22-pro-swarm-card-design.md`), whose daemon side and cable frames this reuses.

## Problem

A Swarm reaches the round dial only as an ordinary desktop tab. The desktop reports that tab's terminal panes, which
is the Lead of the selected project and nothing else. The dial cannot show the Swarm's other projects. It cannot show
what each Lead last said, or which Lead needs a person. It never sees a Swarm the desktop has not opened, and it does
not hear about a Lead that runs on someone else's machine. The daemon already reads all of this for the Harness Pro
(`swarmCard: "v1"`), but the round dial does not ask for it.

## Goal

On the round dial, each Swarm is one more tab in the existing tab list. It looks exactly like every other tab. Inside
it, each project of the Swarm is a pane showing that project's Lead. A swipe moves between projects as it moves
between panes today, and the existing agent face shows the Lead's state and last message. A Lead that needs a person or
is stuck beeps and adds one entry to the existing inbox, whether it runs on this computer or on someone else's. You can
talk to a Lead that runs on this computer as to any pane. A Lead on another machine is read-only.

Everything uses the round dial's own screens: the TABS carousel, the agent face (`ht_focus_face`), the PANES carousel,
the inbox, the bell, the talk screens. Only the data is new.

Out of scope: a Swarm home or overview screen; a Pro-style card; showing workers (Engineer/Reviewer agents) as panes;
answering or posting to a Lead on another machine; answering a Super Tab wait on the dial; any desktop change.

## Terms

- **Swarm**: a Super Tab (`superTab` in the code and on the wire).
- **Lead**: the system name of a project's coordinating agent. Its on-screen name is **Product Manager**
  (`docs/naming-system.md`). No string on the dial names either one.
- **Desk tab**: an ordinary desktop tab. In the round firmware this is a `swarms` frame row (`cable_swarm_t`, `s.tabs`,
  `cable_client_select_swarm`). That old internal name stays (naming system: internal names are not renamed). Do not
  mistake it for a Swarm.
- **Swarm pane**: one project's Lead, shown on the dial as a pane of the Swarm tab.

## Decisions (owner, mockup section 7 "Đã quyết")

1. **The Swarm tab looks like any tab.** Same font and colour in TABS. No badge, capsule or colour of its own; people
   tell it apart by its name (1a–1c).
2. **TABS mirrors the desktop's tabs exactly.** A Swarm with no desk tab is never listed, with or without a desktop
   window. Changed 2026-10-27 (Diego), replacing "Swarms not open on the desktop are listed too" (1d): the desktop
   opens a tab for every Super Tab its owner has not closed, so a Swarm with no desk tab is a closed one, and the dial
   kept showing closed tabs ("PR merge"; 2 app tabs gave about 5 dial tabs). Screen 1d is dropped.
3. **Projects keep a fixed order**: the Swarm's project order, the same as in the app, never sorted by state. Swiping
   never jumps (2a–2h, 3a–3c).
4. **A Lead on another machine that needs you, or is stuck, also beeps** (2e′, 4e).
5. **No reply to a remote Lead in v1.** It is read-only on the dial; people answer on the desktop (2e, 2e′, 5e).
6. **Leads only.** No worker agents as panes (2, 3).
7. **The project order comes from a new `leads[i].order`.** Today the daemon sorts Leads by urgency for the Pro
   (`cli/src/superTabs/cards.ts`). The round dial needs the original position, so the daemon adds `order`, which the
   Pro ignores.
8. **The inbox entry text for a remote Lead is fixed and approved**: "Needs you. Answer on the desktop." and "Stuck.
   See the desktop." (4e).

## Design

### 1. Cable

The round dial uses the Pro's frames exactly as they are (`cli/src/cable/cableSession.ts`, from #1537). The daemon
needs no new frame and only one new field.

**Hello.** The round dial adds two capabilities, both already defined in the daemon:

- `"swarmCard":"v1"`: the daemon then sends `supertabs`, `supertab`, `supertab.recap` and `supertab.focus`, and
  accepts `supertab.recap.get`, `supertab.open` and `supertab.select`. The first capable device makes the superTabs
  service start its 5 s backend poll (`swarmCardsWanted`).
- `"superTab":"wait-v1"`: the daemon then sends Super Tab waits as `question` frames carrying `superTab` (the Swarm's
  name, ≤48 bytes) and `attention` (`"decision"` or `"stuck"`), and resends them on resync. Today the daemon holds them
  back from a round dial because it would open an answer screen that cannot load (`cableSession.ts`, `superTabWaits`).
  Section 5 is the rule that makes that safe.

`seq` stays Pro-only (`board === 'pro'`); the round dial's frames are unchanged.

**Frames the dial reads** (shapes from the Pro spec §3):

```
{"t":"supertabs","ids":["<superTabId>",...]}                                    ≤16, desktop-open Swarms first
{"t":"supertab","id":"<superTabId>","tab":"<desk tab id or empty>","name":"openharness","count":4,
  "leads":[{"id":"<leadAgentId>","projectId":"…","project":"mobile","engine":"claude","owner":"",
            "local":"<harnessId or empty>","state":"ask|stuck|work|done","since":134,"order":0}]}   ≤12 Leads
{"t":"supertab.recap","tab":"…","lead":"…","text":"…","at":1792560000,"none":false}            text ≤1,500 bytes
{"t":"supertab.focus","tab":"…","lead":"…"}
{"t":"question","agentId":"<harnessId>","name":"…","id":"supertab:…","questions":[{"q":"…"}],
  "superTab":"openharness","attention":"decision|stuck"}
{"t":"question.close","agentId":"<harnessId>","id":"supertab:…"}
```

**Frames the dial sends:** `supertab.recap.get {tab, lead}`, `supertab.open {tab, lead|""}`, and
`supertab.select {tab, lead}`. All three are constructed in `cable_client.c`, as every message is.

**New field `order`** (decision 7): each Lead's 0-based position in its Swarm's project list (`state.projects`; the
synthetic `lead` project of an older tab is 0). It is taken before the urgency sort and the cut to 12. When a Swarm has
more than 12 projects, the 12 sent are still the most urgent ones, so `order` can have gaps; the dial sorts by it and
ignores the gaps. The cost is 2 JSON tokens per Lead: 24 more for a 12-Lead frame, measured under 260 tokens today and
under the 512-token guard on both dials. The Pro reads Lead fields by name (`pro_cable.c` `read_leads`), so it ignores
`order`. On a frame without `order` (a daemon from before this change), the dial keeps the frame's order.

**Data per screen** (mockup section 6):

| Screen | Data | On the wire today? |
| --- | --- | --- |
| 1a–1c Swarm in TABS | `swarms` rows (desk tabs) + `supertab.tab` linking a Swarm to its desk tab | Yes |
| 2a–2h Swarm pane | `supertab.leads[i]` {project, engine, owner, local, state, since} | Yes |
| 2, 3 Fixed order | `leads[i].order` | **New** (daemon) |
| 2 Recap card | `supertab.recap` ← `supertab.recap.get`, pushed for the Lead named by `supertab.open` | Yes |
| 2 swipe, 3 PANES pick | `supertab.select` then `supertab.open`; `supertab.focus` when the desktop moves | Yes |
| 2c, 2d, 4 local Lead waits | `question` with `superTab`/`attention`, `question.close` | Yes, behind `wait-v1` |
| 2e′, 4e remote Lead | `leads[i].state` ask/stuck with `local:""`; card = `supertab.recap` | Yes; firmware rule (§5) |
| 5 Talk | `leads[i].local` → existing voice path | Yes |

### 2. Firmware model (new `supertab` module)

A pure module, `main/ui/habitat/supertab.c/.h`, in the style of `workspace.c` and `visit.c`, with no LVGL and no cable
code, tested on the host. It holds:

- the Swarm id list (≤16) and one record per Swarm: `id`, `tab` (desk tab id or empty), `name` (≤48 bytes + NUL),
  `count`, and Leads (≤12), sorted by `order` and stable on ties. Each Lead record holds `id`, `project_id`, `project`,
  `engine`, `owner`, `local`, `state`, `since_s` plus the dial clock at receipt, and the previous `state` (for §5);
- one recap slot: the open Lead's text (≤1,500 bytes + NUL), its `at`, and a flag for none, loading or loaded. The
  slot belongs only to the Swarm pane on the face (mockup: "only the open project's recap"; the Pro also drops
  recaps on close);
- the transition events in §5: entered ask, entered stuck, left ask/stuck, and Lead gone.

It lives in PSRAM (`EXT_RAM_BSS_ATTR`, like the UI state `s`). The worst case is 16 × 12 Leads × about 280 bytes,
about 54 KB, plus one 1.5 KB recap. A `supertab` frame for an id not in the last `supertabs` list is dropped. A
`supertabs` list drops the records whose ids left it.

### 3. TABS (screens 1a–1c)

The TABS carousel lists, in order:

1. The desk tabs, as today, from `swarms`. A desk tab linked to a Swarm (some Swarm's `tab` equals its id) stays at its
   desk position and keeps its name. It is listed even when its `agents` is 0 (today `ui_swarms_replace` hides such a
   tab; a Swarm tab whose selected project's Lead runs elsewhere may report 0).
2. Nothing else (decision 2). A Swarm whose `tab` is empty or names no listed desk tab is not listed; with no desktop
   window (an empty `swarms` list) TABS is empty. The `supertabs` and `supertab` frames are unchanged: the dial still
   needs the cards to enter a Swarm from its desk tab and to follow the desktop.

Every entry uses the same `tab_name`/`tab_split` drawing, the same ink and the same fade (decision 1). The list can
hold 24 desk tabs; the carousel takes the count and needs no paging.

Opening a tab (tap on its name, or ✓):

- **Ordinary desk tab:** unchanged (`tab_request` → `cable_client_select_swarm`, workspace handshake).
- **Swarm, open on the desktop or not:** entered locally, with no workspace handshake, because the dial already has
  the Swarm's data. The face shows the Swarm's current pane (§4: the Lead the desktop has open if `supertab.focus`
  named one, else the first by `order`). The dial sends `supertab.select` for that Lead, then `supertab.open`.
  `supertab.select` makes the desktop focus or reopen that Swarm tab at that project (`dial_super_tab`, desktop
  `app_state.dart`); with no desktop window it does nothing.

Hold on the face still opens TABS (`tabs_open`); the carousel opens on the current tab or Swarm.

### 4. Inside a Swarm tab (screens 2a–2h, 3a–3c)

While the dial is in a Swarm tab, its panes are that Swarm's Leads in `order`, not the desk roster (`s.agents`). A
desk roster that arrives for the linked desk tab (the Lead's terminal pane) does not replace them. Decision 6: one
pane per project, no workers.

**The face** is the existing agent face (`render_home` → `ht_focus_face`), built from the Lead:

| Lead | Upper arc | Middle | Card / lower arc | Mockup |
| --- | --- | --- | --- | --- |
| `work`, local (`since` set) | project | engine pet, working scene | elapsed from `since` + dial time since receipt, on the lower arc | 2a |
| `work`, remote (no `since`) | project | pet, or the engine's 56 px mark when the engine has no pet | "Working..." with no time | 2e |
| `done` | project | pet | recap card: Lead's last message, ≤4 lines then "…", pet shrinks | 2b, 2g |
| `done`, recap `none` | project | resting face | existing one-line hint | 2f |
| `ask`, local with an open wait | project | pet in asking pose | wait text (`questions[0].q`) in the recap's place | 2c |
| `stuck`, local with an open wait | project | pet in asking pose, no red | "Stuck: …" text from the daemon | 2d |
| `ask`/`stuck`, remote (or local without a wait) | project | pet in asking pose | recap card (last message) | 2e′ |
| no Leads | — | "No panes in this tab." + "Choose a tab" (→ TABS) | — | 2h |

The upper-arc name is cut on the arc like every pane name (2b). Text that cannot be drawn in Inter goes through the
existing `ui_can_display` checks.

**Recap.** When a Swarm pane comes onto the face (entering, swipe, PANES pick, follow), the dial sends
`supertab.recap.get` and `supertab.open` for it and clears the recap slot. Until the text arrives, the face draws the
state without a card: the working line for `work`, the resting face otherwise. (Not in the mockup.) If no answer
arrives within 5 s, the dial asks once more; the daemon ignores a repeat within 1 s. A `supertab.recap` for any other
Lead is dropped. Leaving the Swarm tab, or the face leaving for another tab, sends `supertab.open` with `lead:""`.

**Swipe.** A horizontal swipe on the face moves to the next or previous project, as on panes today (`habitat_touch`,
including the wrap at the ends). It sends `supertab.select` + `supertab.open` + `supertab.recap.get`, and never
`focus` or `agent.open`: a Lead id is not a cable agent id.

**PANES** (tap on the upper-arc name; 3a–3c): the existing `render_focus_panes` carousel. One page per Lead in `order`
(`pane_label` = project). Long names split over two lines with "…" (`tab_split`, 3b). It opens on the current project.
✓ or a tap on a name picks one, same messages as a swipe. Up to 12 pages, with no paging dots (3c).

**Following the desktop.** `supertab.focus {tab, lead}`: when the dial is in that Swarm tab, the face moves to that
Lead (same rules as `focus` today: not while talking, not in a question or form view). When the dial is in that
Swarm's linked desk tab because the desktop selected it, the dial enters the Swarm at that Lead. Otherwise the dial
remembers the Lead as the Swarm's current pane for the next time it is entered. The daemon already suppresses the echo
of the dial's own pick (`picked`, `PICK_ECHO_MS`).

**Changes while you watch.** A new `supertab` keeps the face on the same Lead id. If that Lead is gone, the face moves
to the Lead now at the same position, or shows 2h if none are left. If the Swarm leaves `supertabs`, the dial returns
to TABS.

### 5. Needs you / stuck: beep and inbox (screens 4a–4f, 2e′)

There is no toast. A Lead entering `ask` or `stuck` gets the existing alert path: a beep (`audio_notify_done`, at most
one per 30 s), a display wake, and one inbox entry. The face changes only as it does today: the green bell pill at
y 400 with the unread count, or the pet's bell bubble while the pet is working (4a, 4b). Pull down from the face, or tap
the bell, opens the inbox (`render_focus_inbox`).

Rules, for every Lead of every Swarm in `supertabs` (on this machine or not):

- **One entry per Lead**, keyed by the Lead's agent id. It is a question-type entry, so it sorts before recaps and
  never expires after 6 h.
- **The trigger is the Lead's `state`.** A change from anything else (including not yet seen) to `ask` or `stuck`
  adds the entry and beeps (decision 4). The text is fixed: "Needs you. Answer on the desktop." or "Stuck. See the
  desktop." (decision 8). A change back to `work`/`done`, or the Lead leaving the list, removes the entry.
- **Wait text for a Lead on this machine.** A `question` frame with `superTab` whose `agentId` equals some Lead's
  `local` replaces that Lead's entry text with `questions[0].q` and makes the Lead's face show it (2c, 2d). It never
  opens the question or answer screen: `ui_question_show` is not called for it. Its `question.close` reverts the text
  to the fixed text while the Lead is still `ask`/`stuck`. Since the entry is one per Lead and the beep is coalesced,
  a wait arriving before or after the state change beeps once (mockup: "no double beep").
- **A Super Tab wait from a non-Lead** (a worker on this machine) adds no entry of its own (decision 6). The project's
  Lead already reads `ask`/`stuck` from the same assignment, which raises the Lead's entry. *(Interpretation of
  decision 6 for the inbox; confirm.)*
- **On the face:** an entry for the Lead on the face is read at once and does not beep (the existing `on_face` rule).
- **Survives `notif.replace`.** The desktop's inbox snapshot replaces the desktop rows only. The dial's Swarm entries
  are kept and re-merged (today `ui_notif_replace` rebuilds `s.notice` from the snapshot alone, which would drop
  them).

**The entry card** (4c–4e): grey top line = the Swarm's name (the wait's `superTab`, else the Swarm record's name), in
the seat where `machine` goes today. Green line = engine mark + project. Body = the wait text or the fixed text.
Swipe pages through entries as today. Tapping the entry enters that Swarm at that Lead (§3 entry path), so the face
shows 2c / 2d / 2e′ instead of the agent open path. 4f "No notification" is the existing empty inbox.

### 6. Talk (screens 5a–5e)

A tap on the face of a Lead with `local` talks to it exactly as to any pane: the existing listening, sending and back
flow, with `cable_client_voice_begin(local, …)` (5a–5d). An engine without a listening scene uses the seven bars (5e).
After sending, the face returns to the working state from the next `supertab` (the daemon reads a local Lead's live
turn when it builds the cards). A Lead without `local` (remote) has no talk: a tap on its face does nothing, and there
is no reply path in v1 (decision 5).

### 7. Interactions

| Input | Desk tab (today) | Swarm tab |
| --- | --- | --- |
| Tap face | talk to the pane | talk to a local Lead; nothing on a remote Lead |
| Tap upper-arc name | PANES | PANES of the Swarm's projects |
| Hold face | TABS | TABS |
| Horizontal swipe on face | next/previous pane, `focus` | next/previous project, `supertab.select` + `open` + `recap.get` |
| Pull down / tap bell | inbox | inbox |
| Tap inbox entry | open that agent | enter that Swarm at that Lead |
| Side button (BOOT) tap | stop a busy pane's turn (STOP), cancel voice, else HOME | stop a busy **local** Lead (STOP on `local`); cancel voice; else HOME. No stop for a remote Lead |
| Side button hold | screen on/off | screen on/off |

### 8. Daemon

- `cli/src/superTabs/cards.ts`: `SwarmLead.order` (§1), set in `leadsOf` before the sort. The leading comment that
  says "in project order then by urgency" is wrong today (the code sorts by urgency first) and is corrected.
- `cli/src/cable/cableSession.ts` `pushSwarmCards`: `order` copied onto each Lead of the `supertab` frame.
- Nothing else. The round dial gets every other frame by naming the capabilities. The service, core bridge, devices
  service and desktop are unchanged.
- `devices/harness-pro/docs/cable.md`: `order` documented as optional and ignored by the Pro.

## Errors and edge cases

- **Daemon without `order`:** the dial keeps the frame order (urgency). Usable, but it jumps; the release notes say
  to update the CLI first.
- **Daemon from before #1537:** it sends no `supertab*` frames. The TABS list has only desk tabs, and a Swarm's desk
  tab behaves as today.
- **No desktop window:** desk tabs are empty. Swarms from the backend are still listed (all at the end), and
  `supertab.select` is harmless.
- **Signed out / backend unreachable:** the daemon keeps the last cards (Pro spec). The dial shows what it last
  received.
- **Reconnect:** the dial clears the Swarm model and its Swarm inbox entries on link loss. On attach, the daemon
  resends all cards (force) and every open wait, and the transitions re-raise entries. The beep coalesce holds a
  burst of re-raised entries to one beep.
- **More than 12 projects:** 12 panes (the most urgent, then sorted by `order`). `count` carries the real number; the
  dial does not show it.
- **Malformed Lead:** skipped, not the frame (as on the Pro). An unknown `state` reads as `done`.
- **A desk tab linked to a Swarm whose `supertab` has not arrived yet:** it behaves as an ordinary desk tab until it
  does.

## Testing

- **CLI:** `cards.spec.ts` (`order` = project position, kept through the urgency sort and the cut; old tab → 0);
  `cableSession.spec.ts` (a round hello with `swarmCard:"v1"` and `superTab:"wait-v1"` gets `supertab*` frames without
  `seq`, and waits; `order` on every Lead; a 16×12 frame under 512 tokens).
- **Pro firmware:** `test_pro_cable.c`, a Lead with `order` parses the same as one without.
- **Round firmware, host:** a new `test_supertab.c` (model, order, caps, transitions, recap slot); cable handlers with
  real cJSON in `test_cable_identity.py` (needs `IDF_PATH`); `test_touch_ui.py` scenes and portraits for every mockup
  screen (TABS, faces, PANES, inbox, talk), each scanned for Inter-only text and ink inside r 230;
  `test_question_ui.py` (a Super Tab wait never opens the question screen); `test_voice_ui.py` (local Lead talks,
  remote does not).
- **Renders:** the round dial has no checked-in pixel goldens (the Pro's `golden.sh`). Its renders are
  `HABITAT_PREVIEW_DIR` portraits (PPM + JSON spec) from `test_touch_ui.py`, compared by eye with the mockup, plus scene
  assertions in the test itself.
- **Device:** a dev build (`-DPROJECT_VER=0.0.99`) on a round dial with a dev CLI, against the "openharness" Swarm.

## Screen → section map

| Mockup | Section |
| --- | --- |
| 1a, 1b, 1c | §3 TABS, decision 1 |
| 2a | §4 face (work, local) |
| 2b, 2g | §4 face (done, recap), §2 recap slot |
| 2c | §4 face (ask, local), §5 wait text |
| 2d | §4 face (stuck, local), §5 |
| 2e | §4 face (work, remote), §6 no talk, decision 5 |
| 2e′ | §4 face (ask, remote), §5, decision 4 |
| 2f | §4 face (none) |
| 2h | §4 face (no Leads) |
| 3a, 3b, 3c | §4 PANES, decision 3 |
| 4a, 4b | §5 bell / pet bubble |
| 4c, 4d | §5 entry card, wait text |
| 4e | §5 remote rule, decision 8 |
| 4f | §5 (existing empty inbox) |
| 5a–5d | §6 talk |
| 5e | §6 bars; remote Lead has no talk |
| Section 6 (cable data) | §1 |
| Section 7 (decisions) | Decisions 1–8 |

## Unverified

- The voice router accepts `voice.begin` for a local Lead's harness id when that harness is not in the dial's current
  roster (a Swarm's desk tab may not hold it). This is expected, since voice is routed by `agentId` in the daemon, but
  it has not been tested.
- `dial_super_tab` reopening a Swarm that the desktop has never opened (Pro spec §5 says "focus (or reopen)"). This
  has not been checked against the desktop code on main.
- What a Swarm desk tab reports as `agents` when its selected project's Lead runs on another machine. The spec
  defensively lists linked desk tabs with 0 agents.
- The published round firmware version. `version.txt` on main reads 0.0.86, but 0.0.92 was reported published on
  2026-10-20. Check the GCS manifest before choosing the release version.
