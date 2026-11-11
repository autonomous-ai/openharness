# Round dial: PM | Buddy pair, bell-only notices, Personal | Team — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the round dial's Swarm face, switch PM/Buddy with a bottom pair, open notices only from the bell (needs-you only), pick Personal | Team from the project name, and drop the "PM" line.

**Architecture:** The backend list read marks the reader's Personal Swarm; the cards service carries it to the `supertab` frame and adds open decisions asked of the reader as Lead notices; the firmware draws the pair and the picker, routes taps, and stops vertical swipes on the Swarm face.

**Tech Stack:** TypeScript (backend, cli, vitest), C (ESP-IDF round dial firmware, host tests via Python harness).

**Spec:** `docs/specs/2026-11-05-dial-lead-pm-buddy-pair.md`

## Global Constraints

- Pair: 180 × 44 px pill at y 388, `#141518` fill, 1 px `#2e3035`, fully rounded; halves "PM" and "Buddy" in Inter 20; current half `#2b2d33` + white, other text `#9a9ca3`. Bell at y 346 when the pair shows.
- Picker: "Swarm" on the top arc; one 200 × 44 px pill at y 211, same style, halves "Personal" and "Team"; 5 s idle returns.
- Working line / "Your Buddy replied" move to one centred line at y 318 when the pair shows; no lower-arc hint, no Buddy side dots.
- Decision notice text: `<asker> asks you: <question>`, cut to `RECAP_BYTES` like tags.
- Capability name: `swarmNeedsYou`. Card field: `personal` (true only). List row field: `personal: true` only on the reader's own Personal Swarm.
- Harness Pro firmware is out of scope; old firmware and old daemons must keep working (see spec Compatibility).

## Review Focus

1. A Lead without Buddies: no pair, the bell keeps y 400, vertical swipe still inert on the Swarm face (Task 4 test "no pair without Buddies").
2. Only the Personal card on the dial (no Team), or no `personal` at all: tapping the name opens PANES as today (Task 5 test "no picker without both").
3. Several Team Swarms: Team opens the last non-Personal card shown, else the first in list order (Task 5 test "team goes to the last shown").
4. A decision open when the dial arrived never alerts; one answered or closed removes its notice (Task 2 tests "baseline" and "closed decision drops its notice").
5. The picker left idle 5 s returns to the same Lead and side, with no frame sent (Task 5 test "idle returns").

---

### Task 1: The list read marks the reader's Personal Swarm

**Files:**
- Modify: `backend/src/superTabs/store.ts` (`list`, ~:1119-1127)
- Test: `backend/integration/superTabRead.test.ts` (or the existing list test there)

**Interfaces:**
- Produces: list rows `{ id, name, ownerId, revision, paused, personal?: true }`.

- [ ] **Step 1: Write the failing test** "the list marks only the reader's own Personal Swarm": owner O has a Personal Swarm P and a Team Swarm T; member M is in T and has their own Personal Swarm PM. `list(O)` gives P `personal: true`, T no `personal`; `list(M)` gives PM `personal: true`, T no `personal` (O's P is not M's).
- [ ] **Step 2: Run** `cd backend && NODE_ENV=test npx vitest run integration/superTabRead.test.ts -t "Personal Swarm"`. Expected: FAIL (no `personal`).
- [ ] **Step 3: Implement** in `list`: add `...(isPersonalSwarm(head) && head.ownerId === user.sub ? { personal: true as const } : {})` to each row (`isPersonalSwarm` from `deletion.ts`; the head carries id/environment/ownerId, or use the row's).
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `npx tsc --noEmit -p .`. Expected: no errors.
- [ ] **Step 5: Commit** `git add backend/src/superTabs/store.ts backend/integration/superTabRead.test.ts && git commit -m "Swarm list: mark the reader's own Personal Swarm"`

### Task 2: Cards carry `personal`; decisions asked of the reader become notices

**Files:**
- Modify: `cli/src/core/api.ts` (`SwarmCard`), `cli/src/superTabs/cards.ts`, `cli/src/cable/cableSession.ts` (supertab frame ~:3001; buddy notices ~:3033; hello capabilities)
- Test: `cli/src/superTabs/cards.spec.ts`, `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Consumes: Task 1's `personal` on list rows.
- Produces: `SwarmCard.personal?: true`; `supertab` frame field `"personal": true`; capability `swarmNeedsYou` read from the dial's hello (`this.swarmNeedsYou: boolean`).

- [ ] **Step 1: Write the failing tests**
  - cards.spec: "a card carries personal from its list row" — list row `personal: true` → card `personal: true`; other card has no `personal`.
  - cards.spec: "an open decision asked of the reader becomes its project Lead's notice" — Swarm read with `decisionsDigest` d0 then d1, `/decisions` answering one open decision asked of the reader (asker "Dee", question "Ship it?") at d1 → that Lead's `notice` with `text` "Dee asks you: Ship it?"; at d0 (baseline) no notice.
  - cards.spec: "closed decision drops its notice" — next digest lists none → the notice goes.
  - cableSession.spec: "supertab frame says personal" — a card with `personal: true` → frame has `personal: true`; none → field absent.
  - cableSession.spec: "a swarmNeedsYou dial gets no Buddy quiet notice" — hello with `swarmNeedsYou` and a Lead with `buddyNotice` → no `supertab.notice` with chat `buddy`; without the capability → sent as today.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/superTabs/cards.spec.ts src/cable/cableSession.spec.ts -t "personal|decision|swarmNeedsYou"`. Expected: FAIL.
- [ ] **Step 3: Implement**
  - `SwarmCard.personal?: true` from the list row in cards.ts where cards are built.
  - Decisions: mirror the tags path (`tagsSeen`/`tagDigests`, `/mentions?state=waiting`) with `decisionsSeen`/`decisionDigests` reading `GET /api/super-tabs/:tabId/decisions` (the person's open decisions; check the route's query in `backend/src/routes/superTabs.ts` `personDecisionQuery`) when `decisionsDigest` moves; the newest new one per project becomes the Lead's `notice` (newest of tag/decision wins).
  - cableSession: add `personal: true` to the supertab frame when set; read `swarmNeedsYou` from hello capabilities; skip pushing `buddyNotice` keys when set.
- [ ] **Step 4: Run** the same command, then `npx vitest run src/cable src/superTabs` and `npx tsc --noEmit -p .`. Expected: all pass, no type errors.
- [ ] **Step 5: Commit** `git add cli/src/core/api.ts cli/src/superTabs/cards.ts cli/src/cable/cableSession.ts cli/src/superTabs/cards.spec.ts cli/src/cable/cableSession.spec.ts && git commit -m "Round dial: cards say Personal; decisions asked of you notify; swarmNeedsYou drops Buddy notices"`

### Task 3: Firmware model — `personal` on a card, `swarmNeedsYou` announced

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/supertab.h` (`ht_supertab_t`: `bool personal`), `supertab.c` if init clears fields, `devices/harness-device/firmware/main/cable_client.c` (`handle_supertab`, hello capabilities)
- Test: `devices/harness-device/firmware/test/test_cable_supertab.py`

**Interfaces:**
- Produces: `ht_supertab_t.personal` (false unless the frame says `"personal": true`); hello capability string `swarmNeedsYou`.

- [ ] **Step 1: Write the failing test** in test_cable_supertab.py: feed a `supertab` frame with `"personal":true` → the stored card's `personal` is true; a frame without it → false; the hello sent includes `swarmNeedsYou`.
- [ ] **Step 2: Run** `cd devices/harness-device/firmware && python3 test/test_cable_supertab.py`. Expected: FAIL.
- [ ] **Step 3: Implement** the field, its parse (`cJSON_IsTrue`), and the capability in the hello list.
- [ ] **Step 4: Run** the same. Expected: PASS.
- [ ] **Step 5: Commit** `git add devices/harness-device/firmware/main/ui/habitat/supertab.h devices/harness-device/firmware/main/ui/habitat/supertab.c devices/harness-device/firmware/main/cable_client.c devices/harness-device/firmware/test/test_cable_supertab.py && git commit -m "Round dial: a card says Personal; the dial announces swarmNeedsYou"`

### Task 4: The PM | Buddy pair, bell-only notices, no "PM" line

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (`render_swarm_face` ~:1534-1632, gesture routing ~:3848-3854, new action kinds near `A_INBOX` ~:108)
- Test: `devices/harness-device/firmware/test/test_touch_ui.py`

**Interfaces:**
- Consumes: `swarm_side_put`, `swarm_side_send`, `swarm_buddy_seen`, `swarm_side_buddy`, `swarm_lead`, `focus_bell`.
- Produces: actions `A_SIDE_PM`, `A_SIDE_BUDDY`; `static void swarm_pair(ht_scene_t *f, bool buddy)`.

- [ ] **Step 1: Write the failing tests** (new `swarm_pair_checks(dir)` called from main, with `buddy_card("lead")` as setup):
  - "pair drawn": `scene_says("PM") && scene_says("Buddy")`, a box run 180 wide at y 388; the bell run at y 346 when a notice is unread.
  - "tap Buddy switches": `tap(t, 278, 410)` → `swarm_side_buddy("s1")` and `wire_has(0, "side s1 buddy")`; `tap(t, 188, 410)` → back to PM.
  - "vertical swipe inert": `swipe_up()` and `swipe_down()` on the face → side unchanged, view not INBOX, no frame sent.
  - "bell opens inbox": with a notice unread, `tap(t, 233, 360)` → view INBOX.
  - "no pair without Buddies": a Lead with `buddies=false` → no "Buddy" run, bell at y 400.
  - "no PM line": a Lead whose chat is `HT_CHAT_PM` with `chat_name` "PM" → `!scene_says("PM")` except the pair's own half (assert the run at the old label y 52-82 is absent).
  - "working line moves": a working Lead with the pair → the "Working…" text run is centred at y 318 and no arc-2 run.
- [ ] **Step 2: Run** `cd devices/harness-device/firmware && python3 test/test_touch_ui.py`. Expected: FAIL at the first new assertion.
- [ ] **Step 3: Implement**
  - In `render_swarm_face`: when `l->buddies`, call `swarm_pair(f, buddy)`, set `bell_y = 346`, skip the lower-arc hint and the side dots, draw the working / "Your Buddy replied" line at y 318; add hits `{{143,388,90,44}, A_SIDE_PM}` and `{{233,388,90,44}, A_SIDE_BUDDY}` before the `A_PET` catch-all.
  - Chat label: also NULL for `HT_CHAT_PM` (`:1567`).
  - Dispatch `A_SIDE_PM`/`A_SIDE_BUDDY`: if it differs from `swarm_side_buddy(sw.tab)`, do what `swarm_side_swipe` did for that direction.
  - Gesture routing (~:3848-3854): on a Swarm surface, a vertical swipe returns without action (remove the `swarm_side_swipe` and the inbox pull for `swarm_mode()`; keep the pull for non-Swarm faces).
- [ ] **Step 4: Run** `python3 test/test_touch_ui.py`, then the whole suite `bash test/run.sh`. Expected: all pass; update existing tests that relied on swipe ↑/↓ on a Swarm face to tap the pair instead (record each in the commit message).
- [ ] **Step 5: Commit** `git add devices/harness-device/firmware/main/ui/habitat/ui_habitat.c devices/harness-device/firmware/test/test_touch_ui.py && git commit -m "Round dial: PM | Buddy pair, bell-only notices, no PM line"`

### Task 5: The Personal | Team picker

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (new view `SWARM_PICK` in `view_t` ~:75-96, `render_swarm_pick`, title tap on the Swarm face ~:1624, dispatch)
- Test: `devices/harness-device/firmware/test/test_touch_ui.py`

**Interfaces:**
- Consumes: Task 3's `ht_supertab_t.personal`; the existing tab pick path (`A_TAB` / `tab_index_of` / `tab_swarm`); `swarm_pair`'s drawing style (reuse a shared `pill2(f, x, y, w, h, left, right, right_on)` helper extracted in this task).
- Produces: view `SWARM_PICK`; actions `A_PICK_PERSONAL`, `A_PICK_TEAM`; `sw.last_team[ID_MAX]` (last non-Personal card shown).

- [ ] **Step 1: Write the failing tests** (`swarm_pick_checks(dir)`):
  - "title opens picker": cards Personal (`personal=true`) and Team; on Team's face `tap(t, 233, 30)` → view `SWARM_PICK`, `scene_says("Swarm") && scene_says("Personal") && scene_says("Team")`, Team half filled.
  - "pick Personal": `tap(t, 183, 233)` → the face shows the Personal card's first Lead and the tab-pick frame was sent as for `A_TAB`.
  - "team goes to the last shown": cards Personal, Team A, Team B; face on B, open picker from Personal, tap Team → B; with no Team shown before → A (list order).
  - "idle returns": open picker, advance `fake_ms` by 5000 → back to the same Lead and side, no frame sent.
  - "no picker without both": only a Personal card, or no card with `personal` → title tap opens PANES (today's `A_AGENTS`).
- [ ] **Step 2: Run** `python3 test/test_touch_ui.py`. Expected: FAIL.
- [ ] **Step 3: Implement** the view, its render (arc title "Swarm", pill at y 211), hits `{{133,211,100,44},A_PICK_PERSONAL}` and `{{233,211,100,44},A_PICK_TEAM}` (the two halves of the 200-wide pill centred at x 233; tests tap 183,233 and 283,233), the 5 s idle via the existing view timer, `sw.last_team` set whenever a non-Personal card's Lead is shown, and the title tap choosing `SWARM_PICK` only when both a Personal and a non-Personal card exist.
- [ ] **Step 4: Run** `python3 test/test_touch_ui.py` then `bash test/run.sh`. Expected: all pass.
- [ ] **Step 5: Commit** `git add devices/harness-device/firmware/main/ui/habitat/ui_habitat.c devices/harness-device/firmware/test/test_touch_ui.py && git commit -m "Round dial: Personal | Team picker from the project name"`

### Task 6: Spec, portraits, final check

**Files:**
- Modify: `docs/specs/2026-11-05-dial-lead-pm-buddy-pair.md` only if the implementation ruled differently (note each ruling).

- [ ] **Step 1:** Render portraits `HABITAT_PREVIEW_DIR=<scratch> python3 test/test_touch_ui.py` and compare the pair, bell, picker and thread faces against `devices/harness-device/mockup/round-swarm-v2/lead-v4.html`.
- [ ] **Step 2:** Run `cd backend && npx tsc --noEmit -p . && NODE_ENV=test npx vitest run integration/superTabRead.test.ts`, `cd cli && npx tsc --noEmit -p . && npx vitest run src/cable src/superTabs`, `cd devices/harness-device/firmware && bash test/run.sh`. Expected: all green.
- [ ] **Step 3: Commit** any spec rulings with the message "Spec: rulings from the dial pair build".
