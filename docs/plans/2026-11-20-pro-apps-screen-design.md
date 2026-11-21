# Harness Pro: the Tabs | Apps pill, the Apps screen and other apps' rooms (item C, 2026-11-20)

Status: approved by the PM (2026-11-20). Branch `feat/pro-apps-screen`, from `main` 3daf515733. Firmware only
(`devices/harness-pro/firmware`).

Context: [the split](2026-11-20-pro-parity-split.md) (sections 1-6; interfaces in section 3), Diego's mockup
`devices/harness-pro/mockup/pro-ui-2026-11.html` (main checkout, gitignored, 2026-11-18), and the round dial's design for
the same flow, [2026-11-18-dial-tabs-apps-switch-design.md](2026-11-18-dial-tabs-apps-switch-design.md).

## Why

The Pro shows only the Harness app's tabs. Items A (daemon), B (cable and model) and E (icons) bring it every app's
agents, the app list and app icons. This item draws them: Home gets the app cards, a pick turns the Pro to that app's
agents, and a room of an agent that cannot hear the Pro says where to see it. Everything else on the Pro stays as it is.

## Terms

- **A window**: the model's `has_window`, as the PM fixed it: the last `agents.end` named a tab, or the `swarms` frame
  still lists tabs. Item A keeps sending a window's `swarms` while the Pro is on an app's ring, so a pick made with the
  window open keeps the window. `machine_view` is not read by this item.
- **The app shown**: the model's `app_shown` (the `apps` frame's `shown`), the app whose ring the daemon sends.
- **An app's agents**: the roster's agents with `host` equal to the app's id, **and only while that app is the app
  shown** (an agent the library also lists can outlive its ring with a stale `host`; it is not the app's then).
- **Other apps**: the `apps` rows with `count > 0` and an id other than `harness`.

## What the person sees

**Home with a window and other apps** (the pill shows):
- Under Home's cards, a two-cell pill **Tabs | Apps**, centred, top at y 640. The cell of the list on screen is filled.
- Home pages as today: the Notices card (while there are notices), the Working card (while an agent works), then the
  list: Harness's tabs (Tabs) or the other apps' cards (Apps). The pill shows on every Home page, also over the
  wordmark when the Tabs list is empty and nothing else is on Home.
- **Tap Apps**: the app cards, on the first one. **Tap Tabs**: the tabs, on the desktop's selected tab (the first tab
  when none is selected). A tap on the filled cell does nothing. Nothing goes to the Mac until a pick.
- No other app: no pill, no pill hits, Home exactly as today (every existing golden screen stays the same). The last
  other app going while Apps is on screen turns Home to Tabs, on the selected tab.

**Home with no window**: no pill; the list is the app cards (Harness included, if the daemon lists it), after the
Notices and Working cards as today. No apps either: Home as today with no tabs.

**An app card** reuses the tab card (540 x 560 at (90, 56), the same name, numeral, pills, marks and peeking
neighbours), drawn from one card description shared with the tab card:
- the background: `card_top` to `card_bottom` of `pod_app_style(id)` (item E, contrast checked there); no style: the
  Pro's own dark, `PH_RAISED` to `PH_GROUND`;
- the icon (`icon72`) at the card's top right, 44 px in from the right edge, its top on the name's line; the name is cut
  to the width left of it. No style: the name only, full width;
- the name (`name`), the numeral and "agent(s)" (`count`), "N working" (`working`), "N asking" (`waiting`). An app card
  shows no "All done": a daemon without `appCards` sends no `working`, and the card must not call working agents done
  (an empty pill row shows nothing);
- the marks (engine logo and state dot; asking, working, then done; at most five, else four and "+N", N counted from the
  agents the Pro holds) of the app's agents. Only the app shown has agents on the Pro (the daemon sends one ring), so
  the other cards have no marks row;
- its equaliser and pulse move as a tab card's (`ph_home_moves` counts the app card's `working` and `waiting`).

**Pick** (a tap on an app card): one `app.pick` of that app. When the app is already the app shown and has agents on
the roster, its first agent's room opens at once. Otherwise the Pro stays on Home on that card and opens the room when
the ring lands (the app is the app shown and has an agent), within 5 s; a touch, a link drop, an `apps` frame showing
another app, or a host focus that lands ends the wait. A pick of `harness` (no window) waits for nothing: the window
comes back and Home shows the tabs.
- The room is today's room. **A sideways swipe** steps through the app's agents (roster order, wrapping), each step
  sending `agent.open` as today. The landing itself sends no `agent.open`: the pick already brought the app and turned
  the ring, as on the round dial.
- **Up from the bottom edge**: Home, on that app's card, with Apps selected.
- **The ring goes** (the daemon turns back to Harness's tabs, or the app's agents leave): the room closes as a closed
  tab's does, to Home; on that app's card while it is still listed, else as Home clamps today.
- The host focusing an agent that no tab holds and that is one of the app shown's agents opens it in that app's ring;
  the same for a notice row or a Working-card pet of such an agent.

**A room of an agent without `v`** (`caps` lacks `v`: ChatGPT and Claude app threads, resting and ended rows): the room
draws as today (the Pro has no "tap to talk" hint to drop). A tap shows "See it in <App>" on the Pro's notice line; no
Talk screen, no `voice.begin`. An agent with no `caps` has all four.

## Model and navigation (firmware `main/pod/`, `main/app/pod_glue.*`)

Read from item B: `apps[]`, `app_count`, `app_shown`, `apps_switch`, `has_window`, `pod_agent_t.host` and `.caps`,
`pod_host_name`, `pro_cable_send_app_pick`. Read from item E: `pod_app_style(id)`.

- **The pill** (`pod_home_switch(m)`): `has_window && apps_switch` and at least one other app.
- **Home's list** (`pod_home_apps(nav, m)`): apps when there is no window and at least one app row with `count > 0`;
  with the pill, apps when the person chose Apps (`nav->home_apps`); else tabs. `nav->home_apps` is cleared when the
  pill goes.
- **The app cards**: indices into `m->apps` (`uint8_t`, never copies of the rows: `pod_nav.c` and `pod_glue.c` build
  with `-Wframe-larger-than=1024`), in the daemon's order, `count > 0`, minus `harness` while the pill shows.
- **Pages**: `POD_HOME_NOTICES`, `POD_HOME_WORKING`, then the list: tabs `0..tab_count-1`, or apps
  `POD_HOME_APP0 + k` (`POD_HOME_APP0` = 32, above every tab index; k the card's place in the list). `pod_home_pages`,
  `pod_home_has` and `pod_home_clamp` take the nav as well as the model. The app under the person is kept by id
  (`nav->home_app`, re-resolved in `pod_nav_sync` as a frame's `tab_id` is), so an `apps` frame that reorders or drops
  another app never moves them.
- **New actions**: `POD_A_HOME_TABS`, `POD_A_HOME_APPS` (the pill's cells; device-local, no effect) and
  `POD_A_PICK_APP` (arg: the index into `m->apps` at draw time, id: the app id; the glue resolves the id against
  `m->apps` before acting, as it does tabs).
- **New effect** `POD_FX_APP_PICK` (the app id in `pod_out_t.agent`), performed in `pro_app.c` with
  `pro_cable_send_app_pick`, beside the other effects.
- **The app ring frame**: `tab = POD_TAB_APP` (-3; -1 is Recent, -2 is `POD_HOME_NOTICES` in `home_at`), `tab_id` = the
  app id. Every place that reads a frame's tab branches on it:
  - `frame_list`: the app's agents (Terms);
  - `pod_nav_sync`: an app frame is kept while its agent is one of the app's agents (it never looks the id up in
    `m->tabs`);
  - `land_on_tab`: from an app room, Home lists apps (`nav->home_apps` when the pill shows) and lands on that app's
    page by id;
  - `home_at` (`ph_overview.c`): a frame with `POD_TAB_APP` is not a tab page.
- **The landing** lives in the glue, beside `pending_focus`: `u->landing` (the app id) and its time, checked in
  `synced()` against `m->clock_ms`, so it runs on the feed that brings the ring (whatever its order with the `focus`
  that follows it). It is cleared by a touch, `pod_ui_link(false)`, an `apps` frame whose `shown` is another app, a
  host focus that lands, and 5 s.
- **An agent's list** is chosen in one place for `pod_nav_follow`, `POD_A_OPEN_NOTIF` and `POD_A_FOLLOW`: the window's
  selected tab, else the first tab that holds it, else its app ring (one of the app shown's agents), else Recent.
- **Following the desktop's tab** (`pod_nav_follow_tab`) moves Home only while Home lists tabs.
- **No `v`**: one helper builds the line, "See it in " + `pod_host_name(host)`, and both paths use it: the glue's
  `talk_fire` (beside today's offline check: notice, no effect, so no Talk frame flashes) and item B's voice gate in
  `pro_app.c` (the guard for every other path). The notice is the Pro's notice line with its own time (3 s).

## Drawing (firmware `main/pod/home/`)

- **The pill** (in `ph_overview.c`, or `ph_apps.c` if the file grows past reading), in Home's own tokens: 252 x 46,
  radius 23: an outer `PH_BORDER` rounded rect and a `PH_GROUND` one inset 2 px (the canvas's stroke is 1 px, so the
  edge is two fills); the filled cell inset 4 px, radius 19, `PH_TRACK`; "Tabs" and "Apps" in `ph_sb_22`, centred in
  their cells, `PH_INK` on the filled cell, `PH_MUTED` on the other. Instant flip. Hits: two halves of the band
  x 180..540, y 624..720, split at x 360. Five runs and two hits in every state.
- **The app card**: the tab card's body from one card description (name, two colours, count, working, asking, marks,
  icon); the icon is one image run (`ht_pro_image`, as `pod_logo_draw`). Item E's RGB565 colours are widened to
  0xRRGGBB for `ph_mix`. Neighbour peeks: the gradient and the name, as the tabs'.
- **Budgets**: every Home state stays within 192 runs and 32 hits (the worst case: an app card with an icon, five
  marks and "+N", both peeks, the pill, the notice pill). `test_ph_views.c` checks it.

## Failures

- A pick the daemon ignores (an old daemon, an app gone): no ring lands, the wait ends after 5 s, the person stays on
  Home on that card. No retry: another tap picks again.
- An `apps` frame with no other app while Apps is on screen: Home turns to Tabs (with a window) or to today's Home (no
  window).
- The link drops: the wait ends; the list is whatever item B's model keeps.
- No new logs (drawing and navigation); item B logs the cable.

## Tests (red first, host only)

- `test_pod_nav.c`: pages for tabs / apps / both and each mix of window, pill and app rows; the Apps and Tabs cells;
  Tabs on the selected tab; the app kept by id across a reordered `apps`; the pill going turns Apps off; the app ring's
  order and wrap; a stale-`host` agent outside the ring; up from the bottom edge to the app's card with Apps; the room
  closed when the ring goes; follow into an app ring; `follow_tab` leaving Apps alone.
- `test_ph_glue.c`: the landing (app already shown; the ring landing later, before and after its `focus`; 5 s; each
  thing that ends the wait); a pick of `harness`; a no-`v` tap: the notice, no effect, no Talk.
- `test_ph_views.c`: the pill drawn only when `pod_home_switch`, its filled cell, its two hits; no pill and no pill
  hits without another app; the pill over the wordmark; no window: app cards, no pill; an app card with and without a
  style (icon run, gradient ends, name width); counts, pills, no "All done", marks; Harness hidden with the pill;
  `ph_home_moves` on a working app; budgets 192 / 32 in the worst case.
- `test_pro_app.py` (click-through, as a person does it): Home with a window → the pill, Tabs filled → tap Apps → swipe
  the app cards → tap a card → exactly one `app.pick` of that app → its ring → its first agent's room → swipe through
  the ring → up from the bottom edge → Home on that card with Apps → tap Tabs → the tabs; no window → app cards, no
  pill; no other app → no pill, no pill hits; a no-`v` room → a tap shows "See it in ChatGPT", no `voice.begin`.
- `pod_render.c/.py`: new screens (`tabs:switch`, `apps`, `apps:noicon`, `apps:nowindow`, `agent:chatgpt:seeit`)
  rendered to 720 x 720 PNGs for the PR. `golden.sh`: the new screens join `golden.txt` and `golden-liberation.txt`;
  every existing hash stays the same. `PH_PERF=1 test/test_ph_perf.sh`: the app card and the pill within budget, new
  baselines recorded.

## Order

Code starts once item B's `pod_model.h` and item E's `app_icons.{c,h}` are both on `main`: every host build
(`run.sh`, `golden.sh`, `test_pro_app.py`) compiles each `.c` in `main/pod`, and goldens drawn with stand-in icons
would change when E lands, which E may not record. The spec and plan are written now.

## Verification

- `bash devices/harness-pro/firmware/test/run.sh`, `golden.sh --check` (both fonts), `PH_PERF=1 test/test_ph_perf.sh`.
- Compile only: `. ~/esp/esp-idf-5.5.4/export.sh && idf.py -B build -DPROJECT_VER=0.0.99-pod build`; PR CI runs the
  real build and the `ota_0` size check.
- On a Pro: not in this item (no flash, no release; the PM asks Diego after the merges).

## Platforms

Firmware only; host tests on macOS and Linux (CI). Bringing an app to the front on the Mac is item A's (macOS `open -b`,
the Linux raise; Windows has none yet, Ken's #4513).

## Open for the PM

1. App cards' marks: only the app shown has agents on the Pro, so the other cards have no marks row. Recommended: as
   written; no daemon change.
2. Item B's files after B merges: this item adds the `POD_FX_APP_PICK` case in `pro_app.c`, and moves the "See it in"
   line into one helper (beside `pod_host_name` in `pod_model.c`) that B's gate and the glue both call. Recommended:
   yes, after B merges (no overlap in time).
3. Icon size: the mockup's icon is about 146 px; the fixed interface gives 72 and 44. Recommended: 72 px.
4. The Notices and Working cards stay on Home with the Apps list (the mockup leaves them out). Recommended: keep.
5. App cards show no "All done" (an older daemon sends no `working`). Recommended: as written.
6. Code waits for item E as well as B. Recommended: yes (else goldens with stand-in icons).
7. `has_window` must stay true while the Pro is on an app's ring with the window open (the PM's rule: a tab, or
   `swarms` still listing tabs). Recommended: confirm with item B that its model computes it that way.
