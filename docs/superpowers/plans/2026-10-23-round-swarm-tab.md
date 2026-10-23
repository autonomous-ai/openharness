# Round Dial Swarm Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the round dial a Swarm is one more tab. Its projects are panes (their Leads) in the app's order. A Lead that needs you beeps and adds one inbox entry, even when it runs on another machine. You can talk to a Lead on this computer; a remote Lead is read-only.

**Architecture:**
- **Daemon.** The daemon already serves the Pro's Swarm frames (#1537) and Super Tab waits to any device whose hello names `swarmCard:"v1"` / `superTab:"wait-v1"`. It gains one field, `leads[i].order`.
- **Firmware model.** The round firmware names both capabilities, parses the frames in `cable_client.c`, and keeps the Swarms in a new pure module (`supertab.c`).
- **Firmware UI.** `ui_habitat.c` feeds the module's Swarms into the existing Focus screens: the TABS carousel, the agent face, PANES, the inbox and voice.

**Tech Stack:** TypeScript (cli, vitest); C on ESP-IDF 5.5.4 for the ESP32-S3 round dial (`devices/harness-device/firmware`, host tests with `cc` and python fixtures).

**Spec:** `docs/superpowers/specs/2026-10-23-round-swarm-tab-design.md`

## Global Constraints

- **Decisions are fixed** (spec "Decisions"):
  - a Swarm tab is drawn like any tab;
  - Swarms the desktop has not opened come after the desk tabs;
  - projects keep `order`;
  - remote Leads beep and add a read-only entry; there is no remote reply;
  - Leads only;
  - no Home and no Pro card.
- **Wire:**
  - only `order` is new;
  - no new frame and no `CABLE_PROTO_VERSION` bump;
  - the Pro firmware ignores `order` and is not changed.
- **Limits:**
  - 16 Swarms, 12 Leads each;
  - names ≤48 bytes;
  - recap ≤1,500 bytes, one slot only (the Lead on the face);
  - every frame under the 512-token guard (`cable_json_guard.h`);
  - the model lives in PSRAM (`EXT_RAM_BSS_ATTR`).
- **On-device copy** (English, already approved): "Needs you. Answer on the desktop.", "Stuck. See the desktop.", and the existing "No panes in this tab.", "Choose a tab", "Working...", "No notification". No string names a Lead or a Product Manager.
- **Every Focus page stays Inter-only, with ink inside r 230** (the `test_touch_ui.py` scans).
- **Isolation:** no file under `devices/harness-pro/firmware` except `.md` may mention `harness-device`.
- **Repo rules:**
  - work in a worktree off current `main`;
  - commit, push and open a PR only when the owner says so;
  - dev firmware builds use `-DPROJECT_VER=0.0.99`, or the daemon's OTA replaces them;
  - match the surrounding style and comment density.

## Review Focus

- A Super Tab wait must never open the round dial's question/answer screen (it cannot load one) — Task 6 tests.
- `notif.replace` from the desktop must not drop the dial's own Swarm entries — Task 6 tests.
- One beep for a Lead whose wait and state change arrive in either order — Task 6 tests.
- A Lead id must never reach `focus`, `agent.open` or `voice.begin`; only `local` reaches voice — Tasks 5, 7 tests.
- Entering a Swarm must not start the desk-tab workspace handshake (it would fail "That workspace is gone") — Task 4 tests.
- The model is reset on link loss and rebuilt on attach without stale entries — Tasks 3, 6 tests.

---

### Task 1: Daemon — `order` on every Lead

**Files:**
- Modify: `cli/src/superTabs/cards.ts` (`SwarmLead`, `leadsOf` and its leading comment), `cli/src/cable/cableSession.ts` (`pushSwarmCards` frame), `devices/harness-pro/docs/cable.md` (`supertab` frame: optional `order`)
- Test: `cli/src/superTabs/cards.spec.ts`, `cli/src/cable/cableSession.spec.ts`, `devices/harness-pro/firmware/test/test_pro_cable.c`

**Interfaces:**
- Produces: `SwarmLead.order: number` (0-based index in `state.projects`; the old-tab `lead` project is 0). On the wire: `"order":N` on each `supertab.leads[i]`.

- [ ] **Step 1: Write failing tests.**
  - `cards.spec.ts`:
    - three projects with states done/ask/work come out ordered ask, work, done and carry `order` 1, 2, 0;
    - 13 projects keep the 12 most urgent, with their original `order` (gaps allowed);
    - an old tab without `projects` gives `order: 0`.
  - `cableSession.spec.ts`:
    - a `supertab` frame carries `order` per Lead;
    - a round hello (`board` not `pro`) naming `swarmCard:"v1"` and `superTab:"wait-v1"` gets `supertabs`/`supertab` with no `seq`, and a Super Tab `question` with `superTab`/`attention`;
    - a 16 × 12 list with `order` keeps each `supertab` under 512 JSON tokens.
  - `test_pro_cable.c`: a `supertab` whose Leads carry `order` parses to the same model as one without.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/superTabs/cards.spec.ts src/cable/cableSession.spec.ts`. Expected: FAIL (no `order`). The Pro case passes already, which is the point: run `cd devices/harness-pro/firmware && bash test/run.sh`.
- [ ] **Step 3: Implement.** In `leadsOf`, record the project index when building `leads`. In `pushSwarmCards`, copy `order: l.order` onto each Lead. Fix the comment "in project order then by urgency" to say what the code does. Document `order` in `cable.md`.
- [ ] **Step 4: Run** the two specs, `npx vitest run src/superTabs src/cable`, and `npm run typecheck`. Expected: PASS. (`test:core` is not needed: no file under `src/core` or `src/services` changes.)
- [ ] **Step 5: Commit** (when authorized) `feat(super-tabs): send each Lead's project order`.

### Task 2: Round firmware — the `supertab` model

**Files:**
- Create: `devices/harness-device/firmware/main/ui/habitat/supertab.h`, `devices/harness-device/firmware/main/ui/habitat/supertab.c`, `devices/harness-device/firmware/test/test_supertab.c`
- Modify: `devices/harness-device/firmware/main/CMakeLists.txt` (source list, beside `ui/habitat/workspace.c`), `devices/harness-device/firmware/test/run.sh` (build and run `test_supertab`)

**Interfaces:**
- Produces:
  ```c
  enum { HT_SUPERTABS_MAX = 16, HT_SUPERTAB_LEADS_MAX = 12, HT_SUPERTAB_NAME = 49, HT_SUPERTAB_TEXT = 1501 };
  typedef enum { HT_LEAD_DONE, HT_LEAD_WORK, HT_LEAD_ASK, HT_LEAD_STUCK } ht_lead_state_t;
  typedef struct { char id[ID_MAX], project_id[ID_MAX], project[HT_SUPERTAB_NAME], engine[12], owner[HT_SUPERTAB_NAME], local[ID_MAX];
                   ht_lead_state_t state, was; int order; uint32_t since_s, since_at_ms; } ht_lead_t;
  typedef struct { char id[ID_MAX], tab[ID_MAX], name[HT_SUPERTAB_NAME]; uint16_t count; uint8_t lead_n; ht_lead_t leads[HT_SUPERTAB_LEADS_MAX]; } ht_supertab_t;
  typedef enum { HT_RECAP_NONE, HT_RECAP_LOADING, HT_RECAP_LOADED, HT_RECAP_EMPTY } ht_recap_state_t;
  typedef struct { ht_supertab_t tabs[HT_SUPERTABS_MAX]; int n; char ids[HT_SUPERTABS_MAX][ID_MAX]; int id_n;
                   struct { char tab[ID_MAX], lead[ID_MAX], text[HT_SUPERTAB_TEXT]; uint32_t at, asked_ms; ht_recap_state_t state; } recap; } ht_supertabs_t;
  typedef enum { HT_LEAD_RAISED_ASK, HT_LEAD_RAISED_STUCK, HT_LEAD_CLEARED } ht_lead_event_kind_t;
  typedef struct { ht_lead_event_kind_t kind; char tab[ID_MAX], lead[ID_MAX]; } ht_lead_event_t;
  void ht_supertabs_reset(ht_supertabs_t *);
  void ht_supertabs_ids(ht_supertabs_t *, const char ids[][ID_MAX], int n);                 // drops records gone from the list
  int  ht_supertabs_put(ht_supertabs_t *, const ht_supertab_t *in, uint32_t now_ms,        // sorts leads by order (stable; frame order without it),
                        ht_lead_event_t *ev, int ev_max);                                  // returns the transition events
  const ht_supertab_t *ht_supertabs_find(const ht_supertabs_t *, const char *id);
  const ht_supertab_t *ht_supertabs_for_desk(const ht_supertabs_t *, const char *desk_tab_id);
  const ht_lead_t *ht_supertabs_lead_by_local(const ht_supertabs_t *, const char *harness_id, const ht_supertab_t **tab);
  void ht_supertabs_recap_open(ht_supertabs_t *, const char *tab, const char *lead, uint32_t now_ms);   // LOADING, clears text
  bool ht_supertabs_recap_put(ht_supertabs_t *, const char *tab, const char *lead, const char *text, uint32_t at, bool none);   // false: not the open Lead
  ```
- [ ] **Step 1: Write failing tests** in `test_supertab.c`:
  - Leads sorted by `order` with ties stable, and kept in frame order when `order` is absent (-1).
  - 13 Leads in → 12 kept; a name over 48 bytes is cut on a UTF-8 boundary; an id of `ID_MAX` bytes or more is rejected.
  - Unknown state → DONE; a `put` for an id not in the last `ids` is dropped; `ids` without a Swarm drops its record.
  - Transitions:
    - DONE→ASK raises ASK once; ASK→ASK raises nothing; ASK→STUCK raises STUCK; STUCK→WORK clears;
    - a Lead first seen in ASK raises ASK;
    - a Lead gone from the frame clears.
  - `for_desk` matches `tab`; `lead_by_local` matches `local` and never an empty `local`.
  - Recap: `put` for another Lead returns false and stores nothing; a 1,600-byte text is cut to 1,500 on a UTF-8 boundary; `none` sets EMPTY; `reset` clears everything.
- [ ] **Step 2: Run** `cd devices/harness-device/firmware && bash test/run.sh`. Expected: FAIL (no module).
- [ ] **Step 3: Implement** `supertab.c` with no LVGL and no cJSON (the caller passes parsed structs), in the style of `workspace.c`.
- [ ] **Step 4: Run** `bash test/run.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dial): a model of the Swarms and their Leads`.

### Task 3: Round firmware — hello, parsing and the three requests

**Files:**
- Modify: `devices/harness-device/firmware/main/cable_client.c` (`send_hello`; the `t` dispatch near `swarms`/`question`/`question.close`; new `handle_supertabs`, `handle_supertab`, `handle_supertab_recap`, `handle_supertab_focus`; link-down reset), `devices/harness-device/firmware/main/cable_client.h` (`cable_client_supertab_send`), `devices/harness-device/firmware/main/ui/ui_screens.h` (UI entry points below)
- Test: `devices/harness-device/firmware/test/test_cable_identity.py` (production handlers with real cJSON; needs `IDF_PATH`)

**Interfaces:**
- Consumes: Task 2.
- Produces:
  ```c
  void cable_client_supertab_send(const char *t, const char *tab, const char *lead);   // "supertab.recap.get" | "supertab.open" | "supertab.select"; lead "" only for open
  void ui_supertabs_ids(const char ids[][ID_MAX], int n);
  void ui_supertab(const ht_supertab_t *in);
  void ui_supertab_recap(const char *tab, const char *lead, const char *text, uint32_t at, bool none);
  void ui_supertab_focus(const char *tab, const char *lead);
  void ui_supertab_wait(const char *agent_id, const char *request, const char *swarm_name, bool stuck, const char *text);
  void ui_supertab_wait_close(const char *agent_id, const char *request);
  ```
- [ ] **Step 1: Write failing tests:**
  - `hello` carries `"swarmCard":"v1"` and `"superTab":"wait-v1"`.
  - `supertabs` and `supertab` parse every field, including `order` and an absent `since`. A malformed Lead is skipped, not the frame.
  - A `question` carrying `superTab` calls `ui_supertab_wait`, never `ui_question_show`, and never `audio_notify_done` directly; a plain `question` is unchanged.
  - A `question.close` whose id starts with `supertab:` calls `ui_supertab_wait_close`.
  - `supertab.recap` with `none:true` passes `none`.
  - Each request builds the exact JSON. `supertab.open` with an empty lead is allowed; the others refuse an empty or overlong id.
- [ ] **Step 2: Run** `IDF_PATH=~/esp/esp-idf-5.5.4 bash test/run.sh`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** in `cable_client.c`, the only file that builds or reads a `t`. Parse into a stack `ht_supertab_t` and hand it to the UI under its lock. On link loss, clear the Swarm model through the UI. Note the frames in `cable_client.h`'s comment block (the round dial has no separate cable document on main; the header names `docs/specs/cable-protocol.md`, which does not exist in this repository).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dial): hear the Swarms, their Leads and Super Tab waits`.

### Task 4: Round firmware — Swarms in TABS (1a–1d)

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (`ui_swarms_replace`, `tab_label`, `render_focus_tabs`, `tabs_open`, `A_TAB`/`A_TAB_DONE` in `dispatch`, `workspace_index` callers; state `s` gains the model and `swarm_mode` with the current Swarm id)
- Test: `devices/harness-device/firmware/test/test_touch_ui.py`

**Interfaces:**
- Consumes: `ht_supertabs_for_desk`, `ht_supertabs_find`, `cable_client_supertab_send` (Tasks 2–3).
- Produces: one tab list made of desk tabs (≤24) followed by Swarms with an empty `tab` (≤16). Entering a Swarm sets the dial's Swarm mode with no workspace handshake.

- [ ] **Step 1: Write failing tests:**
  - A desk tab linked to a Swarm keeps its place and name; it is listed even with `agents` 0.
  - Two unopened Swarms follow the desk tabs in `supertabs` order.
  - Every tab run uses the same font and ink as an ordinary tab (decision 1: compare against a desk tab run).
  - Tap or ✓ on a Swarm enters it with no `swarm.select` sent and no "Switching tab" view, sending `supertab.select` then `supertab.open` for the first Lead by `order`, or for the Lead `supertab.focus` named.
  - An ordinary desk tab still sends `swarm.select`.
  - Hold on a Swarm face opens TABS on that Swarm.
  - Portraits `swarm-tabs-1a` … `swarm-tabs-1d`.
- [ ] **Step 2: Run** `python3 test/test_touch_ui.py`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `s.tabs` for desk tabs. Build the carousel's index space as desk tabs followed by unopened Swarms. `tab_label` returns the Swarm's name for the second part.
- [ ] **Step 4: Run** `bash test/run.sh`. Expected: PASS. Render with `HABITAT_PREVIEW_DIR=/tmp/round-swarm python3 test/test_touch_ui.py` and compare 1a–1d with the mockup.
- [ ] **Step 5: Commit** `feat(dial): Swarms in the tab list`.

### Task 5: Round firmware — Swarm panes, PANES and following (2a–2h, 3a–3c)

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (`render_home` face building for a Swarm pane; `render_focus_panes`/`pane_label`; `habitat_touch` horizontal swipe; `A_AGENT`/`A_AGENTS`; `ui_boot_pressed`; the recap retry on the existing timer tick)
- Test: `devices/harness-device/firmware/test/test_touch_ui.py`

**Interfaces:**
- Consumes: Tasks 2–4; `ht_focus_face` with `ht_character_face_t` fields `name`, `engine`, `elapsed`, `mood`, `asking` and the recap text.
- Produces: a Swarm pane index in place of `s.active` while in Swarm mode. No Lead id ever reaches `cable_client_send_focus`/`cable_client_send_open`.

- [ ] **Step 1: Write failing tests.** Each face case below follows the spec §4 table:
  - **Faces:**
    - work local with `since` 134 → elapsed text "2:14" on the lower arc (2a);
    - done with a recap → the card at ≤4 lines with a final "…" for a 1,500-byte text (2b, 2g);
    - ask local with an open wait → the wait text in the card and the asking pose (2c);
    - stuck → "Stuck: …" and no red ink (2d);
    - work remote → "Working..." and no time (2e);
    - ask remote → the recap card (2e′);
    - recap none → the resting face (2f);
    - no Leads → "No panes in this tab." and "Choose a tab" → TABS (2h).
  - **Swipe and recap:**
    - a horizontal swipe moves by `order` with wrap, and sends `supertab.select`, `supertab.open`, `supertab.recap.get` (no `focus`);
    - a `supertab.recap` for another Lead is ignored;
    - with no answer in 5 s, one more `recap.get` goes out.
  - **PANES:** one page per Lead in `order`; a long name splits over two lines with "…"; 12 pages; ✓ picks (3a–3c).
  - **Follow:**
    - `supertab.focus` moves the face, except during voice;
    - a new `supertab` without the shown Lead moves to the same position;
    - the Swarm leaving `supertabs` → TABS.
  - **Leaving and side button:**
    - leaving the Swarm sends `supertab.open` with `lead:""`;
    - the side button on a busy local Lead opens STOP for `local`; on a remote Lead it goes HOME.
  - **Portraits:** `swarm-2a` … `swarm-2h`, `swarm-3a` … `swarm-3c`.
- [ ] **Step 2: Run** `python3 test/test_touch_ui.py`. Expected: FAIL.
- [ ] **Step 3: Implement.** Build an `ht_character_face_t` from the Lead (no new drawing code), with elapsed = `since_s` + (now − `since_at_ms`)/1000 and `asking` for ask/stuck. The card text priority is wait text > recap > none.
- [ ] **Step 4: Run** `bash test/run.sh`. Expected: PASS. Render the portraits and compare with mockup 2a–3c.
- [ ] **Step 5: Commit** `feat(dial): a Swarm's projects as panes`.

### Task 6: Round firmware — beep and inbox (4a–4f, 2e′)

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (`ui_supertab`/`ui_supertab_wait`/`ui_supertab_wait_close` → `notice_add`/`notice_remove`; `ui_notif_replace` re-merging dial-owned entries; `render_focus_inbox`/`render_notice` grey line from the Swarm name; `A_NOTICE` for a Swarm entry), `devices/harness-device/firmware/main/cable_client.c` (`audio_notify_done` when the UI reports a raised entry not on the face, as the `question` handler does today)
- Test: `devices/harness-device/firmware/test/test_touch_ui.py`, `devices/harness-device/firmware/test/test_question_ui.py`, `devices/harness-device/firmware/test/test_cable_identity.py`

**Interfaces:**
- Consumes: the `ht_lead_event_t` transitions (Task 2) and the wait entry points (Task 3).
- Produces: one question-type notice per Lead, keyed by the Lead's agent id, with an owner flag of "dial" so `ui_notif_replace` keeps it.

- [ ] **Step 1: Write failing tests:**
  - **Raise and clear:**
    - a remote Lead going done→ask adds "Needs you. Answer on the desktop." with the Swarm's name on the grey line and the project in green, and beeps once (4e);
    - stuck adds "Stuck. See the desktop.";
    - back to work removes it.
  - **Local waits:**
    - a local Lead's wait replaces the text with `questions[0].q` (4c, 4d);
    - the wait and the state change, in either order, give one entry and one beep;
    - `question.close` restores the fixed text while still ask;
    - a Super Tab wait never opens QUESTION/CHOICE/ANSWER_REVIEW (`test_question_ui.py`);
    - a wait from an agent that is no Lead's `local` adds nothing.
  - **Inbox behaviour:**
    - a `notif.replace` with desktop rows keeps every Swarm entry;
    - an entry for the Lead on the face is read at once, with no beep;
    - the bell pill shows the count at y 400, or the pet's bubble while working (4a, 4b);
    - tapping a Swarm entry enters that Swarm at that Lead;
    - link loss clears the Swarm entries;
    - an empty inbox shows "No notification" (4f).
  - **Portraits:** `swarm-4a` … `swarm-4f`, `swarm-2e-ask`.
- [ ] **Step 2: Run** `python3 test/test_touch_ui.py && python3 test/test_question_ui.py`, then `IDF_PATH=~/esp/esp-idf-5.5.4 python3 test/test_cable_identity.py`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `notice_add`, `notice_remove`, `notice_read_now` and `on_face`. Mark Swarm notices so `ui_notif_replace` re-adds them after rebuilding from the snapshot.
- [ ] **Step 4: Run** `bash test/run.sh` (with `IDF_PATH`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(dial): a Lead that needs you beeps and waits in the inbox`.

### Task 7: Round firmware — talk to a local Lead (5a–5e)

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (the face tap → `A_VOICE` target and `s.voice_engine` while in Swarm mode)
- Test: `devices/harness-device/firmware/test/test_voice_ui.py`, `devices/harness-device/firmware/test/test_touch_ui.py`

**Interfaces:**
- Consumes: `ht_lead_t.local` and `engine`.

- [ ] **Step 1: Write failing tests:**
  - a tap on a local Lead's face starts voice with `agent_id` = `local` (never the Lead id), shows listening and sending, then returns to the Swarm face (5a–5d);
  - an engine with no listening scene shows the seven bars (5e);
  - a tap on a remote Lead's face starts nothing.
  - Portraits `swarm-5a` … `swarm-5e`.
- [ ] **Step 2: Run** `python3 test/test_voice_ui.py && python3 test/test_touch_ui.py`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bash test/run.sh`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dial): talk to a Swarm's Lead on this computer`.

### Task 8: Build, renders against the mockup, real device

- [ ] **Step 1:** `cd devices/harness-device/firmware && . ~/esp/esp-idf-5.5.4/export.sh && idf.py -B build -DPROJECT_VER=0.0.99 build`. Expected: the image fits its OTA slot. Record the size against `main` (PSRAM model ≈ 54 KB; no internal-RAM growth expected; check `ram_telemetry` in the alive log).
- [ ] **Step 2:** Render every portrait with `HABITAT_PREVIEW_DIR`. Check by script that no pixel brighter than 16 lies outside r 233 (the mockup's check). Compare all 27 screens side by side with the mockup, and list each difference in the PR.
- [ ] **Step 3:** Independent code review of the whole branch by a fresh reviewer; fix the findings, each with a test.
- [ ] **Step 4 (owner's go-ahead):**
  - `make install-cli` from the branch;
  - flash the 0.0.99 build on one round dial (`idf.py -p PORT flash`, README "Build and flash your board"; quit the monitor before the app reconnects);
  - with the "openharness" Swarm, check TABS, an unopened Swarm, swipes, PANES, a remote Lead's beep and entry, a local Lead's wait, talk, follow-the-desktop, and the side button.
- [ ] **Step 5 (owner's go-ahead):** commit, push, open the PR listing every check below and the device check.

## Validation (docs/validation-and-release.md)

- **PR CI** (automatic): `cli-typecheck` + `cli-tests` for `cli/`; `firmware-checks` for `devices/` (every `test_*.py` plus `run.sh` on Linux with clang-18 and the SDK's cJSON); `pro-firmware-build` + `pro-golden` because Task 1 touches `devices/harness-pro/` (a test and a doc only; the golden diff must be empty).
- **Local, recorded in the PR:**
  - `npx vitest run src/superTabs src/cable` and `npm run typecheck`;
  - `bash test/run.sh` with `IDF_PATH` set (the cJSON tests run only then);
  - the IDF build;
  - the Pro's `bash test/run.sh`.
  - Not needed: `test:core` (no `src/core`/`src/services` change), CLI e2e (no CLI user flow changes), the OS workflows.
- **Not covered by any automatic check:** the 27 renders against the mockup (by eye) and the real device. Say so in the PR.

## Rollout

1. **CLI first.** The CLI release carries `order`. The firmware works with a CLI from #1537 on, but the panes come in urgency order until this one lands. An older dial is unaffected: it names neither capability.
2. **Firmware next:** `make upload-circle` (`devices/harness-device/firmware/RELEASE.md`). Daemons offer it over the cable from the published manifest (`cli/src/cable/fwPush.ts`, key `commander`). Choose the version above the published one: `version.txt` on main reads 0.0.86, but 0.0.92 was reported published on 2026-10-20, so read the manifest first.
3. **Pro:** nothing to release. Its firmware ignores `order`.
4. **Rollback:** republish the previous round image. The daemon change is additive.

## Open risks

- **The `order` field's value.** The Pro already sorts Leads on the device (`ph_overview.c` `lead_order`), so sending Leads in project order would have served both dials without a new field. The owner chose `order`, so this plan uses it.
- **Worker waits.** A Super Tab wait from a worker on this machine adds no entry of its own; it surfaces through its project's Lead (spec §5). This interpretation needs the owner's confirmation.
- **Recap loading.** The face shows no card while a recap loads; the mockup has no screen for that moment.
- **State lag.** Lead states come from the daemon's 5 s backend poll, so a beep can trail the desktop by up to about 5 s plus the 300 ms debounce.
- **Unverified items** in the spec's "Unverified" section:
  - voice to a harness outside the dial's roster;
  - `dial_super_tab` for a Swarm never opened on the desktop;
  - a Swarm desk tab reporting 0 agents.
