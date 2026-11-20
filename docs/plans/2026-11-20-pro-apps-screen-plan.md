# Harness Pro: the Tabs | Apps pill, the Apps screen and other apps' rooms (item C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(pro): <the task's message> (red)` once its failing tests have been run and seen to fail, then `feat(pro): <the task's message>`. No task pushes or merges.

**Goal:** The Pro's Home gets a Tabs | Apps pill and app cards; a tap on a card sends one `app.pick` and opens that app's first agent when its ring lands; a room of an agent without `v` says "See it in <App>".

**Architecture:**
- **Pages** (`main/pod/pod_view.*`): Home's list is the tabs or the app cards (`pod_home_apps`); app pages are `POD_HOME_APP0 + k`; the page helpers take the nav.
- **Navigation** (`main/pod/pod_nav.*`): the pill's two actions, `POD_A_PICK_APP` → `POD_FX_APP_PICK`, and app ring frames (`tab = POD_TAB_APP`, `tab_id` = the app id) that every reader of a frame's tab branches on.
- **Drawing** (`main/pod/home/ph_overview.c`): the pill, and the tab card's body drawn from one card description that the app card fills too.
- **Glue** (`main/app/pod_glue.*`): the landing (wait up to 5 s for the ring), the `apps` feed and the no-`v` tap. **App layer** (`main/app/pro_app.c`, item B's file): the effect's case, and the feeds routed through the glue (open question 1).

**Tech Stack:** C11 firmware (ESP-IDF 5.5.4, ESP32-P4), host tests in C and Python (`test/run.sh`).

**Spec:** `docs/plans/2026-11-20-pro-apps-screen-design.md`. Read it with this plan, the split doc's section 3 (`docs/plans/2026-11-20-pro-parity-split.md`, committed by the main session), the root `AGENTS.md` and `devices/harness-pro/README.md`.

**Open questions:** three, in "Open questions" below. The tasks they touch follow the recommended answer until the PM answers.

## Base

- Branch `feat/pro-apps-screen` at `3daf515733` (= `origin/main`, 2026-11-20), worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/pro-C-apps-screen`. No commits yet. The spec and this plan are untracked: the main session commits them; no task does.
- **Code waits** (PM decision 6) until item B's `pod_model.h` and item E's `main/pod/app_icons.{c,h}` are both on `origin/main`. Task 1 rebases onto that main. No task stubs their headers.
- Every path below is under `devices/harness-pro/firmware/` unless it starts with `docs/`.
- Item B's and E's names are the split doc's section 3 (and item B's design names its extra setters: `pod_model_apps`, `pod_model_apps_switch`, `pod_model_view`, `pod_model_agent_app`, `POD_CAPS_ALL`, `pod_host_see_it`). **Task 1's rename list wins**: each implementer uses the names it reports and says so.
- Names at the base in this item's files (tasks name functions, never lines): `pod_view.c` `pod_home_working`, `pod_home_has`, `pod_home_pages`, `pod_home_clamp`, `pod_tabs_pages_of`; `pod_view.h` `POD_HOME_NOTICES`, `POD_HOME_WORKING`, `POD_HOME_PAGES_MAX`, `pod_hit_t`, `pod_out_frame_t` (`hits[32]`); `pod_nav.c` `tab_list`, `frame_list`, `land_on_tab`, `step`, `nav_act`, `index_in`, `pod_nav_sync`, `pod_nav_follow`, `pod_nav_follow_tab`; `pod_nav.h` `POD_TAB_RECENT`, `pod_frame_t`, `pod_nav_t`, `pod_action_t` (last `POD_A_ENTER_TAB`), `pod_effect_t`, `pod_out_t`; `ph_overview.c` `home_at`, `HOME_NONE`, `ph_home_moves`, `tint`, `shown_name`, `pill`, `slot_logo`, `st_of`, `card`, `peek`, `ph_view_home`, `wordmark`, the layout enum (`CARD_X` … `ICONS_MAX`, `LABEL_GAP`); `pod_glue.c` `synced`, `apply_pending_focus`, `follow_now`, `talk_fire`, `pod_ui_touch` (the hit-id resolution chain, the Home swipe), `pod_ui_link`, `pod_ui_roster`, `pod_ui_notice`; `pod_glue.h` `pod_roster_row_t`, `pod_ui_t`; `pro_app.c` `perform`, `settle`, `voice_begin_effect`, `pro_app_voice_block_reason`. Test helpers: `test_pod_nav.c` `fresh`, `fresh_still`, `to_agent`, `act`, `top`, `pages`; `test_ph_views.c` `fresh`, `text_run`, `text_prefix`, `nth_hit`, `hits_of`, `K_*`; `test_ph_glue.c` `fresh`, `render`, `tap_`, `t_`, `swipe`, `find`, `top`; `test_pro_app.py` `setup`, `render`, `hit`, `tap`, `tap_at`, `contact`, `drag`, `swipe_next`, `swipe_prev`, `tap_stale_talk`, `tap_talk`, `R`, the `tests[]` table.
- Build facts: `pod_nav.c` and `pod_glue.c` (and `pro_app.c` in `test_pro_app.py`) compile with `-Wframe-larger-than=1024`, `pod_view.c` and `home/*.c` with 4096; every `.c` in `main/pod` (so `app_icons.c`) is compiled by `run.sh`, `golden.sh`, `test_pro_app.py` and `pod_render.py`. `test_pro_app.py` builds `pro_app.c` with `-Wall -Werror`, so a new `pod_effect_t` value without its case in `perform` breaks the suite.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 Rebase, confirm B's and E's names | none | B and E on `origin/main` | medium | none: no code, no commit |
| 2 Home's list knows the apps | `pod_view.h/.c`, `pod_nav.h/.c`, `ph_overview.c` (calls + guard), `pod_glue.c` (calls), `test_pod_nav.c`, `test_ph_views.c` (one call) | 1 | high | `test_pod_nav.c` |
| 3 The pick asks the Mac | `pod_nav.h/.c`, `pro_app.c` (`perform` case), `test_pod_nav.c`, `test_pro_app.py` | 2 | high | `test_pod_nav.c`, `test_pro_app.py` |
| 4 The app's ring in the nav | `pod_nav.h/.c`, `test_pod_nav.c` | 3 | high | `test_pod_nav.c` |
| 5 The pill drawn | `ph_overview.c`, `ph.h`, `test_ph_views.c` | 2 | high | `test_ph_views.c` |
| 6 The app card drawn | `ph_overview.c`, `ph.h`, `test_ph_views.c` | 3, 5 | high | `test_ph_views.c` |
| 7 A tap without `v` says where to see it | `pod_glue.h/.c`, `test_ph_glue.c`; `pod_model.h/.c` and `pro_app.c` only as Task 1 says | 2, 3 | high | `test_ph_glue.c` |
| 8 The pick waits for the ring | `pod_glue.h/.c`, `test_ph_glue.c` | 4, 6, 7 | xhigh | `test_ph_glue.c` |
| 9 New screens: renders, goldens, perf | `pod_render.c` (`.py` if needed), `golden.sh`, `golden.txt`, `golden-liberation.txt`, `test_ph_perf.sh`, `ph_perf_baseline.txt` | 4, 6, 7 | high | none: test tooling and baselines, one commit |
| 10 Click-through; the app layer's feeds go through the glue | `pro_app.c` (open question 1), `test_pro_app.py` | 8 (through it 3, 4, 6, 7) | high | `test_pro_app.py` |

Longest chain: six tasks (1 → 2 → 3 → 4 → 8 → 10, and 1 → 2 → 5 → 6 → 8 → 10). Tasks 3 and 5 start together after 2; 4, 6 and 7 run side by side; 9 runs beside 8.

Not changed, and a diff in any is a finding: `main/cable/*`, `main/pod/app_icons.*`, `scripts/gen_app_icons.py`, `main/CMakeLists.txt`, `test/test_pod_model.c`, `test/test_pro_cable.c`, `test/test_pro_hello.py`, anything under `cli/`.

## Global Constraints

- Firmware only. Only the files of the table; `pro_app.c` only as Tasks 3, 7 and 10 say; `pod_model.*` only the helper (Task 7, if Task 1 finds none).
- Copy, exactly: `Tabs`, `Apps`, `agent` / `agents`, `N working`, `N asking`, `See it in <App>` (`<App>` = `pod_host_name(host)`). An app card never shows `All done`. Nothing else new on screen.
- The pill: 252 x 46, radius 23, centred (x 234), top y 640; outer `PH_BORDER`, inner `PH_GROUND` inset 2 px; the filled cell inset 4 px, radius 19, `PH_TRACK`; labels `ph_sb_22`, `PH_INK` on the filled cell, `PH_MUTED` on the other. Hits: x 180..360 (`POD_A_HOME_TABS`) and 360..540 (`POD_A_HOME_APPS`), y 624..720. Five runs and two hits in every state; none without another app.
- The app card: the tab card's 540 x 560 at (90, 56); gradient `card_top` → `card_bottom` of `pod_app_style(id)` widened to 0xRRGGBB, else `PH_RAISED` → `PH_GROUND`; `icon72` as one image run, 44 px in from the card's right edge, its top on the name's line (y 96).
- `POD_HOME_APP0` = 32; `POD_TAB_APP` = -3. App cards are indices into `m->apps` (`uint8_t`), never copies of rows.
- One `app.pick` per tap; the landing sends no `agent.open`; the wait ends after 5000 ms.
- Budgets: every Home state within `HT_RUNS` (192) runs, counting the glue's 2-run notice pill, and 32 hits.
- Every existing golden hash stays the same (both fonts). No new log lines.
- No string `harness-device` in any non-`.md` file under `devices/harness-pro` (`test_tree_isolation.py`).
- Tests use synthetic times, no sleeps. Comments say why.
- Hardware: never flash, never `idf.py flash` or `monitor`, never `esptool` or `scripts/flash.sh`, never open a serial port. The Pro's power latch bricks it on a wrong image. Compile only.

## Review Focus

1. **The app under a card goes between the draw and the tap** (an `apps` frame drops it). Expected: nothing is sent, no wait starts, Home redraws on the nearest card. Task 8, `picked_app_gone_before_the_tap`.
2. **The link drops while waiting or inside an app's room.** Expected: the wait ends, the room closes to Home, and the ring arriving after the next link-up opens nothing. Task 8, `link_drop_ends_the_wait_and_the_ring`.
3. **A long or non-Latin app name beside the icon.** Expected: cut between whole letters with an ellipsis, never under the icon; letters `ph_sb_48` lacks fall to `ph_sb_34`. Task 6, the long-name and Vietnamese-name cases.
4. **The full app list (16 apps) with the Notices and Working cards.** Expected: 18 pages, the last card reachable and in budget. Task 2 `nav_test_home_sixteen_apps`, Task 6 the last-card budget case.
5. **The window opens or closes while in an app's room** (`has_window` flips, the pill comes and goes). Expected: the room stays; up from the bottom edge lands on that app's card in the list Home shows then. Task 4 `nav_test_app_room_survives_window_change`.

## Decided here, where the spec was silent

- Everything drawn stays in `ph_overview.c` (about 600 lines after Task 6): the pill is ~30 lines and the app card reuses the tab card's body. No `ph_apps.c`.
- `pod_app_agents` and the new page helpers live in `pod_view.c`, beside `pod_home_working`.
- The pill's cells are (252 − 8) / 2 = 122 x 38 at x 238 and x 360, y 644; labels centred on x 299 and x 421, y 663.
- The app card's name ends where the icon starts less `LABEL_GAP` (16 px): 364 px wide from x 134. Without an icon it has the tab card's full `NAME_W`.
- `POD_A_PICK_APP` acts only on Home (the TABS frame at depth 1). A pick of `harness` never opens a room and starts no wait.
- The wait ends on any new contact's DOWN, on `pod_ui_link(false)`, on an `apps` frame whose `shown` is anything but the app picked (an empty `shown` included), on a host focus that lands, and when `clock_ms - landing_ms >= 5000` (a ring at +4999 ms lands, at +5000 it does not).
- In `talk_fire` the no-`v` line is checked before the offline line (item B's gate puts it before every other per-agent reason).
- A popped app frame that leaves Home on top lands Home on that app's card (as `land_on_tab` does); the existing Home clamp at the top of `pod_nav_sync` is not moved.
- `home_at` reads a TAB frame's own tab only when it is a tab index (>= 0), else Home's page: that covers `POD_TAB_APP` without naming it in the drawing.
- From Task 2 until Task 6 an app page draws no card (Task 2's guard keeps `m->tabs` from being read with a page that is not a tab). No golden screen shows that state; Task 6 draws the card.
- `POD_HOME_PAGES_MAX` stays `POD_TABS_MAX + 2` (26 ≥ 16 apps + 2). The id `harness` is one constant, `POD_APP_HARNESS`, in `pod_view.h` (B's, if B has one).
- Under open question 1, the roster rows carry `caps_off` (the letters withheld), not `caps`, so a zero-filled row means "all allowed", as item B's cable row does.

## Decided by the PM (2026-11-20, with the plan's go: each recommendation below)

1. **`pro_app.c` beyond decision 2.** Item B's design feeds `apps`, `apps.switch`, each agent's `host`/`caps` and the `agents.end` view straight into the model, the last two after `pod_ui_roster` has already run its nav sync. Then the nav never syncs on an `apps` frame, the landing and "the app kept by id" wait for the next unrelated feed, and a pending host focus lands in Recent instead of the app's ring. **Recommended:** Task 10 edits `pro_app_apps`, `pro_app_apps_switch` and `pro_app_agents` so each change goes through the glue (`pod_ui_apps`, `pod_ui_apps_switch`, `host`/`caps_off` in the roster rows, the view set before the roster) and removes B's direct calls. Moot if Task 1 finds B already does this.
2. **How long "See it in <App>" shows.** This spec: the notice line's own 3 s. Item B's brief and design: 2 s, as the round dial, set in B's gate. **Recommended:** 2 s on both paths, one constant `POD_SEE_IT_MS` (2000) in `pod_glue.h` that B's gate uses too (Task 7).
3. **Home when the window comes back** (no window → a window, e.g. after a pick of Harness). The spec fixes the selected tab for a tap on Tabs and for the last other app going, not for this. **Recommended:** the selected tab here too (one rule: whenever Home's list turns from apps to tabs it lands on the selected tab, else the first tab). Task 2 `nav_test_home_window_returns`.

---

### Task 1: Rebase, and confirm item B's and E's names

**Files:** none. **Depends on:** item B's `pod_model.h` and item E's `app_icons.{c,h}` on `origin/main`. **Effort:** medium. No test, no commit.

- [ ] **Step 1: Rebase.** `git -C /Users/duynguyen/orca/workspaces/autonomous-harness/pro-C-apps-screen fetch origin main`, then `git -C /Users/duynguyen/orca/workspaces/autonomous-harness/pro-C-apps-screen rebase origin/main`. Expected: a fast-forward; the spec and plan stay untracked.
- [ ] **Step 2: Confirm the split doc's section 3** in `main/pod/pod_model.h`, `main/cable/pro_cable.h`, `main/pod/app_icons.h`: `POD_APPS_MAX` (16); `pod_app_t {id[16], name[24], count, waiting, working}`; `m->apps`, `app_count`, `app_shown[16]`, `apps_switch`, `machine_view`, `has_window`; `pod_agent_t.host[16]`, `.caps`, `POD_CAP_S/V/F/A`; `pod_host_name`; `pro_cable_send_app_pick(const char *) -> bool`; `pod_app_icon_t {rgb565, alpha, size}`, `pod_app_style_t {icon72, icon44, card_top, card_bottom}`, `pod_app_style(id)`.
- [ ] **Step 3: Read the facts later tasks need:**
  - (a) B's setters and constants: names and signatures of the apps, apps-switch, view and per-agent host/caps setters; `POD_CAPS_ALL`; a `harness` constant if any; that `has_window` is true when the last `swarms` listed a tab even if the model keeps none (PM decision 7).
  - (b) Whether a "See it in <App>" helper exists beside `pod_host_name` (B's design: `pod_host_see_it`, a literal), whether `pro_app_voice_block_reason` returns it, and the notice time B's gate sets.
  - (c) Whether `pro_app_apps`, `pro_app_apps_switch` and `pro_app_agents` run the glue's nav sync after B's setters, with hosts set before it (open question 1).
  - (d) `perform`'s cases in `pro_app.c`; in `test_pro_app.py`, B's wire helpers for `apps` and agent rows and whether a `pro_cable_send_app_pick` fake exists.
  - (e) Item E: `rgb565` in native order (as `ht_pro_image` wants); which ids have a style (expect `codex`, `vscode`); one id the daemon can list that has none (for `apps:noicon`); `pod_app_style("harness") == NULL`.
- [ ] **Step 4: The gates at the new base.** `bash devices/harness-pro/firmware/test/run.sh` → exit 0; from `devices/harness-pro/firmware`: `bash test/golden.sh --check` and `PRO_FONT=fonts/LiberationSans-Regular.ttf bash test/golden.sh --check` → `golden: <N> screens match` (record N). Any red at the base: stop and report; it is not this item's to fix.
- [ ] **Step 5: Report:** the base SHA, the rename list (split doc name → name on main, or "none"), facts (a)–(e), N and the gate results. Every later task follows it.

---

### Task 2: Home's list knows the apps

**Files:**
- Modify: `main/pod/pod_view.h`, `main/pod/pod_view.c`; `main/pod/pod_nav.h`, `main/pod/pod_nav.c` (`nav_act`: `POD_A_SCROLL` on Home and the two new actions; `pod_nav_sync`'s Home block; `pod_nav_follow_tab`'s Home branch)
- Modify, calls and guard only: `main/pod/home/ph_overview.c` (`home_at`, `ph_view_home`, `peek`, `ph_home_moves`: the page helpers gain the nav; no `m->tabs` read for a page `>= m->tab_count`); `main/app/pod_glue.c` (the Home swipe's two calls in `pod_ui_touch`)
- Test: `test/test_pod_nav.c`; `test/test_ph_views.c` (its one `pod_home_has` call gains `&N`)

**Depends on:** 1. **Effort:** high.

**Interfaces — Produces:**
```c
// pod_view.h
enum { POD_HOME_NOTICES = -2, POD_HOME_WORKING = -1, POD_HOME_APP0 = 32, POD_HOME_PAGES_MAX = POD_TABS_MAX + 2 };
#define POD_APP_HARNESS "harness"
bool pod_home_switch(const pod_model_t *);   // the pill: has_window && apps_switch && an app row with count > 0 and id != harness
int  pod_home_app_cards(const pod_model_t *, uint8_t *out, int cap);   // indices into m->apps, daemon order, count > 0, minus harness while the pill shows; returns how many (out may be NULL)
bool pod_home_apps(const pod_nav_t *, const pod_model_t *);   // no window: any app card; with the pill: nav->home_apps; else false
int  pod_app_agents(const pod_model_t *, const char *app_id, const pod_agent_t *out[], int max);   // roster order, host == app_id, 0 unless app_id is m->app_shown
bool pod_home_has(const pod_nav_t *, const pod_model_t *, int page);
int  pod_home_pages(const pod_nav_t *, const pod_model_t *, int16_t *out, int cap);   // Notices, Working, then tabs 0..n-1 or POD_HOME_APP0 + k
int  pod_home_clamp(const pod_nav_t *, const pod_model_t *, int scroll);              // today's rule over that list
// pod_nav.h
pod_nav_t      += bool home_apps;   // the pill's Apps cell is chosen; cleared when the pill goes
                  char home_app[16];   // the app card under the person, by id ("" none); the size of pod_app_t.id
pod_action_t   += POD_A_HOME_TABS, POD_A_HOME_APPS   // after POD_A_ENTER_TAB; device-local, no effect
```
- `POD_A_HOME_APPS` (Home, depth 1, pill shown, not already Apps): `home_apps`, scroll `POD_HOME_APP0`, `home_app` = the first card's id. `POD_A_HOME_TABS` (Apps chosen): `!home_apps`, scroll = `m->selected` when `< tab_count`, else the clamp of tab 0; `home_app` "". Anything else: nothing.
- `POD_A_SCROLL` on Home sets `home_app` to the id of the page it lands on ("" for a page that is not a card).
- `pod_nav_sync` (Home block): the pill gone → `home_apps` false; Home listing apps → the card is re-found by `home_app` (scroll = `POD_HOME_APP0 + k`), else clamped; Home listing tabs with a scroll `>= POD_HOME_APP0` → the selected tab (open question 3), else the clamp of tab 0; then `home_app` follows the page.
- `pod_nav_follow_tab` does nothing to Home while Home lists apps. `pod_tabs_pages_of` returns `pod_home_pages(nav, m, NULL, 0)`.

- [ ] **Step 1: Write the failing tests** in `test_pod_nav.c`. Fixtures: `fresh_apps()` = `fresh()`, apps-switch on, apps `{harness "Harness" 4/1/1, codex "ChatGPT" 2/0/1, vscode "VS Code" 3/1/0}` (count/waiting/working), shown `harness`; `no_window()` = swarms with no tabs and the view `machine` with no tab. `pages()` passes `&N`.
  - `nav_test_home_switch`: `fresh_apps` → `pod_home_switch` true; apps-switch off → false; on again, `no_window` → false; window back, codex and vscode at count 0 → false.
  - `nav_test_home_app_cards`: `fresh_apps` → `{1, 2}`; `no_window` → `{0, 1, 2}`; vscode count 0 → `{0, 1}`.
  - `nav_test_home_pages_with_apps`: `fresh_apps` (a1 works, a4 asks) → `"{-2,-1,0,1}"`; `act(POD_A_HOME_APPS)` → `"{-2,-1,32,33}"`; `no_window` + sync → `"{-2,-1,32,33,34}"` and `!N.home_apps`; then an empty apps list → `"{-2,-1}"`.
  - `nav_test_home_tabs_apps_cells`: `fresh_apps`, `M.selected = 1`; HOME_APPS → fx NONE, `home_apps`, scroll 32, `home_app` "codex"; HOME_APPS again → unchanged; HOME_TABS → `!home_apps`, scroll 1, `home_app` ""; HOME_TABS again → unchanged; `M.selected = M.tab_count`, HOME_APPS then HOME_TABS → scroll 0; apps-switch off → HOME_APPS leaves `home_apps` false; from a room (`to_agent(0, 0)`) HOME_APPS changes nothing.
  - `nav_test_home_app_kept_by_id`: HOME_APPS, `act(POD_A_SCROLL, 1)` → scroll 33, `home_app` "vscode"; apps reordered `{vscode, harness, codex}` + sync → scroll 32, "vscode"; apps `{harness, vscode}` (codex gone) + sync → scroll 32, "vscode". From `fresh_apps` on vscode (33) again: apps `{harness, codex, cursor}` + sync (vscode gone, cursor at its place) → scroll 33, "cursor".
  - `nav_test_home_pill_goes`: HOME_APPS, `M.selected = 1`; apps `{harness}` + sync → `!home_apps`, scroll 1; apps back + sync → the pill shows, Home lists tabs, scroll 1.
  - `nav_test_home_window_returns` (open question 3): `no_window`, Home on 33; swarms back with `"s2"` selected and the view's tab set + sync → Home lists tabs, scroll 1.
  - `nav_test_follow_tab_leaves_apps`: HOME_APPS, `M.selected = 1` → `pod_nav_follow_tab` false, scroll 32.
  - `nav_test_app_agents`: a2 and a3 host codex, a4 host vscode, shown codex → `pod_app_agents(codex)` = `[a2, a3]`; shown harness → 0 (a stale host is not the ring); codex never lists a4.
  - `nav_test_home_sixteen_apps`: `no_window`, sixteen rows `app0`…`app15` at count 1 → 18 pages ending in 47; `act(POD_A_SCROLL, …)` to 47 is kept.
- [ ] **Step 2: Run, expect FAIL.** `bash devices/harness-pro/firmware/test/run.sh` → FAIL to compile `test_pod_nav` (`pod_home_switch` undeclared, `pod_home_pages` arity).
- [ ] **Step 3: Commit red:** `test(pro): Home's list knows the apps (red)` (only `test_pod_nav.c`).
- [ ] **Step 4: Implement** the Interfaces above; update the callers in `ph_overview.c`, `pod_glue.c` and `test_ph_views.c`; add the guard in `ph_overview.c`. `_Static_assert(POD_HOME_APP0 >= POD_TABS_MAX, …)`.
- [ ] **Step 5: Run, expect PASS.** `run.sh` exit 0; `golden.sh --check` (both fonts, as Task 1 Step 4) → N match.
- [ ] **Step 6: Commit:** `feat(pro): Home's list knows the apps`.

---

### Task 3: The pick asks the Mac

**Files:** Modify `main/pod/pod_nav.h`, `main/pod/pod_nav.c` (`nav_act`), `main/app/pro_app.c` (`perform`: the `POD_FX_APP_PICK` case only). Test: `test/test_pod_nav.c`, `test/test_pro_app.py` (a `pro_cable_send_app_pick` recorder and one replay).
**Depends on:** 2. **Effort:** high.

**Interfaces — Produces:** `POD_A_PICK_APP` (after `POD_A_HOME_APPS`; arg: the index into `m->apps` at draw time; the hit's id: the app id). `POD_FX_APP_PICK` (after `POD_FX_AGENT_OPEN`; the app id in `pod_out_t.agent`). `nav_act`: on Home (TABS, depth 1) with `arg` a row of count > 0 → `POD_FX_APP_PICK` with its id, the stack unchanged; else nothing. `perform`: `pro_cable_send_app_pick(o->agent)` (after the lock, as every effect).

- [ ] **Step 1: Write the failing tests.**
  - `test_pod_nav.c` `nav_test_pick_app`: `fresh_apps`, HOME_APPS; `act(POD_A_PICK_APP, 1)` → fx `POD_FX_APP_PICK`, agent "codex", depth 1, scroll 32; arg 7 → NONE; row 1 at count 0 → NONE; from a room → NONE, depth 3.
  - `test_pro_app.py` `app_pick_reaches_the_cable` (in `tests[]`): `setup()`, apps-switch on, the three apps rows (B's wire entry, per Task 1); `render()`; inject the hit `{90, 56, 540, 560, POD_A_PICK_APP, 1, "codex"}` as `tap_stale_talk` injects its own; `tap(POD_A_PICK_APP, 1)` → `R.picks == 1`, `R.pick_app` "codex", `R.opens == 0`, `top() == POD_V_TABS`. The recorder checks `LOCK_DEPTH == 0`.
- [ ] **Step 2: Run, expect FAIL.** `run.sh` → `test_pod_nav` fails to compile (`POD_A_PICK_APP` undeclared); `PRO_APP_TEST=app_pick_reaches_the_cable python3 devices/harness-pro/firmware/test/test_pro_app.py` → same.
- [ ] **Step 3: Commit red:** `test(pro): the pick asks the Mac (red)`.
- [ ] **Step 4: Implement** as above; in `test_pro_app.py` the fake `pro_cable_send_app_pick` (records `R.picks`, `R.pick_app`) and the replay. Add the fake only if Task 1 found none.
- [ ] **Step 5: Run, expect PASS** (`run.sh` exit 0).
- [ ] **Step 6: Commit:** `feat(pro): the pick asks the Mac`.

---

### Task 4: The app's ring in the nav

**Files:** Modify `main/pod/pod_nav.h`, `main/pod/pod_nav.c` (`frame_list`, `pod_nav_sync`, `land_on_tab`, `nav_act`'s `POD_A_OPEN_NOTIF` and `POD_A_PICK_APP`, `pod_nav_follow`, a new list chooser, `pod_nav_open_app`). Test: `test/test_pod_nav.c`.
**Depends on:** 3. **Effort:** high.

**Interfaces — Produces:**
```c
enum { POD_TAB_RECENT = -1, POD_TAB_APP = -3 };   // -2 is POD_HOME_NOTICES in home_at
// Home on the app's card (home_app = id, home_apps = pod_home_switch(m), scroll = POD_HOME_APP0 + k), then TAB (POD_TAB_APP, tab_id = id)
// and the room of the app's first agent (pod_app_agents[0]; opens on its recap by the usual rule). No effect. False, stack untouched,
// when the app is not m->app_shown, has no agents, or TALK is on top.
bool pod_nav_open_app(pod_nav_t *, pod_model_t *, const char *app_id);
```
- `frame_list` of a `POD_TAB_APP` frame is `pod_app_agents(m, f->tab_id, …)` (no keep-alive: a room whose agent leaves the ring closes). `step` wraps through it and emits `AGENT_OPEN` as today.
- `pod_nav_sync` never looks a `POD_TAB_APP` frame up in `m->tabs`; the agent check alone keeps it. When the pops leave Home on top and the frame popped was an app frame, Home lands on that app's card while it is listed (`home_apps` when the pill shows), else today's clamp.
- `land_on_tab` from an app frame: Home lists apps (`home_apps` when the pill shows) on that app's card by id; not listed: the clamp.
- One chooser, used by `pod_nav_follow`, `POD_A_OPEN_NOTIF` and (through `pod_nav_follow`) `POD_A_FOLLOW`: the selected tab when it holds the agent, else the first tab that does, else `POD_TAB_APP` with `m->app_shown` when the agent is one of the shown app's agents, else Recent.
- `POD_A_PICK_APP`: after the effect, when the id is not `harness`, is `m->app_shown` and has agents → `pod_nav_open_app` (the room opens at once; the effect stays `POD_FX_APP_PICK`, no `AGENT_OPEN`).

- [ ] **Step 1: Write the failing tests.** Fixture `ring()`: `fresh_apps()` plus roster agents a5 "Thread one" and a6 "Thread two" (engine codex, host codex, a6 caps S|F), apps shown codex.
  - `nav_test_follow_into_app_ring`: `pod_nav_follow(a5)` → depth 3; `stack[1]` TAB with tab `POD_TAB_APP`, `tab_id` "codex"; top a5 with tab `POD_TAB_APP`; `pod_nav_list` = `[a5, a6]`.
  - `nav_test_app_ring_wraps`: NEXT → `AGENT_OPEN` a6; NEXT → `AGENT_OPEN` a5; PREV → a6.
  - `nav_test_stale_host_outside_ring`: shown vscode → `pod_nav_follow(a5)` lands with tab `POD_TAB_RECENT`.
  - `nav_test_app_room_up_to_its_card`: in a5's room `act(POD_A_TABS)` → depth 1, `home_apps`, scroll 32, `home_app` "codex". Again after `no_window()`: `!home_apps`, scroll 33 (harness is card 0), "codex".
  - `nav_test_app_ring_goes`: in a5's room (opened from Home on tab 0), shown harness + sync → depth 1, scroll 32, `home_apps`. Again with a5 and a6 leaving the roster → depth 1 on the codex card. Again with shown harness and codex dropped from the rows → depth 1, `!home_apps`, scroll 0 (Home's page by today's clamp).
  - `nav_test_app_room_survives_window_change`: in a5's room, `no_window()` + sync → depth 3 on a5; swarms back + sync → depth 3; `act(POD_A_TABS)` → `home_apps`, the codex card.
  - `nav_test_one_list_choice`: an unread entry for a5 → INBOX, `OPEN_NOTIF 0` → tab `POD_TAB_APP`; a5 working, Home on the Working card, `POD_A_FOLLOW` a5 → `POD_TAB_APP`; a1 in both tabs with `"s2"` selected → `OPEN_NOTIF` of a1 lands in tab 1.
  - `nav_test_pick_shown_app_opens`: `ring()`, HOME_APPS; `act(POD_A_PICK_APP, 1)` → `POD_FX_APP_PICK` "codex", depth 3, top a5, `stack[1].tab == POD_TAB_APP`, Home still on 32. `pod_nav_open_app(…, "vscode")` → false. `no_window()`, shown harness with a1 host harness: PICK of row 0 → depth 1. With TALK on top `pod_nav_open_app(…, "codex")` → false, depth unchanged.
- [ ] **Step 2: Run, expect FAIL** (`run.sh`: `POD_TAB_APP` undeclared).
- [ ] **Step 3: Commit red:** `test(pro): the app's ring in the nav (red)`.
- [ ] **Step 4: Implement** as above. Lists stay `const pod_agent_t *[POD_AGENTS_MAX]` (the 1 KB frame cap).
- [ ] **Step 5: Run, expect PASS** (`run.sh` exit 0; the existing nav, glue and app replays unchanged).
- [ ] **Step 6: Commit:** `feat(pro): the app's ring in the nav`.

---

### Task 5: The pill drawn

**Files:** Modify `main/pod/home/ph_overview.c` (`ph_view_home`, a new static `home_pill`), `main/pod/home/ph.h` (`ph_view_home`'s comment). Test: `test/test_ph_views.c`.
**Depends on:** 2. **Effort:** high.

`ph_view_home` draws the pill after every Home page (cards, Notices, Working, and the wordmark) when `pod_home_switch(m)`, with the filled cell from `pod_home_apps(nav, m)`, and adds the two hits (arg 0, no id). Geometry: Global Constraints and "Decided here".

- [ ] **Step 1: Write the failing tests**, a block "Home's Tabs | Apps pill" on a two-tab model with apps-switch on and the apps rows of Task 2:
  - No other app (only the harness row): `S.count` and `F.hit_count` equal the same model's with apps-switch off; `hits_of(POD_A_HOME_TABS) == 0`, `hits_of(POD_A_HOME_APPS) == 0`; no text run "Tabs" or "Apps".
  - With another app, on tab 0: `S.count` = that base + 5. Runs: `K_RECT_AA {234, 640, 252, 46}` radius 23 `PH_BORDER`; `K_RECT_AA {236, 642, 248, 42}` radius 21 `PH_GROUND`; `K_RECT_AA {238, 644, 122, 38}` radius 19 `PH_TRACK`; "Tabs" in `PH_INK` centred on x 299 (± 2); "Apps" in `PH_MUTED` centred on x 421. Hits: `POD_A_HOME_TABS {180, 624, 180, 96}`, `POD_A_HOME_APPS {360, 624, 180, 96}`.
  - After `POD_A_HOME_APPS`: the cell at x 360, "Apps" `PH_INK`, "Tabs" `PH_MUTED`; still exactly those two pill hits.
  - On the Notices card and on the Working card: the pill's five runs and two hits.
  - Over the wordmark: nobody working or asking, swarms listing one tab that holds no agent (no tab kept, a window), codex row → background `0x0E1B2C`, five runs more than the wordmark alone, two hits.
  - `no_window`: no pill runs, no pill hits.
  - Each: `ph_runs(&F) <= HT_RUNS`.
- [ ] **Step 2: Run, expect FAIL** (`run.sh`: `test_ph_views` aborts at the first pill check).
- [ ] **Step 3: Commit red:** `test(pro): the pill drawn (red)`.
- [ ] **Step 4: Implement** `home_pill` (two fills for the edge: the canvas's stroke is 1 px) and its call.
- [ ] **Step 5: Run, expect PASS** (`run.sh`; `golden.sh --check` both fonts → N match: no golden model has another app).
- [ ] **Step 6: Commit:** `feat(pro): the pill drawn`.

---

### Task 6: The app card drawn

**Files:** Modify `main/pod/home/ph_overview.c` (a static card description; `card`, `tint`'s caller, `peek`, `ph_view_home`, `ph_home_moves`, `home_at`), `main/pod/home/ph.h` (Home's comments). Test: `test/test_ph_views.c`.
**Depends on:** 3 (`POD_A_PICK_APP`), 5 (same files). **Effort:** high.

**Interfaces — Produces:** the card hit `POD_A_PICK_APP {90, 56, 540, 560}`, arg = the index into `m->apps`, id = the app id; one per app card (every card has count > 0).
- A static description (name, `c1`/`c2` as 0xRRGGBB, count, working, asking, whether "All done" may show, the agents behind the marks row and their count, the 72 px icon or NULL). `card` draws only from it; the tab card fills it as today (so every tab card's pixels stay the same); the app card fills it from its `m->apps` row and `pod_app_style(id)` (`card_top`/`card_bottom` widened from RGB565: `r8 = r5 << 3 | r5 >> 2`, `g8 = g6 << 2 | g6 >> 4`), never "All done", marks only when the app is `m->app_shown` (`pod_app_agents`; "+N" counts what the Pro holds).
- The icon: one image run of `icon72` at (card x + 424, card y + 40); the name to its left, `LABEL_GAP` short of it. A neighbour app card: its gradient and name, no icon.
- `ph_home_moves` on an app page: its row's `working > 0 || waiting > 0`. `home_at`: a TAB frame's tab only when `>= 0`, else Home's page.

- [ ] **Step 1: Write the failing tests**, a block "App cards": Apps chosen, rows `{harness, codex "ChatGPT" 2/0/1, vscode "VS Code" 3/1/1}`, shown codex, a5 (working) and a6 (idle) host codex.
  - The codex card (a style): the card's gradient run at (90, 56, 540, 560) carries exactly `card_top` and `card_bottom`; one `K_IMAGE` run at (514, 96), 72 x 72, whose pixels are `icon72->rgb565`; "ChatGPT" at x 134 with `x + w <= 498`; "2", "agents", "1 working"; no "asking" pill; no run starting "\xe2\x9c\x93"; two mark logos and two state dots; exactly one `POD_A_PICK_APP` hit, arg 1, id "codex".
  - The vscode card (not shown): "1 working", "1 asking", no "All done", no image run and no state dot in the marks band (screen y 504..594).
  - An app with no style (Task 1's id): the gradient `PH_RAISED` → `PH_GROUND`, no `K_IMAGE` run, the name run's width up to `NAME_W` (452).
  - Long and non-Latin names next to the icon (Review Focus 3): a 40-letter name ends in "\xe2\x80\xa6" with `x + w <= 498`; "Ứng dụng" draws in `ph_sb_34`.
  - The pill shown: no Harness card; `no_window`: cards harness, codex, vscode, no pill, the Harness card on `PH_RAISED` → `PH_GROUND`.
  - Neighbours: on the codex card, vscode's name peeks on the right in `ph_sb_34`; no image run outside the main card.
  - `ph_home_moves`: true on codex (working 1) and on a row with only waiting; false on a row with 0/0.
  - Budget, worst case: the codex card with its icon and seven of its agents (4 marks and "+3"), the Notices card peeking left, vscode right, the pill → `ph_runs(&F) + 2 <= HT_RUNS` (the glue's notice pill) and `F.hit_count <= 32`; print `runs home-app-worst %d`. The same on the 16th card of sixteen apps (Review Focus 4).
- [ ] **Step 2: Run, expect FAIL** (`run.sh`: `test_ph_views` aborts: no gradient on an app page).
- [ ] **Step 3: Commit red:** `test(pro): the app card drawn (red)`.
- [ ] **Step 4: Implement** as above; Task 2's guard becomes the app branch.
- [ ] **Step 5: Run, expect PASS.** `run.sh` exit 0; `golden.sh --check` both fonts → N match (every tab card unchanged).
- [ ] **Step 6: Commit:** `feat(pro): the app card drawn`.

---

### Task 7: A tap without `v` says where to see it

**Files:** Modify `main/app/pod_glue.c` (`talk_fire`), `main/app/pod_glue.h` (`POD_SEE_IT_MS`, open question 2). Test: `test/test_ph_glue.c`. Only as Task 1 found: `main/pod/pod_model.h/.c` (add `const char *pod_host_see_it(const char *host)` beside `pod_host_name`, a literal from the same table, valid after any unlock, when B has no such helper) and `main/app/pro_app.c` (B's gate returns that helper and shows it for `POD_SEE_IT_MS`, when it does not already).
**Depends on:** 2 (`pod_glue.c`), 3 (`pro_app.c`). **Effort:** high.

`talk_fire`, before the offline line: an agent whose `caps` lacks `POD_CAP_V` gets `pod_host_see_it(host)` on the notice line for `POD_SEE_IT_MS`, and no effect (no Talk frame, no `voice.begin`). The room draws as today.

- [ ] **Step 1: Write the failing tests** in `test_ph_glue.c`:
  - `no_voice_tap_says_where`: `fresh()`; a2 gets host codex and caps S|F; `to_agent(0, 1)`, `render(1000)`, `tap_(MID_X, MID_Y, 1000)` → fx NONE, `top()->view == POD_V_AGENT`, `U.notice` "See it in ChatGPT", `U.notice_on`, `U.notice_until == 1050 + POD_SEE_IT_MS`.
  - `no_voice_before_offline`: the same agent also `POD_OFFLINE` → the notice is "See it in ChatGPT".
  - `all_caps_still_talk`: a2 with all caps (and a library agent never given caps) → `POD_FX_VOICE_BEGIN`.
- [ ] **Step 2: Run, expect FAIL** (`run.sh`: `test_ph_glue` aborts: a VOICE_BEGIN where none was expected).
- [ ] **Step 3: Commit red:** `test(pro): a tap without v says where to see it (red)`.
- [ ] **Step 4: Implement** as above (and the helper / gate line only if Task 1 said so; B's existing `test_pro_app.py` gate case must stay green).
- [ ] **Step 5: Run, expect PASS** (`run.sh` exit 0).
- [ ] **Step 6: Commit:** `feat(pro): a tap without v says where to see it`.

---

### Task 8: The pick waits for the ring

**Files:** Modify `main/app/pod_glue.h`, `main/app/pod_glue.c` (`pod_ui_t`, `synced`, `pod_ui_link`, `pod_ui_roster`, `follow_now`, `pod_ui_touch`: the DOWN and the hit-id chain). Test: `test/test_ph_glue.c`.
**Depends on:** 4 (`pod_nav_open_app`), 6 (the drawn card and pill hits), 7 (same files). **Effort:** xhigh (feed order against the wait, a timeout, five ways to end it).

**Interfaces — Produces:**
```c
#define POD_LANDING_MS 5000
pod_ui_t          += char landing[16]; uint32_t landing_ms;   // the app picked whose ring is awaited ("" none); sized as pod_app_t.id
pod_roster_row_t  += const char *host; uint8_t caps_off;      // the app the agent lives in (NULL: ""); the letters withheld (0: all four)
pod_out_t pod_ui_apps(pod_ui_t *, const pod_app_t *rows, int n, const char *shown, uint32_t now_ms);   // clock, model, ends the wait on another shown, nav sync
pod_out_t pod_ui_apps_switch(pod_ui_t *, bool on);                                                     // model, nav sync
```
- `pod_ui_roster` sets each row's host and caps (`POD_CAPS_ALL & ~caps_off`) before its nav sync.
- `pod_ui_touch`: a `POD_A_PICK_APP` hit is resolved by id against `m->apps` (count > 0; gone: redraw, nothing), as tabs are. After the nav returns `POD_FX_APP_PICK` with the stack still at depth 1 and an id other than `harness`: `landing` = the id, `landing_ms` = now. Any new contact's DOWN clears `landing`.
- `synced`, after the pending focus: `landing` set and `clock_ms - landing_ms >= POD_LANDING_MS` → cleared; else the app is `m->app_shown` with agents → `pod_nav_open_app`, dirty, cleared. `pod_ui_link(false)` and a focus that lands (`follow_now`) clear it.

- [ ] **Step 1: Write the failing tests** in `test_ph_glue.c`. Fixture `fresh_apps()`: `fresh()`, `pod_ui_apps_switch(&U, true)`, `pod_ui_apps(&U, APPS3, 3, "harness", 0)` (the rows of Task 2). Taps go to the rendered hits (`find`).
  - `pill_taps_flip_lists`: tap the Apps cell → `home_apps`, scroll 32; tap it again → unchanged; tap Tabs → the selected tab; a sideways swipe from (500, 660) to (300, 665) pages Home and leaves `home_apps` as it was.
  - `pick_waits_for_the_ring`: on the codex card, tap at 2000 → `POD_FX_APP_PICK` "codex", depth 1, `landing` "codex"; `pod_ui_apps(shown codex, 2100)` → depth 1; `pod_ui_roster` with a5, a6 host codex → depth 3, top a5 with tab `POD_TAB_APP`, `landing` "", fx NONE. Again with the roster first (shown harness) and the `apps` frame second → the room opens on the `apps` feed.
  - `ring_and_its_focus`: (a) the ring lands, then `pod_ui_focus(a5)` → still a5's room, tab `POD_TAB_APP`; (b) `pod_ui_focus(a6)` before a6 is on the roster (pending), then the ring 900 ms after the tap's lift (`pod_ui_apps(shown codex)` at that time, then the roster) → a6's room with tab `POD_TAB_APP`, `landing` "", no effect returned.
  - `pick_of_shown_app_opens_at_once`: shown codex with a5, a6 → the tap returns `POD_FX_APP_PICK` and depth 3 at once, `landing` "".
  - `landing_ends`: from a pick whose tap lifts at t0, each alone: a DOWN at t0 + 100; `pod_ui_link(false)`; `pod_ui_apps(shown vscode)`; `pod_ui_focus(a1, t0 + 900)` landing in Build; each → `landing` "" and the ring arriving next opens nothing. Time: the ring's hosts on the roster first (shown still harness), then `pod_ui_apps(shown codex, t0 + 5000)` → depth 1 on the codex card; at `t0 + 4999` → the room.
  - `pick_of_harness_waits_for_nothing`: `no_window`, the Harness card → `POD_FX_APP_PICK` "harness", `landing` "", depth 1; swarms with tabs → Home lists tabs.
  - `picked_app_gone_before_the_tap` (Review Focus 1): render the codex card, `pod_ui_apps` without codex, tap the old hit → fx NONE, `*changed`, `landing` "".
  - `link_drop_ends_the_wait_and_the_ring` (Review Focus 2): a pick, `pod_ui_link(false)`, `pod_ui_link(true)`, the ring → depth 1. In a5's room, `pod_ui_link(false)` → depth 1.
  - `roster_rows_carry_host_and_caps`: a row with host codex and `caps_off = POD_CAP_V` → the model's agent has host codex and no `POD_CAP_V`; a zero-filled row → host "", `POD_CAPS_ALL`.
  - `apps_switch_off_turns_home_to_tabs`: Apps chosen, `pod_ui_apps_switch(&U, false)` → `!home_apps`, the selected tab, in that call.
- [ ] **Step 2: Run, expect FAIL** (`run.sh`: `pod_ui_apps` undeclared).
- [ ] **Step 3: Commit red:** `test(pro): the pick waits for the ring (red)`.
- [ ] **Step 4: Implement** as above. No row copies on the stack (1 KB cap).
- [ ] **Step 5: Run, expect PASS** (`run.sh` exit 0).
- [ ] **Step 6: Commit:** `feat(pro): the pick waits for the ring`.

---

### Task 9: New screens: renders, goldens and perf baselines

**Files:** Modify `test/pod_render.c`, `test/golden.sh`, `test/golden.txt`, `test/golden-liberation.txt`, `test/test_ph_perf.sh`, `test/ph_perf_baseline.txt`; `test/pod_render.py` only if a screen needs it.
**Depends on:** 4 (the ring for `agent:chatgpt:seeit`), 6, 7. **Effort:** high. No red test (tooling and baselines): one commit.

- [ ] **Step 1: Screens in `pod_render.c`**, parsed before the generic `tabs` branch; their apps, hosts and extra agents are added only for these screens (the demo every existing screen draws is unchanged):
  - `tabs:switch`: the demo's window, apps-switch on, rows harness, codex "ChatGPT", vscode "VS Code"; Home on tab 0, the pill on Tabs.
  - `apps`: the same, shown codex with two demo agents host codex; the Apps cell, on the ChatGPT card (icon, marks), VS Code peeking.
  - `apps:noicon`: Apps on the card of Task 1's id with no style.
  - `apps:nowindow`: no tabs, the view `machine`, rows with harness; app cards, no pill.
  - `agent:chatgpt:seeit`: a ChatGPT thread (engine codex, host codex, caps S|F) opened in the codex ring (`pod_nav_follow`), with the notice pill this tool already repeats, its text `pod_host_see_it("codex")`.
  - The `--spec` action names gain `HOME_TABS`, `HOME_APPS`, `PICK_APP`.
- [ ] **Step 2: PNGs for the PR.** `python3 devices/harness-pro/firmware/test/pod_render.py tabs:switch apps apps:noicon apps:nowindow agent:chatgpt:seeit` → five PNGs under `test/out/pod/` (gitignored). Look at each (Verification says what they show).
- [ ] **Step 3: The old hashes still match** before the list grows: `golden.sh --check` both fonts → N match.
- [ ] **Step 4: Goldens.** Add the five screens to `screens` in `golden.sh`; run `golden.sh` and `PRO_FONT=fonts/LiberationSans-Regular.ttf bash test/golden.sh` (from `devices/harness-pro/firmware`). `git diff test/golden.txt test/golden-liberation.txt` shows only 25 added lines each, no line removed or changed; `--check` both → N + 25 match.
- [ ] **Step 5: Perf.** Add `apps` and `tabs:switch` to `screens` in `test_ph_perf.sh`; `PH_PERF_RECORD=1 bash devices/harness-pro/firmware/test/test_ph_perf.sh` on this Mac; their baselines are 1.25 x the measured, under a dated comment as the file's other entries; `PH_PERF=1 bash …/test_ph_perf.sh` → every screen within 85 %.
- [ ] **Step 6: Run** `run.sh` (exit 0), then **commit:** `test(pro): renders, goldens and perf baselines for the Apps screens`.

---

### Task 10: Click-through; the app layer's feeds go through the glue

**Files:** Modify `main/app/pro_app.c` (`pro_app_apps`, `pro_app_apps_switch`, `pro_app_agents`; open question 1). Test: `test/test_pro_app.py`.
**Depends on:** 8 (and through it 3, 4, 6, 7). **Effort:** high.

Under open question 1: `pro_app_apps` → `settle(pod_ui_apps(&s_pod, rows, n, shown, ms()))`; `pro_app_apps_switch` → `settle(pod_ui_apps_switch(&s_pod, on))`; `pro_app_agents` fills each `pod_roster_row_t`'s `host` and `caps_off` from its cable row, sets the view before `settle(pod_ui_roster(…))`, and drops B's per-row host/caps calls (one way to set them).

- [ ] **Step 1: Write the failing replays** (in `tests[]`), fed through the wire entries as a daemon would (B's helpers, per Task 1):
  - `apps_click_through`: a window with two tabs, apps-switch, rows harness, codex, vscode (shown harness); `render()` → the pill with Tabs filled (`hit(POD_A_HOME_TABS, 0)`, "Tabs" in `PH_INK`) → `tap(POD_A_HOME_APPS, 0)` → Home on the ChatGPT card → `swipe_next()` → the VS Code card → `swipe_prev()` → ChatGPT → `tap(POD_A_PICK_APP, 1)` → `R.picks == 1`, `R.pick_app` "codex", Home → the daemon's answer: `apps` shown codex, then agents a5, a6 host codex → a5's room, `R.opens == 0` → `swipe_next()` → a6, `R.opens == 1` "a6" → `swipe_next()` → a5 → `drag(360, 700, 360, 560, 8)` → Home on the ChatGPT card, `U.nav.home_apps` → `tap(POD_A_HOME_TABS, 0)` → the tabs, on the selected tab. Never a second `app.pick`.
  - `apps_without_a_window`: `agents.end` with view `machine` and no tab, no tabs, the rows → `POD_A_PICK_APP` hits, no pill hits, no "Tabs" run.
  - `no_other_app_no_pill`: only the harness row → no pill hits; the frame's runs and hits equal those with no `apps` frame at all.
  - `no_voice_room_says_where`: a ChatGPT thread (host codex, caps "sf") in its room → `tap_talk()` → `R.begins == 0`, `U.notice` "See it in ChatGPT".
- [ ] **Step 2: Run, expect FAIL.** `python3 devices/harness-pro/firmware/test/test_pro_app.py` → `apps_click_through` fails: the room does not open on the ring's frames (no nav sync on them).
- [ ] **Step 3: Commit red:** `test(pro): click through the Apps screen (red)`.
- [ ] **Step 4: Implement** the three functions as above.
- [ ] **Step 5: Run, expect PASS.** `run.sh` exit 0 (B's wire replays included).
- [ ] **Step 6: Commit:** `feat(pro): the app layer's feeds go through the glue`.

---

## Verification

All on this Mac, against host builds only: no board, no daemon, no account, no network. Nothing touches a real Pro.

- **Host suite:** `bash devices/harness-pro/firmware/test/run.sh` → exit 0, with the default font and again with `PRO_FONT=devices/harness-pro/firmware/fonts/LiberationSans-Regular.ttf` (as PR CI). Then `python3 devices/harness-pro/firmware/test/test_tree_isolation.py` and `test_fonts.py` → pass.
- **Goldens:** from `devices/harness-pro/firmware`, `bash test/golden.sh --check` and `PRO_FONT=fonts/LiberationSans-Regular.ttf bash test/golden.sh --check` → `golden: <N + 25> screens match`; the PR shows the golden diffs as additions only.
- **Perf:** `PH_PERF=1 bash devices/harness-pro/firmware/test/test_ph_perf.sh` → every screen, `apps` and `tabs:switch` included, within 85 % of its baseline.
- **Compile only:** `. ~/esp/esp-idf-5.5.4/export.sh && cd devices/harness-pro/firmware && idf.py -B build -DPROJECT_VER=0.0.99-pod build` → exit 0; record `harness_pro.bin`'s size against `ota_0` in the PR. Never `flash`, `monitor`, `esptool` or `flash.sh`.
- **Screens for the PR:** `python3 devices/harness-pro/firmware/test/pod_render.py tabs:switch apps apps:noicon apps:nowindow agent:chatgpt:seeit` → `test/out/pod/*.png` (720 x 720). A person sees: a tab card with the Tabs | Apps pill under it, Tabs filled; the ChatGPT card in its own colour, its icon top right, "2 agents", "1 working", its agents' marks, VS Code peeking, Apps filled; a dark card with the name only; app cards with no pill; a ChatGPT thread's room with "See it in ChatGPT" on the notice line.
- **GitHub:** PR CI runs `firmware-checks` (`run.sh` with Liberation, tree isolation, fonts), `pro-firmware-build` (the real ESP-IDF build and the `ota_0` fit) and `pro-golden` (macOS, Liberation). No temporary workflow: every check here is a host test or a compile, and PR CI already covers the long ones.
- **On a Pro:** not in this item. After the merges of A, B, C and E, the PM asks Diego to try it on his own Pro with his own Mac (needs him: his device, his eye).
- **Platforms:** firmware only; host tests on macOS (this Mac, goldens) and Linux (CI). Bringing an app forward on the Mac is item A's (no Windows yet).
