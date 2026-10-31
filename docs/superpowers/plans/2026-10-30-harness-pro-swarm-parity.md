# Harness Pro Swarm Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Harness Pro shows and alerts on the chat the desktop has open in each Swarm project, switches PM | Buddy,
follows the desktop into a Swarm with no project open, and talks to remote Leads and Buddies, exactly as the round dial
does.

**Architecture:** The Pro adopts the round's cable protocol (hello `swarmChat v1`, then `swarmBuddy v1`, then honours
the welcome's `swarm.remote`). The daemon already speaks all of it. Its only change is a token budget in `fitFrame`
for the Pro's 512-token JSON guard. Three PRs, one per phase. Tasks 1–6 are PR 1, tasks 7–10 are PR 2 and task 11 is
PR 3.

**Tech Stack:**
- Firmware: C11, ESP-IDF 5.5.4 at `~/esp/esp-idf-5.5.4`, ESP32-P4. Host tests through `test/run.sh`, using cJSON from
  that IDF tree.
- Daemon: TypeScript with vitest.

**Spec:** `docs/superpowers/specs/2026-10-30-harness-pro-swarm-parity-design.md`.
Mockup: `devices/harness-pro/mockup/pro-swarm-parity/index.html` in the main checkout (gitignored), screens 1A–3D.

## Global Constraints

- **Wire:** no new frame types and no new daemon frames. The Pro says `swarmChat: "v1"` (PR 1) and `swarmBuddy: "v1"`
  (PR 2), never `swarmReview`.
- **Round:** gets byte-identical frames. Every daemon change is gated on `hello.board === 'pro'` (`seqOn`).
- **Copy, verbatim:**
  - "No Buddy here yet"
  - "Add one in the Harness app."
  - "offline"
  - "PM"
  - "Buddy"
- **Colours:**
  - room ground `#221F1D` (`PH_ROOM_BG`), ink `PH_ROOM_INK`, muted `PH_ROOM_MUTED`;
  - Swarm purple `#B79CFF`, Buddy lilac `#C49BFF`, pill track `#34302C`;
  - inbox tag `#6B4FA3`, toast tag `#8EA3BD`.
- **Group chat name:** the title only, with no "#".
- **Stack caps:** every function on the cable task (`pod_model.c`, `pod_nav.c`, `pod_glue.c`, `pro_cable.c`) is
  ≤ 1024 B and `pod/home/*.c` ≤ 4096 B (`-Wframe-larger-than`, enforced by `run.sh`).
- **No device features beyond the spec.** Do not edit `cli/src/lib/e2ee/core.ts`.
- **Device:**
  - Flash only Diego's Pro, only with the repo scripts, dev build `-DPROJECT_VER=0.0.99`, and only after Diego says
    yes. Never force-flash: the P4 bricks on a wrong-revision image.
  - Never upload or publish firmware.
- **Git:**
  - Commit and push only when Diego asks. Stage only this plan's files.
  - One PR per phase. Merge with `make merge-pr` once `ci/required` is green.
- **Comments:** match the surrounding density. These files carry a long header comment and one-line field comments;
  update the header comment of each view you change.

## Review Focus

1. **A 48-byte chat or Buddy name of multi-byte UTF-8** must be cut on a character, never mid-codepoint. Pinned in
   Task 2 (`chat_name_cut_on_codepoint`) and Task 7.
2. **A `supertab` frame that drops a Lead's `chat` fields** (an older daemon, or a frame resent after reconnect) must
   not leave the last chat's name or recap on screen. Pinned in Task 2 (`frame_without_chat_clears_it`).
3. **A `notice.read` that arrives before its `notice`** (reordered on reconnect) must not remove another chat's row or
   crash. Pinned in Task 4 (`notice_read_other_chat_keeps_row`).
4. **An unplug while the Buddy side is shown:** on relink the side comes from the daemon's next `supertab`, and no
   lilac dot sticks. Pinned in Task 9 (`relink_clears_buddy_dot`).
5. **A tap on the pill while a talk is armed** must switch side and never start a voice turn. Pinned in Task 9
   (`pill_tap_never_talks`).

---

## PR 1: the chat the desktop has open (spec § Phase 1)

### Task 1: Daemon token budget for the Pro

**Files:**
- Modify: `cli/src/cable/cableSession.ts:203-217` (`fitFrame`) and its caller at `:2869`
- Test: `cli/src/cable/cableSession.spec.ts`, in `describe('swarmBuddy')` (`:4551`)

**Interfaces:**
- Produces: `fitFrame(frame, tokens?: number)`. When `tokens` is given, a frame fits only if
  `jsonTokens(frame) <= tokens` as well as being under `CABLE_MAX_PAYLOAD`. The caller passes `SWARM_TOKENS_MAX` (480)
  when `this.seqOn` (a Pro), else nothing.

- [ ] **Step 1: Write the failing tests**
  - `it('a Pro's swarmBuddy supertab frame stays within 480 JSON tokens with 12 Leads and a Buddy each')`
    - 12 `withBuddy`-style Leads, every `project`, `owner`, `chatName` and `buddy.name` at 48 bytes.
    - Hello `{ ...BUDDY, board: 'pro' }`.
    - Assert `jsonTokens(frame) <= 480` for every `supertab` frame.
    - Assert that when any `buddy` was dropped, the remaining ones are on the most urgent Leads (lowest indexes).
  - `it('a round's swarmBuddy supertab frame is unchanged by the Pro budget')`
    - The same cards with the `BUDDY` hello.
    - Assert all 12 `buddy` blocks are present and the bytes equal the frame built before this change: snapshot the
      `supertabBytes(port)` hex.
  - `jsonTokens` is module-private. Export it as `export function jsonTokens` for the test only if the spec file cannot
    reach it; otherwise count in the test with the same rule.
- [ ] **Step 2: Run them.** `cd cli && npx vitest run src/cable/cableSession.spec.ts -t "480 JSON tokens"`.
  Expected: the Pro test FAILs with a token count over 480. If it passes, record the measured count in the PR (spec
  § Unverified) and keep the change as a guard.
- [ ] **Step 3: Implement.** Add the `tokens` parameter to `fitFrame`. `fits()` becomes the byte test AND (no `tokens`
  OR `jsonTokens(frame) <= tokens`). The existing order of cuts stands: Buddy names, then all names, then `buddy`
  blocks from the last Lead up.
- [ ] **Step 4: Run the tests.** `npx vitest run src/cable/cableSession.spec.ts` → PASS. Then
  `npm run typecheck && npm run test:harnessd` → PASS.
- [ ] **Step 5: Commit** `fix(cable): a Pro's Swarm frame fits its 512-token guard`.

### Task 2: Parse and keep each Lead's face chat; gate the recap on it

**Files:**
- Modify:
  - `devices/harness-pro/firmware/main/cable/cable_types.h:77-92`
  - `cable/pro_cable.c` (`read_leads`, `handle_supertab_recap`)
  - `pro_app_api.h:49`, `app/pro_app.c`
  - `app/pod_glue.{h,c}` (`pod_ui_supertab_recap`)
  - `pod/pod_model.{h,c}` (`pod_model_supertab`, `pod_model_supertab_recap`)
- Test: `test/test_pro_cable.c` (the Swarm cards block, `:1100`), `test/test_pod_model.c`, and the stub in
  `test/test_pro_cable.c:91`

**Interfaces:**
- Produces in `cable_types.h`:
  ```c
  typedef enum { POD_CHAT_NONE, POD_CHAT_LEAD, POD_CHAT_PM, POD_CHAT_GROUP, POD_CHAT_BUDDY } pod_chat_t;
  // pod_lead_t gains:
  pod_chat_t chat;                        // NONE: the frame named no chat (an older daemon): today's Lead view
  char chat_id[ID_MAX], chat_name[49];    // chat_name as project: 48 bytes + NUL, cut on a codepoint
  ```
- Produces: `void pro_app_supertab_recap(const char *tab, const char *lead, const char *chat_id, const char *text, uint32_t at, bool none)`,
  with `chat_id` "" when absent. The same parameter is added to `pod_ui_supertab_recap` and `pod_model_supertab_recap`.
- Rule in `pod_model_supertab_recap`: a non-empty `chat_id` different from the Lead's `chat_id` is dropped. In
  `pod_model_supertab`, a Lead whose incoming `chat_id` differs from the kept one has its text freed and its recap set
  to `POD_RECAP_NONE`, so the view asks again and shows "…".

- [ ] **Step 1: Write the failing tests**
  - In `test_pro_cable.c`:
    - `supertab_reads_chat_fields`: feed a `supertab` whose Lead has
      `"chat":"group","chatId":"g1","chatName":"review-cable-fit"` and check `chat == POD_CHAT_GROUP`,
      `chat_id == "g1"` and `chat_name == "review-cable-fit"`.
    - `chat_name_cut_on_codepoint`: a 60-byte name of "é" (2 bytes each) gives `strlen(chat_name) == 48`.
    - `bad_chat_types_keep_frame`: `"chat":7` gives `POD_CHAT_NONE` and the Lead is still there.
    - `supertab_recap_reads_chat_id`.
  - In `test_pod_model.c`:
    - `recap_for_old_chat_dropped`: Lead on `g1`, recap with `chat_id` `"lead-c1"`, so the recap stays LOADING.
    - `chat_switch_resets_recap`: a LOADED Lead gets a frame with a new `chat_id`, so it becomes `POD_RECAP_NONE` and
      `text == NULL`.
    - `frame_without_chat_clears_it`: a Lead on `g1` gets a frame without chat fields, so `chat == POD_CHAT_NONE` and
      `chat_name[0] == 0`.
- [ ] **Step 2: Run.** `bash devices/harness-pro/firmware/test/run.sh`. Expected: compile errors on the new fields,
  then CHECK failures.
- [ ] **Step 3: Implement.** Add the fields. In `read_leads`, map `"lead"/"pm"/"group"/"buddy"` and anything else to
  NONE, and copy with the file's existing UTF-8-safe copier, as for `project`. Thread `chat_id` through the four recap
  functions. Apply the two model rules above.
- [ ] **Step 4: Run** `run.sh` → all PASS (including `test_pro_app.py` and the golden check; no view changed yet).
- [ ] **Step 5: Commit** `feat(pro): each Swarm Lead's face chat, and its recap only for that chat`.

### Task 3: The chat name line on the Lead view

**Files:**
- Modify: `devices/harness-pro/firmware/main/pod/home/ph_lead.c` (header comment, enum, `ph_view_lead`)
- Test:
  - `test/test_ph_views.c`
  - `test/pod_render.c`: new scenes `lead:group` and `lead:pm`
  - `test/golden.txt`, regenerated

**Interfaces:**
- Consumes: Task 2's `chat`, `chat_name`.
- Produces: `CHAT_CY = 120` in `ph_lead.c`'s enum (Task 9 moves it to 130 under the pill).

- [ ] **Step 1: Write the failing tests**
  - `lead_view_group_shows_chat_name`: a Lead with `chat = POD_CHAT_GROUP` and `chat_name = "review-cable-fit"`
    renders a text run whose string is `"review-cable-fit"`, with its vertical centre at 120 ± 2 and colour
    `PH_ROOM_MUTED`.
  - `lead_view_lead_chat_unchanged`: `chat = POD_CHAT_LEAD` gives the same run list as `POD_CHAT_NONE`.
  - `lead_view_chat_name_capped`: a 48-byte "W…" name is cut with "…" at 640 px.
  - Add scenes `lead:group` and `lead:pm` to `pod_render.c`.
- [ ] **Step 2: Run** `run.sh` → FAIL on the new CHECKs, and `test/golden.sh --check` → exit 1 (new scenes).
- [ ] **Step 3: Implement.** When `chat` is `POD_CHAT_PM` or `POD_CHAT_GROUP`, draw `chat_name` with
  `centred(s, CHAT_CY, &ph_sb_22, PH_ROOM_MUTED, …)` after `fit_line` at `HEAD_W`.
- [ ] **Step 4: Run** `run.sh` → PASS. Run `test/golden.sh` and confirm `git diff test/golden.txt` adds only the two
  new scenes, with every existing hash unchanged. Render both with `test/pod_render.py` and compare with mockup 1B/1C.
- [ ] **Step 5: Commit** `feat(pro): the Lead view names the chat the desktop has open`.

### Task 4: Swarm notices: toast, Notices row, read

**Files:**
- Modify:
  - `pod/pod_model.{h,c}` (`pod_unread_t`, new functions)
  - `cable/pro_cable.c` (dispatch at `:1014-1018`, new handlers)
  - `pro_app_api.h`, `app/pro_app.c`
  - `app/pod_glue.{h,c}` (notify, the toast tap and the inbox row tap for a Swarm entry)
  - `pod/home/ph_inbox.c` (`row`: name line), `pod/home/ph_toast.c` (name line)
- Test: `test/test_pro_cable.c`, `test/test_pod_model.c`, `test/test_ph_glue.c`, `test/test_ph_views.c`, `pod_render.c`
  scenes `inbox:swarm` and `toast:swarm`

**Interfaces:**
- Produces in `pod_unread_t`: `char tab[ID_MAX], chat_id[ID_MAX];`. A non-empty `tab` marks a Swarm notice whose
  `agent` is the Lead id and whose `name` is the project.
- Produces:
  - `void pod_model_swarm_notice(pod_model_t *, const char *tab, const char *lead, const char *chat_id, const char *text, uint32_t now_ms)`:
    replace by `agent == lead`, move it to the top, and keep the 16 cap.
  - `bool pod_model_swarm_notice_read(pod_model_t *, const char *tab, const char *lead, const char *chat_id)`: drop
    only an entry with that tab, lead and chat_id. Returns true if one was dropped.
  - `pro_app_supertab_notice(tab, lead, chat, chat_id, text)` and `pro_app_supertab_notice_read(tab, lead, chat_id)`.
  - Glue: `bool pod_ui_swarm_notice(pod_ui_t *, const char *tab, const char *lead, const char *chat_id, const char *text, bool awake, uint32_t now_ms)`.
    It is an alert tier: it toasts and returns true when the caller must wake and beep, unless that Lead's view is on
    screen and the glass is lit, in which case it is read at once.
  - `pod_ui_swarm_notice_read(pod_ui_t *, tab, lead, chat_id)` also ends that entry's toast.
- Taps: on a Swarm entry, the toast tap and the Notices row tap open that Lead with `pod_nav_follow_lead` and queue
  `supertab.select` through `sup_push`. They do not open Notices.
- Phase 1 has no Buddy side. A notice with `"chat":"buddy"` is ignored until Task 9.

- [ ] **Step 1: Write the failing tests**
  - `test_pro_cable.c`:
    - `supertab_notice_reaches_app`: `{"t":"supertab.notice","tab":"S1","lead":"L1","chat":"lead","chatId":"c1","id":"n1","text":"Done. Tests pass.","at":1}`
      gives one `EV_STNOTICE` event with those fields.
    - `supertab_notice_read_reaches_app`.
    - `notice_with_bad_ids_ignored`: empty tab, or lead over `ID_MAX`.
  - `test_pod_model.c`:
    - `swarm_notice_replaces_per_lead`;
    - `swarm_notice_cap_16`, shared with agent entries;
    - `notice_read_other_chat_keeps_row`: read with chat `c2` while the entry is `c1`, so the entry stays;
    - `notice_read_before_notice_is_noop`.
  - `test_ph_glue.c`:
    - `swarm_notice_toasts_and_beeps`;
    - `swarm_notice_on_its_lead_view_reads_at_once`;
    - `swarm_toast_tap_opens_lead_and_selects`: the top frame is `POD_V_LEAD` for L1, and `pod_ui_take_supertab`
      yields `supertab.select S1 L1`;
    - `swarm_row_tap_opens_lead_and_selects`;
    - `swarm_notice_read_ends_toast`;
    - `buddy_chat_notice_ignored_in_phase_1`.
  - `test_ph_views.c`:
    - `inbox_swarm_row_name_line`: the name run is `"harness"`, followed by a run `"· openharness"` in `0x6B4FA3`.
    - `toast_swarm_name_line`: `"· openharness"` in `0x8EA3BD`, and the timer bar is drawn.
- [ ] **Step 2: Run** `run.sh` → FAIL.
- [ ] **Step 3: Implement.**
  - The handlers parse with `id_fits` and the cJSON helpers.
  - The Swarm name for the tag is looked up with `pod_model_swarm(m, entry->tab)->name` at draw time. If the Swarm is
    gone, draw no tag.
  - The inbox row's avatar is the Lead's engine pet (`pod_pet_for(lead->engine)`, falling back to the logo as today).
- [ ] **Step 4: Run** `run.sh` → PASS. Run `test/golden.sh` and confirm only the new scenes were added.
- [ ] **Step 5: Commit** `feat(pro): a Swarm chat's new message toasts and waits in Notices`.

### Task 5: Follow the desktop into a Swarm with no project open

**Files:**
- Modify:
  - `cable/pro_cable.c:652-660` (`handle_supertab_focus`)
  - `pod/pod_model.c:874` (`pod_model_supertab_focus` keeps an empty lead)
  - `app/pod_glue.{h,c}` (`pod_ui_t.lead_seen`, `apply_lead_focus`, `sup_sync`)
- Test: `test/test_pro_cable.c`, `test/test_ph_glue.c`

**Interfaces:**
- Produces in `pod_ui_t`: `struct { char swarm[ID_MAX], lead[ID_MAX]; } lead_seen[SWARMS_CARD_MAX];`. It is set in
  `sup_sync` whenever a Lead view is on screen. A new Swarm takes the first free slot, or the oldest when full.
- Rule in `apply_lead_focus`: for an empty `focus_lead`, resolve the lead to `lead_seen` for that Swarm if it is still
  in the Swarm, else `leads[0].id`. A Swarm not in the model waits `POD_FOLLOW_PENDING_MS`, then is dropped. The rest
  of the function is unchanged.

- [ ] **Step 1: Write the failing tests**
  - `test_pro_cable.c`:
    - `focus_empty_lead_reaches_app`: `{"t":"supertab.focus","tab":"S1","lead":""}` gives `EV_STFOCUS` with lead "".
    - A missing `lead` key is treated the same.
    - An empty `tab` is still ignored.
  - `test_ph_glue.c`:
    - `empty_focus_opens_last_lead`: view L2 of S1, go Home, focus S1 with "", so the top frame is L2.
    - `empty_focus_opens_first_without_history`.
    - `empty_focus_last_lead_gone_opens_first`.
    - `empty_focus_unknown_swarm_waits_then_drops`.
    - `empty_focus_respects_quiet_window`: a touch 100 ms ago means no move.
- [ ] **Step 2: Run** `run.sh` → FAIL.
- [ ] **Step 3: Implement** as in the Interfaces block.
- [ ] **Step 4: Run** `run.sh` → PASS.
- [ ] **Step 5: Commit** `fix(pro): follow the desktop into a Swarm whose Chat with PM is open`.

### Task 6: Say `swarmChat v1`; PR 1 verification

**Files:**
- Modify: `cable/pro_cable.c:229` (`send_hello`), `test/test_pro_hello.py:83` (expected keys),
  `devices/harness-pro/docs/cable.md` (the Swarm section: new fields and frames)

- [ ] **Step 1: Write the failing test.** In `test_pro_hello.py`, add `("swarmChat", "v1")` after
  `("swarmCard", "v1")`. Leave `swarmBuddy` and `swarmReview` absent.
- [ ] **Step 2: Run** `python3 devices/harness-pro/firmware/test/test_pro_hello.py` → FAIL.
- [ ] **Step 3: Implement.** Add `msg_string(&root, "swarmChat", "v1");` with a one-line comment naming the frames
  it brings. Update `cable.md`.
- [ ] **Step 4: Verify**
  - `bash test/run.sh` → PASS, `make device-test` → PASS.
  - `idf.py build` in `devices/harness-pro/firmware` with `-DPROJECT_VER=0.0.99` → builds. Record the image size
    against main's.
- [ ] **Step 5: Device check (ask Diego first).** Flash with the repo script and run spec § Testing "On Diego's Pro"
  steps 1–3 and 6. Record `raster_max_us` before and after from the alive line.
- [ ] **Step 6: Commit** `feat(pro): say swarmChat v1`. Open PR 1 when Diego asks: Tasks 1–6 plus the spec, with the
  device numbers in the body.

## PR 2: PM | Buddy (spec § Phase 2)

### Task 7: Parse the Buddy fields and the side; send `supertab.side`

**Files:**
- Modify:
  - `cable/cable_types.h`
  - `cable/pro_cable.c` (`read_leads`, `handle_supertab`, `pro_cable_supertab_send`)
  - `app/pod_glue.h:24` (`pod_supertab_out_t`)
  - `app/pro_app.c` (the drain of `pod_ui_take_supertab`)
- Test: `test/test_pro_cable.c`, `test/test_ph_glue.c`

**Interfaces:**
- Produces in `cable_types.h`:
  ```c
  typedef enum { POD_SIDE_NONE, POD_SIDE_PM, POD_SIDE_BUDDY } pod_side_t;
  typedef struct { char chat_id[ID_MAX], name[49], engine[16]; uint16_t cells; uint32_t color; bool live; } pod_buddy_t;   // color 0xRRGGBB
  // pod_lead_t gains: bool buddies, has_buddy, buddy_unread; pod_buddy_t buddy;
  // pod_swarm_t gains: pod_side_t side;
  ```
- Produces in `pod_supertab_out_t`: `char side[8]`. `t` may be `"supertab.side"`, with `lead` unused and `side`
  `"pm"` or `"buddy"`. `pro_cable_supertab_send(t, tab, lead)` gains the allowed `"supertab.side"`, and a new
  `bool pro_cable_supertab_side(const char *tab, const char *side)` writes `{t, tab, side}`. `pro_app.c` calls it for
  those frames.
- Produces: `bool pod_ui_supertab_side(pod_ui_t *, const char *tab, pod_side_t side)` queues it through `sup_push`.
- Parse rules:
  - `cells` must be an integer in 0..32767, else `has_buddy` is false.
  - `color` must be `#rrggbb`, else `0xC49BFF`.
  - `side` other than "pm"/"buddy" means NONE.

- [ ] **Step 1: Write the failing tests**
  - `supertab_reads_buddy_block`: the spec test's `buddy` object gives the matching fields, with `cells == 25513` and
    `color == 0xD6A79A`.
  - `buddy_bad_cells_dropped`.
  - `buddy_name_cut_on_codepoint`.
  - `supertab_reads_side`.
  - `side_frame_sent`: `pod_ui_supertab_side(u, "S1", POD_SIDE_BUDDY)`, then drain, gives one
    `{"t":"supertab.side","tab":"S1","side":"buddy"}` on the cable stub.
- [ ] **Step 2: Run** `run.sh` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `run.sh` → PASS.
- [ ] **Step 5: Commit** `feat(pro): read each Lead's Buddy and the Swarm's side; send supertab.side`.

### Task 8: The Buddy avatar

**Files:**
- Create: `devices/harness-pro/firmware/main/pod/home/ph_avatar.c`
- Modify: `pod/home/ph.h` (declaration)
- Test: `test/test_ph_views.c`

**Interfaces:**
- Produces: `void ph_buddy_avatar(ht_scene_t *s, int x, int y, int d, uint16_t cells, uint32_t color, unsigned bg)`.
  - It draws a disc of diameter `d` at (x, y), filled with `color` mixed 22 % over `bg` (`ph_mix`), with a 3 px ring
    of `color` at 33 %.
  - The 5 × 5 pattern spans `d * 56 / 100`, centred. Cell `i` is lit when bit `row * 3 + [0,1,2,1,0][col]` of `cells`
    is set (desktop `superTabAgentPattern`). Each lit cell is `ht_pro_rect_aa` with radius `cell / 5`, in `color`.
  - At most 27 runs (disc, ring and 25 cells).

- [ ] **Step 1: Write the failing tests**
  - `avatar_cells_mirror`: `cells` with only bit 0 lights columns 0 and 4 of row 0, so exactly 2 cell rects.
  - `avatar_bit7_centre`: bit 8 lights only row 2 col 2 (bit 7 is row 2, cols 1 and 3).
  - `avatar_parity_with_desktop`: `cells = 25513` (the daemon spec's Buddy) lights exactly the cells of this grid,
    rows top to bottom, which is desktop `superTabAgentPattern`'s mirror of those bits:
    `#...#`, `#.#.#`, `.###.`, `#...#`, `.###.` (13 cell rects).
- [ ] **Step 2: Run** `run.sh` → FAIL (undefined symbol).
- [ ] **Step 3: Implement** with `pod_draw` / `pro_canvas` primitives only, staying under the 4096 B frame cap.
- [ ] **Step 4: Run** `run.sh` → PASS.
- [ ] **Step 5: Commit** `feat(pro): the desktop's agent pattern as the Buddy's avatar`.

### Task 9: PM | Buddy on the Lead view

**Files:**
- Modify:
  - `pod/home/ph_lead.c`: header comment; the pill; header A; `CHAT_CY` 130 under the pill; the Buddy who row; the
    no-Buddy view; the dot
  - `pod/pod_nav.h` (new hit `POD_A_SIDE`)
  - `app/pod_glue.c` (the hit, `talk_target`, the quiet notice, relink)
  - `pod/pod_model.c` (`buddy_unread`)
- Test: `test/test_ph_views.c`, `test/test_ph_glue.c`, `pod_render.c` scenes `lead:pill`, `lead:buddy`,
  `lead:buddy-offline`, `lead:nobuddy` and `lead:buddy-dot`, golden

**Interfaces:**
- Consumes: Task 7 fields, Task 8 `ph_buddy_avatar`, Task 4 notice path.
- Produces: `POD_A_SIDE`, a hit only, with `arg = POD_SIDE_PM | POD_SIDE_BUDDY` and hit id = the Swarm id. The glue
  calls `pod_ui_supertab_side`, clears `buddy_unread` on BUDDY, and sets a pressed segment that holds until the next
  `supertab` frame for that Swarm.
- Geometry (spec § Phase 2):
  - pill 300 × 44 at (210, 16), radius 22, segments 150 wide, `ph_sb_22`;
  - header line at cy 94: the Swarm name `ph_sb_26` `#B79CFF`, " · " muted, project `ph_sb_34` ink, cut at 640 px with
    the project's end last;
  - bubble at y 150 with 7 rows;
  - Buddy who row: avatar d 120 centred in the 150 box at x 16, name `ph_sb_34` lilac, "offline" `ph_sb_22` muted
    when `!buddy.live`;
  - no-Buddy view: a dashed circle d 120 centred at x 360, cy = 150 + 100, "+" in it, "No Buddy here yet"
    `ph_sb_34` muted at cy 364, "Add one in the Harness app." `ph_rg_28` muted at cy 412;
  - dot: 12 px lilac at the Buddy segment's top right (x 454, y 24) with a 3 px track-coloured ring.
- Which screen draws:
  - the Buddy screen when the Lead's `chat == POD_CHAT_BUDDY`;
  - no-Buddy when `buddies && side == POD_SIDE_BUDDY && !has_buddy`;
  - the pill only when `buddies`.
- Quiet notice: in `pod_ui_swarm_notice`, `chat == "buddy"` sets `buddy_unread` on the Lead. No toast, no entry, no
  beep, and it returns false.
- Relink: `pod_model_link(false)` clears every `buddy_unread`.

- [ ] **Step 1: Write the failing tests**
  - `test_ph_views.c`:
    - `pill_absent_without_buddies`: run list equal to Task 3's.
    - `pill_pm_selected`: segment fill `PH_ROOM_INK`.
    - `pill_buddy_selected`: fill `0xC49BFF`.
    - `header_a_one_line`: the project's run is centred at cy 94, and there is no run at cy 42.
    - `chat_name_at_130_under_pill`.
    - `buddy_screen_name_lilac`.
    - `buddy_offline_line`: a text run "offline".
    - `nobuddy_copy`: runs "No Buddy here yet" and "Add one in the Harness app." and no bubble fill.
    - `buddy_dot_drawn`.
  - `test_ph_glue.c`:
    - `pill_tap_sends_side`: a tap at (435, 38) queues `supertab.side S1 buddy`.
    - `pill_tap_never_talks`: an armed talk stays unfired and no `voice.begin`.
    - `pill_pressed_until_frame`.
    - `buddy_notice_sets_dot_only`: no toast, no unread entry, `pod_ui_swarm_notice` returns false.
    - `opening_buddy_clears_dot`.
    - `relink_clears_buddy_dot`.
    - `side_kept_across_swipe`: NEXT to L2 keeps `side`.
- [ ] **Step 2: Run** `run.sh` → FAIL. `golden.sh --check` → exit 1.
- [ ] **Step 3: Implement.** The pill and the who row are drawn by two static functions in `ph_lead.c` to stay under
  the frame cap. The run count must be constant per screen state; `test_ph_views.c` checks it.
- [ ] **Step 4: Run** `run.sh` → PASS. Run `golden.sh`: new scenes are added, `lead:loaded`, `lead:remote`,
  `lead:none` and `lead:ask` are unchanged, and Task 3's scenes are unchanged. Render the five scenes and compare with
  mockup 2A, 3A–3D.
- [ ] **Step 5: Commit** `feat(pro): PM | Buddy on the Lead view`.

### Task 10: Say `swarmBuddy v1`; PR 2 verification

**Files:** `cable/pro_cable.c` (`send_hello`), `test/test_pro_hello.py`, `devices/harness-pro/docs/cable.md`

- [ ] **Step 1:** In `test_pro_hello.py`, add `("swarmBuddy", "v1")` after `swarmChat`. Run it → FAIL.
- [ ] **Step 2:** Add the key to `send_hello` and update `cable.md`. Run → PASS.
- [ ] **Step 3: Verify.** `run.sh`, `make device-test` and `idf.py build` (0.0.99) all pass. Device steps 4 and 6,
  with Diego's yes.
- [ ] **Step 4: Commit** `feat(pro): say swarmBuddy v1`. PR 2 is opened when Diego asks.

## PR 3: voice (spec § Phase 3)

### Task 11: Talk to a remote Lead and to the Buddy

**Files:**
- Modify:
  - `cable/cable_features.{h,c}` (`CABLE_FEATURE_SWARM_REMOTE = 1u << 2`, name `"swarm.remote"`)
  - `app/pod_glue.c` (`talk_target`)
  - `cable/pro_cable.c:935` (after `cable_features_parse`: `pro_app_features(features)`)
  - `pro_app_api.h`, `app/pro_app.c`, `app/pod_glue.h` (`pod_ui_t.swarm_remote`)
  - `pod/home/ph_talk.c` (the name on top and the pet, for the Buddy side)
- Test: `test/test_ph_talk.c`, `test/test_pro_cable.c` (welcome features), `test/test_pro_app.py`

**Interfaces:**
- Produces: `talk_target` returns the following for a Lead view:
  - `l->local` when it is non-empty;
  - else `l->id` when `u->swarm_remote`, set by `void pod_ui_set_swarm_remote(pod_ui_t *, bool on)`. `pro_app` calls
    it from the new `void pro_app_features(uint32_t features)`, which `pro_cable.c` calls with
    `features & CABLE_FEATURE_SWARM_REMOTE` after each welcome. It is cleared on unlink;
  - else NULL, as today.
  - The device never names the side. The daemon's `swarmFaceOf` picks the Buddy chat from the side it holds.
- Pets and name: on the Buddy screen (`chat == POD_CHAT_BUDDY`), the talk view's pet engine is `buddy.engine` and its
  name on top is `buddy.name` in lilac. Otherwise both are as today. The Pro's talk view has no "Sending to" label, so
  none is added; the round's "Sending to your Buddy" maps to the Buddy's name here.

- [ ] **Step 1: Write the failing tests**
  - `welcome_swarm_remote_feature` (`test_pro_cable.c`): a welcome with `"features":["swarm.remote"]` gives an
    `EV_FEATURES` event with the bit set; without it, the bit is clear.
  - `remote_lead_talks_with_swarm_remote`: a tap on a remote Lead's view starts `voice.begin` with
    `agentId == l->id`.
  - `remote_lead_no_talk_without_feature`.
  - `buddy_screen_talks_with_lead_id`: the same id as the PM side.
  - `buddy_talk_uses_buddy_engine_pet`.
  - `buddy_talk_names_buddy`: the name run on top is the Buddy's name, in `0xC49BFF`.
  - `voice_error_ends_buddy_talk`: `{"t":"voice.error","message":"Could not reach your Buddy. Try again."}` ends the
    voice state with that message (the existing path).
- [ ] **Step 2: Run** `run.sh` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** `run.sh`, `make device-test` and `idf.py build` (0.0.99) all pass. Device step 5 with
  Diego's yes, and step 6.
- [ ] **Step 5: Commit** `feat(pro): talk to a Lead on another machine and to your Buddy`. PR 3 is opened when Diego
  asks.
