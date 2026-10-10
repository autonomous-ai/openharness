# Pro Player · Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin Harness Player 1 on the Pro to the Studio mockup, add the horizontal tab bar with Recent, and draw the active tab's panes in the desktop's arrangement from a new `player.layout` message.

**Architecture:**
- **Firmware:** `ui_habitat.c` keeps Player 1's state and flows. Only the drawing in `pro_player*.inc` changes, to Studio primitives in a new `pro_studio.inc`.
- **Desktop:** adds the active tab's pane rectangles to the `app_swarms` overview.
- **Daemon:** validates the rectangles and forwards them as `player.layout`, only to firmware that advertises it.

**Tech Stack:**
- Firmware: ESP-IDF 5.5.4 (`~/esp/esp-idf-5.5.4`), esp32p4, C11, cJSON.
- Daemon: TypeScript and vitest.
- Desktop: Flutter.
- Host tests: Python drivers in `devices/harness-device/firmware/test`.

**Spec:** `docs/superpowers/specs/2026-10-09-pro-player-studio-design.md`

## Global Constraints

- **Where:** branch `dev/firmware-pro-studio` (from `dev/firmware-pro` `07ea2fd55`), worktree `/private/tmp/claude-503/x/prowt`. Never push to `dev/firmware-pro` or `main`. No commits unless the owner asks.
- **Panel turn:** keep the 180° turn in `display_habitat.c` (`paint`) and `touch_mirror = true` in `board/board_pro.c`.
- **Fonts:** Inter and JetBrains Mono (OFL), with their licence files beside them. Never SF Pro or SF Mono.
- **Colours:**

  | Token | Value |
  |---|---|
  | canvas | `#EDEAE2` |
  | card | `#F6F4EE` |
  | ink | `#141412` |
  | secondary | `#7A776E` |
  | line | `#D0CBBF` |
  | working / focus accent | `#FF5A1F` |
  | needs you | `#E69600` |
  | finished | `#2E8C5A` |
  | failed | `#C83228` |

- **`player.layout` bounds:**
  - at most **16** panes;
  - coordinates are integers in thousandths, **0 to 1000**, with `w` and `h` above 0;
  - ids under **48 bytes**;
  - layout area **672 × 592** below the tab bar;
  - a tile under about **140 px** in either side keeps only its name and status mark.
- **Gating:** the firmware advertises the layout in `hello` with `playerLayout: 1`. The daemon lists `player.layout` in `features` and sends `{ t: 'player.layout', tabId, focus, panes: [{ id, x, y, w, h }] }` only when it was advertised.
- **Compatibility:** with no layout (older daemon, too many panes, expired), a tab shows as the list.
- **Build:** the Pro profile from `devices/harness-device/development/README.md`:
  - `-DIDF_TARGET=esp32p4`;
  - `-DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.esp32p4;../prototype/pro-companion/sdkconfig.defaults;../prototype/pro-companion/sdkconfig.wifi.defaults"`;
  - `-DDEVICE_HABITAT=1 -DDEVICE_PRO_COMPANION=1 -DDEVICE_PRO_WIFI=1 -DDEVICE_DEFAULT_CHARACTER=tim -DDEVICE_FORCE_PROD=1`;
  - build dir `/private/tmp/claude-503/x/pro-build`.
- **Generated assets:** regenerate before a host test or a build, in this order: `generate_fonts.py`, `generate_art.py`, `generate_daemons.py`, `generate_living.py`, `generate_player_icons.py`, each run with `uv run --no-project --with numpy --with pillow python`.

## Review Focus

1. **A layout pane names an agent the device does not have** (the roster lags the layout): that pane's tile is drawn as a placeholder, and the layout is dropped after 2 s if the agent never arrives. Tested in Task 4.
2. **The layout and the device's tab differ** (the user taps a chip and the old tab's layout lands): a `tabId` other than the selected tab is ignored. Tested in Task 4.
3. **Desktop mid-change** (`arranged.tiles.length != panes.length`, or `arranged == null`): no layout is sent, rather than a misattributed one. Tested in Task 7.
4. **Sixteen tiny tiles:** no text leaves its tile, and every tile keeps a tap target. Tested in Task 5.
5. **Multibyte names and ids near the limit:** ids of 47 bytes or more are refused whole and never truncated into a different id; names are clipped on UTF-8 boundaries. Tested in Tasks 3 and 6.

---

### Task 1: Studio fonts

**Files:**
- Create: `devices/harness-device/prototype/pro-companion/fonts/Inter-Regular.ttf`, `Inter-SemiBold.ttf`, `Inter-Bold.ttf`, `JetBrainsMono-Medium.ttf`, `OFL-Inter.txt`, `OFL-JetBrainsMono.txt` (from the projects' GitHub releases; record the versions in `fonts/README.md`)
- Modify: `devices/harness-device/prototype/pro-companion/tools/generate_fonts.py`
- Modify: `devices/harness-device/firmware/main/ui/habitat/pro_canvas.h:12`
- Test: `devices/harness-device/prototype/pro-companion/tools/check_font_packing.py`, `devices/harness-device/firmware/test/test_pro_canvas.py`

**Interfaces:**
- Produces: `extern const ht_pro_font_t ht_pro_24, ht_pro_32, ht_pro_42, ht_pro_56;` (now Inter Regular) plus `ht_pro_27s, ht_pro_31s, ht_pro_36s` (Inter SemiBold), `ht_pro_64b` (Inter Bold) and `ht_pro_15m, ht_pro_18m, ht_pro_21m` (JetBrains Mono Medium).

- [ ] **Step 1:** Extend `check_font_packing.py` to assert the eleven symbols exist in `generated/pro_fonts.c`, and that each one's cell height equals `ceil(size * 1.375)`.
- [ ] **Step 2:** Run `uv run --no-project --with pillow python tools/check_font_packing.py`. Expected: FAIL, the new symbols are missing.
- [ ] **Step 3:** In `generate_fonts.py`, replace the Helvetica path with a table of `(symbol, ttf, size)` rows for the eleven fonts above. Keep the glyph set, the Vietnamese ranges and the packing exactly as they are.
- [ ] **Step 4:** Regenerate the assets (Global Constraints). Run `check_font_packing.py`, then `IDF_PATH=~/esp/esp-idf-5.5.4 python3 devices/harness-device/firmware/test/test_pro_canvas.py`. Expected: both PASS.

### Task 2: Studio primitives and tokens

**Files:**
- Create: `devices/harness-device/firmware/main/ui/habitat/pro_studio.h`, `pro_studio.inc`
- Modify: `devices/harness-device/firmware/main/ui/habitat/theme.h` (the Pro colour block), `ui_habitat.c` (include `pro_studio.inc` before `pro_player.inc`)
- Test: `devices/harness-device/firmware/test/test_pro_touch_ui.py` (new `studio_primitives` case)

**Interfaces:**
- Produces:
  - Colour macros: `STUDIO_BG STUDIO_CARD STUDIO_INK STUDIO_DIM STUDIO_LINE STUDIO_ACCENT STUDIO_ASK STUDIO_DONE STUDIO_FAIL` (`color(0x…)`).
  - Drawing:
    - `void studio_card(ht_scene_t *f, int x, int y, int w, int h, bool focus)`: radius 22, a 1 px line, or a 3 px accent border when `focus`.
    - `int studio_chip(ht_scene_t *f, int x, int y, const char *label, bool on)`: returns its width.
    - `int studio_badge(ht_scene_t *f, int x, int y, const char *label)`: returns its width.
    - `void studio_status(ht_scene_t *f, int cx, int cy, const agent_t *a)`: the braille, `?`, `✓` or `✗` mark.
    - `void studio_tab_bar(ht_scene_t *f, int selected)`: `-1` is Recent; `0..s.tab_count-1` are tabs.
  - Hit targets: Recent is `A_AGENTS`, a tab is `A_TAB` with its index, the gear is `A_SETTINGS`.

- [ ] **Step 1:** Add a `studio_primitives` case to `test_pro_touch_ui.py`. It renders a scene with one card, one chip and the tab bar, and asserts four sampled pixels:
  - the canvas at (5,700) is `STUDIO_BG`;
  - inside the card is `STUDIO_CARD`;
  - the selected chip is `STUDIO_INK`;
  - the gear's region is not canvas.
- [ ] **Step 2:** Run `IDF_PATH=~/esp/esp-idf-5.5.4 python3 devices/harness-device/firmware/test/test_pro_touch_ui.py`. Expected: FAIL, `studio_card` undefined.
- [ ] **Step 3:** Implement `pro_studio.h` and `pro_studio.inc` with the existing `ht_pro_rect`, `ht_pro_text` and `ht_pro_image`. The tab bar:
  - Recent's clock chip is pinned at x 24, the gear at 636 to 720, and the tab chips scroll so the selected one is visible.
  - The chips fade into the gear over 70 px, drawn as a stepped blend of `STUDIO_BG` (no alpha in the canvas).
  - In `theme.h`, point the Pro block at the Studio values.
- [ ] **Step 4:** Rerun. Expected: PASS, and the existing cases still PASS.

### Task 3: `player.layout` on the firmware's wire

**Files:**
- Create: `devices/harness-device/firmware/main/ui/habitat/pro_player_layout.h` (header-only, like `pro_player_library.h`)
- Modify: `devices/harness-device/firmware/main/cable_client.c` (hello: `msg_number(&root, "playerLayout", 1);` beside `"player"`; dispatch `player.layout` next to `player.library` at ~1229), `ui/ui_screens.h:364`
- Test: create `devices/harness-device/firmware/test/test_pro_player_layout.py` (model it on `test_pro_player_library.py`)

**Interfaces:**
- Produces:
  ```c
  #define PRO_PLAYER_LAYOUT_PANES 16
  typedef struct { char id[48]; uint16_t x, y, w, h; } pro_player_pane_t;
  typedef struct { char tab_id[48]; char focus[48]; uint8_t count; pro_player_pane_t panes[PRO_PLAYER_LAYOUT_PANES]; } pro_player_layout_t;
  bool pro_player_layout_parse(const cJSON *p, pro_player_layout_t *out);
  void ui_player_layout(const pro_player_layout_t *layout);   // ui_screens.h, DEVICE_PRO_COMPANION only
  ```

- [ ] **Step 1:** Write `test_pro_player_layout.py`. It compiles the header against cJSON and asserts that `parse`:
  - accepts a two-pane frame and keeps every value exactly;
  - refuses 17 panes;
  - refuses `x + w > 1000`;
  - refuses `w == 0`;
  - refuses a non-integer `x`;
  - refuses a 48-byte id;
  - refuses a missing `tabId`;
  - accepts `focus` missing (empty string) and `panes: []` (count 0).
- [ ] **Step 2:** Run `IDF_PATH=~/esp/esp-idf-5.5.4 python3 devices/harness-device/firmware/test/test_pro_player_layout.py`. Expected: FAIL, header missing.
- [ ] **Step 3:** Implement the header. A refused frame leaves `*out` untouched. Wire the dispatch in `cable_client.c` to call `ui_player_layout` only when parse succeeds, and add the `playerLayout` hello field.
- [ ] **Step 4:** Rerun, then `test_cable_json_parse.py` with `IDF_PATH` set (it compiles `on_frame`). Expected: both PASS.

### Task 4: Layout state, expiry and fallback in the UI

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (state `s.player_layout`, `s.player_layout_ms`; `ui_player_layout`; clear on tab select, `disconnected`, `s.connected=false`)
- Test: `devices/harness-device/firmware/test/test_pro_touch_ui.py` (new `player_layout_lifetime` case)

**Interfaces:**
- Consumes: `pro_player_layout_t`, `ui_player_layout` (Task 3).
- Produces: `static bool pro_player_layout_live(void)`. It is true when a layout is held, its `tab_id` equals `s.selected_tab`, and every pane id is in `s.agents`, with up to 2000 ms of grace for missing ids.

- [ ] **Step 1:** Add `player_layout_lifetime`. It asserts:
  - a layout for the selected tab is live;
  - a layout naming another tab is ignored, and the previous one stays (Review Focus 2);
  - selecting another tab clears it;
  - disconnect clears it;
  - a pane id missing from the roster stays live for 1999 ms and stops at 2000 ms (Review Focus 1).
- [ ] **Step 2:** Run `test_pro_touch_ui.py`. Expected: FAIL.
- [ ] **Step 3:** Implement it. `ui_player_layout` copies under the UI lock and calls `change()` only when the layout differs from the held one.
- [ ] **Step 4:** Rerun. Expected: PASS.

### Task 5: Navigation screens (tab bar, Recent, tab view)

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/pro_player.inc` (`pro_player_library` becomes Recent under `studio_tab_bar(f,-1)`), `pro_player_controls.inc` (`case TABS:` draws the tab view)
- Test: `devices/harness-device/firmware/test/test_pro_touch_ui.py` (Studio fixtures exported with `HARNESS_PLAYER_PREVIEW`)

**Interfaces:**
- Consumes: Task 2 primitives, `pro_player_layout_live()` (Task 4), `s.player_library`.
- Produces: `static void pro_studio_tab(ht_scene_t *f)` and `static void pro_studio_tile(ht_scene_t *f, int x, int y, int w, int h, const agent_t *a, bool focus)`.

- [ ] **Step 1:** Add the fixtures `studio_recent`, `studio_tab_1`, `studio_tab_2`, `studio_tab_3`, `studio_tab_4` (the mockup's agents and actions), `studio_tab_16` and `studio_tab_nolayout`. Assert:
  - every row and every tile has a `pro_hit` target (Recent rows `A_AGENT`; tiles `A_AGENT` with the agent index);
  - in `studio_tab_16`, no ink pixel falls outside its tile rectangle, and every tile is at least 1 tap target (Review Focus 4);
  - `studio_tab_nolayout` renders the list.
- [ ] **Step 2:** Run with `HARNESS_PLAYER_PREVIEW=/private/tmp/claude-503/x/studio-out`. Expected: FAIL, then PASS after Step 3.
- [ ] **Step 3:** Implement Recent from the mockup's `studio-tabs-recent.png`:
  - the header line "All tabs, latest first" with the counts;
  - rows of name 31 px, a mono machine line, and the status at x 652;
  - the selected row is a card with a 6 px accent bar;
  - a scroll rail.

  Implement the tab view by scaling each pane rectangle into (24,108)–(696,700), gap 12 px:
  - tiles follow `pro_studio_tile`: the name wrapped to two lines, machine and engine, `NOW` with the action, or `QUESTION` with a Review chip, and the status row with the elapsed time;
  - tiles below 140 px keep only the name and the mark.
- [ ] **Step 4:** Convert the exports to PNG and place them beside `mockup/pro-player/studio-tabs-*.png` in one contact sheet. Fix layout differences until they match.

### Task 6: Session and system screens

**Files:**
- Modify: `pro_player.inc` (`pro_player_home`: detail and question), `pro_controls.inc` (`pro_heading`, `pro_row`, `pro_control` in the `s.player` branches), `pro_player_controls.inc` (`pro_player_settings`), plus the `VOICE` and loading / empty / disconnected branches
- Test: `test_pro_touch_ui.py` (fixtures `studio_detail_working`, `studio_detail_question`, `studio_choices`, `studio_answer_review`, `studio_listening`, `studio_settings`, `studio_loading`, `studio_empty_tab`, `studio_disconnected`)

**Interfaces:**
- Consumes: Task 2 primitives.

- [ ] **Step 1:** Add the fixtures. Assert the hit targets Player 1 already has:
  - back `A_AGENTS`;
  - Review `A_QUESTION`;
  - choices, Previous, Next, Send and Edit keep their existing actions.

  In `studio_detail_working`, also assert that an id or name of 47 bytes of multibyte text renders without splitting a UTF-8 sequence (Review Focus 5).
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Draw each screen from its `mockup/pro-player/studio-*.png`:
  - the header back chevron with the tab name;
  - the allowance with its bar;
  - the title at 64 px bold;
  - mono chips for machine, project and branch;
  - the `NOW` card;
  - a mono elapsed time `mm:ss`, or `h:mm:ss` from 1 hour;
  - the question card with the Review button;
  - the answer screens with Previous / Next and Back / Send;
  - the listening ring;
  - settings rows;
  - skeleton rows for loading;
  - the empty-tab and disconnected illustrations.
- [ ] **Step 4:** Rerun, then the contact sheet against the mockup as in Task 5. Also run the existing `test_pro_controls.py`, `test_pro_question_lifetime.py` and `test_pro_draft_recovery.py`. Expected: all PASS.

### Task 7: Desktop sends the active tab's arrangement

**Files:**
- Modify: `desktop/lib/state/app_state.dart` (`playerOverview`, ~2612)
- Test: `desktop/test/player_overview_test.dart`

**Interfaces:**
- Produces: `playerOverview['layout'] = {'tabId': activeSwarm.id, 'focus': <agentId or ''>, 'panes': [{'id', 'x', 'y', 'w', 'h'}]}`.
  - The coordinates are `(rect.left * 1000).round()` and so on, clamped to 0 to 1000.
  - The key is omitted when `activeSwarm.arranged == null`, or when its `tiles.length` differs from the panes' count, or exceeds 16, or when any pane has no `agentId`.

- [ ] **Step 1:** Add tests:
  - a two-pane `viewerBesideTerminal` swarm yields the panes `(0,0,667,1000)` and `(667,0,333,1000)`;
  - `arranged == null` omits `layout`;
  - `tiles.length != panes.length` omits it (Review Focus 3);
  - 17 panes omit it;
  - the focus follows `focusedPaneId`.
- [ ] **Step 2:** Run `cd desktop && flutter test test/player_overview_test.dart`. Expected: FAIL.
- [ ] **Step 3:** Implement it. Tile index `i` belongs to `activeSwarm.panes[i]`, the same order `PaneGrid` stores `arranged` in. Recompute only inside `playerOverview`; the existing `_announceOpenPanesToDial` triggers already cover tab, split and focus changes. Add the arrangement change if `PaneGrid`'s `arranged` write does not reach them.
- [ ] **Step 4:** Rerun it, and `flutter analyze lib/state test/player_overview_test.dart`. Expected: PASS, no issues.

### Task 8: Daemon validates and forwards `player.layout`

**Files:**
- Modify: `cli/src/localWsServer.ts` (`appSwarmsFrom`, ~273), `cli/src/cable/cableHost.ts` (`playerLayout()`), `cli/src/cable/cableSession.ts` (hello at ~825, features at ~845, `syncPlayerLayout`)
- Test: `cli/src/localWsServer.spec.ts`, `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Produces:
  - `AppSwarms['overview']['layout']?: { tabId: string; focus: string; panes: Array<{ id: string; x: number; y: number; w: number; h: number }> }`.
  - `CableHost.playerLayout?(): AppSwarms['overview']['layout'] | null`.
  - `CableSession.syncPlayerLayout(force?: boolean): Promise<void>`.
  - The private flag `playerLayoutCapable = msg.playerLayout === 1`.

- [ ] **Step 1:** Write the specs.
  - In `localWsServer.spec.ts`:
    - a valid layout passes;
    - a pane not in the active tab's `agentIds` drops the whole layout;
    - 17 panes drop it;
    - `x + w > 1000`, a non-integer coordinate, or a 48-byte id drop it.
  - In `cableSession.spec.ts`:
    - no `player.layout` without `playerLayout: 1` in the hello;
    - one frame on the first sync and none on an identical second;
    - a new frame after a change;
    - a forced resend after reattach;
    - `features` lists `player.layout` only when advertised.
- [ ] **Step 2:** Run `cd cli && npx vitest run src/localWsServer.spec.ts src/cable/cableSession.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement it, mirroring `syncPlayerLibrary` and `syncPlayerOverview`:
  - queued sends, and a JSON key for deduplication;
  - the key resets in the same two places `playerOverviewKey` does;
  - sync is called where `syncPlayerOverview` is.
- [ ] **Step 4:** Rerun them, then `npx tsc --noEmit -p .` and the branch's `npm run test:core`. Expected: PASS; coverage is 100% for any file under `src/core` or `src/services` that was touched.

### Task 9: On the device

**Files:** none new.

- [ ] **Step 1:** Build the firmware (Global Constraints). Expected: `exit=0`, and `CONFIG_ESP32P4_REV_MIN_FULL=300` in the build's sdkconfig.
- [ ] **Step 2:** Install the branch's CLI and desktop:
  1. `bash cli/scripts/install-cli.sh` from the worktree.
  2. `bash desktop/scripts/build-macos-debug.sh` from the worktree, then open that app.
- [ ] **Step 3:** Flash the Pro:
  1. Quit the app, write the `~/.harness/flasher/flashing` lock, `harness stop`.
  2. Run esptool `read-mac` on the native port. It must be `e8:f6:0a:e7:63:7d` with chip ESP32-P4 v3.x; stop if not.
  3. `write-flash` the app at `0x20000`.
  4. Remove the lock.
  5. Delete `E8:F6:0A:E7:63:7D` from `~/.harness/cli/data/dial-ports.json`.
  6. `harness start`, then reopen the app.
- [ ] **Step 4:** Verify:
  - the boot banner and the daemon log `cable: … [usb E8:F6:0A:E7:63:7D]`;
  - the daemon log shows `player.layout` sent;
  - the owner checks each screen, touch on the turned panel, tab switching from a chip, and a 1-, 2-, 3- and 4-pane tab.
- [ ] **Step 5:** Restore `main` once the owner is done: in `/Users/duynguyen/go/src/github.com/autonomous-ai/autonomous-harness`, run `make install-cli`, then `bash desktop/scripts/build-macos-debug.sh`, then reopen the app.
