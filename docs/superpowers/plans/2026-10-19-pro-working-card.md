# Harness Pro "Working" Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A card on Pro Home, after Notices and before the tab cards, that gathers every working agent. It shows three working pets a page; swiping the pet row shows more, and tapping a pet opens that agent. The card is gone when nothing works.

**Architecture:**
- **Pages.** Home's page order becomes Notices, Working, then the tabs. The TABS frame's `scroll` holds a fixed sentinel per special card (Notices −2, Working −1), so a card coming or going never moves the person to another tab. Every page computation goes through one ordered page list.
- **Card.** `ph_overview.c` draws the card. Each pet slot is a `POD_A_FOLLOW` hit.
- **Gestures.** `pod_glue.c` routes a horizontal swipe that starts inside the pet row to a new `pod_nav_t.work_page`; swipes elsewhere still page cards.

**Tech Stack:** C11 firmware (ESP32-P4), host tests with cc, golden screens.

**Spec:** the owner-approved mockup, option D: `devices/harness-pro/mockup/pro-home-working/layout.html` (`layout_d.*`, built by `mock_layout.py opt_d`). The decisions are restated here:
- **Title and count:** "Working" at the top left, and the count of working agents plain at the top right (no badge, no subtitle).
- **Pets:** three a page, compact (ink about 128 px high), each with its agent name and elapsed time only (no task line, no "+N", no page dots).
- **Colour:** a pseudo-random pick among the working agents' engines, using that engine's tab-card gradient. It is stable while the set of working agents stays the same.
- **Swipe:** a horizontal swipe on the pet row pages the pets.
- **Tap:** tapping a pet opens its agent.
- **Order:** the most recently started turn first.
- **Visibility:** the card exists only while at least one agent works.

All paths are relative to `devices/harness-pro/firmware/`.

## Global Constraints

**Layout** (all in card coordinates; the card is 540×560 at (90, 56) with radius 48, `CARD_*` in `ph_overview.c`)
- **Title:** "Working" in `ph_sb_48`, vertical centre at y 80, x 44.
- **Count:** working agents in `ph_bd_84` (closer to the mockup's bold count than `ph_sb_48`; its digits are baked), right-aligned at x 496, centre y 80.
- **Pet slots:** 3 slots with centres at x 105, 270 and 435.
- **Pets:** feet at y 384, ink no taller than 128 px, drawn in the agent's work scene (`ph_work_scene(a)`).
- **Name:** `ph_sb_22` in `PH_CARD_INK`, centred, top at y 422, cut with "…" to 158 px (`ph_sb_26` cut "firmware-pro").
- **Time:** `ph_sb_22` in `PH_PILL_WORK`, from `pod_fmt_elapsed(…, pod_agent_secs(a, now))`, top at y 456.

**Colour**
- The card uses the engine gradient through the same mapping as tab cards. `tint()` is split into `engine_tint(const char *engine, unsigned *c1, unsigned *c2)` and its tab use.
- The pick is `fnv1a32` over the working agents' ids in model order, mod the number of working agents. The chosen agent's engine sets the colour.

**Data and gestures**
- The working set is `pod_model_eff(m, a) == POD_WORKING`, over every agent in the model.
- Order is the newest turn first: `pod_agent_secs(a, now)` ascending; ties keep model order (`since_ms` is only when the device first saw the agent working, so it ties after a relink).
- **The pet band** is screen y 256–536 (card y 200–480), the same rows as the pet hits.
  - A horizontal swipe that starts in the band on the Working card with more than 3 working agents changes `work_page` by ±1, clamped to `0..pages-1`, and never pages cards.
  - Any other swipe pages cards as today.
- `work_page` resets to 0 whenever the Working card is not the shown page.

**Process**
- No new fonts, heap or PSRAM.
- Render-task stack frames stay at 4 KB or less (`run.sh` caps).
- Every other Home screen must not change.

## Review Focus

1. **The working set changes while the card shows.**
   - An agent finishes on page 2 so that page 2 becomes empty. Expected: `work_page` clamps to the last page.
   - All agents finish. Expected: Home settles on tab 0, or on Notices when there are no tabs; never on a blank page.
   - Tests in Tasks 1 and 3.
2. **The working count is exactly 3, or a multiple of 3.** Expected: no empty trailing page, so a swipe past the last page does nothing. Test in Task 3.
3. **A tapped pet whose agent left the model between draw and tap.** Expected: nothing opens; `FOLLOW`'s id resolution returns −1, and the screen redraws. Test in Task 3.
4. **Notices, Working and tabs appearing and disappearing in every combination** (none, only Notices, only Working, both, no tabs). Expected: paging moves one page per swipe, in order, and the person's tab never jumps. Test in Task 1.
5. **A working agent whose engine has no pet** (for example Cursor). Expected: its 72 px logo, via `ph_card_art`'s fallback, in the slot with name and time. Test in Task 2.

---

### Task 1: The Home page list (Notices −2, Working −1, tabs 0..n−1)

**Files:**
- Modify:
  - `main/pod/pod_view.h` and `.c`: `pod_tabs_pages_of`, `pod_scroll_max`, and a new `pod_home_pages`.
  - `main/pod/pod_nav.c:27-35` (`home_lo`, `home_clamp`), `:245` (the `POD_A_SCROLL` lower bound) and `:313` (the `sync` clamp).
  - `main/pod/home/ph_overview.c`: the `HOME_*` enum, `home_at` and the neighbour logic in `ph_view_home`.
  - `main/app/pod_glue.c:453-460`: Home paging uses the page list.
- Test: `test/test_pod_nav.c`.

**Interfaces:**
- Produces:
  - `int pod_home_pages(const pod_model_t *m, int16_t *out, int cap)`: the present pages in order (−2 if `pod_notice_count > 0`, −1 if any agent works, then 0..tab_count−1), and returns how many.
  - `int pod_home_working(const pod_model_t *m)`: the number of working agents.
  - `enum { POD_HOME_NOTICES = -2, POD_HOME_WORKING = -1 }` in `pod_view.h`.
  - `home_clamp(m, s)`: if `s` is a present page it is kept. Otherwise it moves to the nearest present page to its right (so a vanished Working or Notices lands on tab 0). If nothing is to the right, it takes the nearest to the left.

- [ ] **Step 1: Write failing tests in `test/test_pod_nav.c`**

```c
// pages: with notices and working agents -> {-2,-1,0,1}; working only -> {-1,0,1}; notices only -> {-2,0,1}; neither -> {0,1}
CHECK(pages(m_both) == "{-2,-1,0,1}"); ...
// clamp: scroll -1 when nobody works -> 0; scroll -2 when no notices -> -1 if working else 0
// paging: from -2 one swipe left -> -1, again -> 0 (helper drives pod_ui_touch or POD_A_SCROLL through the glue's page step)
// a Working page whose agents all finish while shown: after pod_nav_sync, scroll == 0
```

(Write these with the file's existing model-building helpers. `pages()` formats the out array.)

- [ ] **Step 2: Run** `bash test/run.sh`. Expected: compile failure (`pod_home_pages` undefined).
- [ ] **Step 3: Implement** the page list. Every place that assumed "−1 is Notices", or computed `lead = pages − tab_count`, now walks the `pod_home_pages` array; find each with `grep -n "notice_count\|HOME_NOTICES\|lead" main`.
- [ ] **Step 4: Run** `bash test/run.sh && bash test/golden.sh --check`. Expected: pass, with golden unchanged, because no fixture has a Working card yet.
- [ ] **Step 5: Commit**: `feat(pro): Home page list with a slot for a Working card`

---

### Task 2: Draw the Working card

**Files:**
- Modify:
  - `main/pod/home/ph_overview.c`: the new `working_card()`, `engine_tint()` split out of `tint()`, and `ph_view_home` drawing the card and its neighbour peeks.
  - `main/pod/home/ph.h`: declare the helpers tests need.
  - `main/pod/pod_nav.h`: `uint8_t work_page;` in `pod_nav_t`.
- Test: `test/test_ph_views.c`; `test/pod_render.c` gains a `tabs:working` screen (Home with scroll −1); golden is re-recorded.

**Interfaces:**
- Consumes: `pod_home_pages`, `pod_home_working`, `POD_HOME_WORKING` (Task 1).
- Produces:
  - `int ph_working_list(const pod_model_t *m, const pod_agent_t **out, int cap)`: working agents ordered by `since_ms` descending.
  - `void ph_working_tint(const pod_model_t *m, unsigned *c1, unsigned *c2)`.
  - `static void working_card(pod_out_frame_t *f, const pod_nav_t *nav, const pod_model_t *m, int x, int y, int w, int h, int r, int fade, bool full, uint32_t now_ms)`: as a neighbour (`full` false) it draws only the faded gradient and "Working", like a tab peek.
  - Hits: for each shown pet, `pod_hit_add_id(f, slot_x, card_y+200, 150, 280, POD_A_FOLLOW, agent_index, agent_id)`.
  - `ph_home_moves()` returns true on the Working page.

- [ ] **Step 1: Write failing tests in `test/test_ph_views.c`**

```c
// 5 working agents (since_ms 10,50,30,40,20) -> order ids by since desc: 50,40,30 on page 0; 20,10 on page 1
// hits on page 0: exactly 3 POD_A_FOLLOW hits, args = those agents' indices, ids set; on page 1: 2
// tint: same working set -> same colour across calls and frames; c1/c2 equal engine_tint(chosen agent's engine)
// a working Cursor agent (no pet) draws its logo in its slot (a POD_CELL/logo run inside the slot rect)
// no working agent -> pod_home_pages has no -1 and ph_view_home at scroll -1 draws tab 0
// ph_home_moves true on the Working page
```

- [ ] **Step 2: Run** `bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement** the card to the Global Constraints layout.
  - Draw pets with `ph_card_art()`, sizing the square so the ink is no taller than 128 px; use `pod_pet_ink_h` to put the feet at y 384.
  - Under each pet draw a shadow ellipse 0.8 × ink width wide and 14 px tall, in `ph_mix(0x000000, c2, 60)`.
- [ ] **Step 4: Render and compare** with the mockup: `python3 test/pod_render.py tabs:working`, then open `test/out/pod/tabs-working.png` beside `../mockup/pro-home-working/layout_d.png`. Positions should be within a few px.
- [ ] **Step 5: Re-record golden** with `test/golden.sh`, then `PRO_FONT=fonts/LiberationSans-Regular.ttf test/golden.sh`. The only new or changed screens are `tabs:working` and the screens whose fixture now has the card as a neighbour peek; list them in the commit message. Then run `bash test/run.sh`.
- [ ] **Step 6: Commit**: `feat(pro): the Working card on Home`

---

### Task 3: Swipe the pet row, tap a pet

**Files:**
- Modify: `main/app/pod_glue.c`: the swipe branch near `:453` and the band test.
- Test: `test/test_ph_glue.c`.

**Interfaces:**
- Consumes: `pod_nav_t.work_page`, `ph_working_list`, `POD_HOME_WORKING`.
- Produces: no new API.

- [ ] **Step 1: Write failing tests in `test/test_ph_glue.c`**

```c
// Home on Working, 5 working: swipe left starting at (360, 430) -> work_page 1, Home scroll unchanged (-1)
// again -> stays 1 (no page 2); swipe right -> 0
// swipe left starting at (360, 150) (title area) -> Home scroll moves to 0 (the next card), work_page reset 0
// exactly 3 working: swipe left in the band -> work_page stays 0 and cards do not page
// tap at slot 0's centre -> POD_FX_AGENT_OPEN for that agent; the nav top is that agent's frame
// tap after that agent was removed from the model (pod_model_agents_begin/end without it) -> nothing opens, changed=true
// on page 1, an agent finishes so 3 remain -> after the next draw work_page == 0
// after opening an agent from the card, POD_A_BACK (or the swipe up home) returns to Home on scroll -1 (the Working card), not a tab;
//   if pod_nav_follow rebuilds the stack onto the agent's tab today, make FOLLOW from Home push over the TABS frame instead
```

- [ ] **Step 2: Run** `bash test/run.sh`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
  - In the Home swipe branch: if the top frame is TABS at `POD_HOME_WORKING`, `pod_home_working(m) > 3` and `start_y` is within 316..536, step `work_page`.
  - Clamp `work_page` against `ceil(n/3)−1` both where it is stepped and before drawing.
  - Reset it whenever the shown page is not Working.
  - `POD_A_FOLLOW` hits already resolve by id (`pod_glue.c:481`). Verify the vanished-agent path returns −1 and draws.
- [ ] **Step 4: Run** `bash test/run.sh`. Expected: pass.
- [ ] **Step 5: Commit**: `feat(pro): swipe the Working card's pets, tap one to open it`

---

### Task 4: Device check

- [ ] **Step 1:** `idf.py -B build-pod -DPROJECT_VER=0.0.99-pod build`, then report the `harness_pro.bin` size.
- [ ] **Step 2:** Flash with `FLASH_PORT=<port> bash scripts/flash.sh --build-dir build-pod`. Then on the device:
  - With two or more agents working, Home shows the card after Notices.
  - Swipe the pets.
  - Tap one; its room opens.
  - Back returns to the Working card.
  - When all agents finish, the card disappears.
- [ ] **Step 3:** The owner checks it on the device, then offer the commit, PR and merge per `AGENTS.md`.
