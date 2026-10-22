# Harness Pro Swarm Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Swarm reads "N workspaces" on the Pro with its project Leads as pets; a Lead opens on its last Swarm-chat message; the Pro follows the desktop's open project and picking a Lead on the Pro opens it on the desktop.

**Architecture:** The superTabs service reads the account's Swarms from the backend (revision-gated, only while a capable Pro is attached) and hands the core a list of Swarm cards; the core forwards it to the devices process, which sends new capability-gated cable frames to the Pro. The Pro draws a Working-style Swarm card and a Lead recap view, asks for a Lead's last message on demand, and reports selections back up to the desktop as `dial_super_tab`.

**Tech Stack:** TypeScript (cli, vitest), Dart/Flutter (desktop), C on ESP-IDF 5.5.4 (devices/harness-pro/firmware, host tests + goldens).

**Spec:** `docs/plans/2026-10-22-pro-swarm-card-design.md`

## Global Constraints

- Pro hello capability: `"swarmCard":"v1"`; no new frame reaches a device that does not send it (round dial, older Pro firmware unchanged).
- Limits: at most 16 Swarms, 12 Leads per Swarm; names cut to 48 bytes; recap `text` cut to 1,500 bytes on a UTF-8 boundary.
- Backend poll every 5 s, detail read only when a tab's `revision` changed; no polling while no capable device is attached.
- Lead status order: needs you (`needs_human`) > stuck (`blocked`) > working (local Lead in a turn, or any assignment `working`/`review`) > done.
- Last message = newest message in the Lead conversation whose `author.id` is the Lead and that has no `source`.
- On-device copy (English, naming doc): "workspaces", "working · m:ss", "needs you", "stuck", "done", "Lead", "No message yet", "…".
- Colours: Swarm card gradient `#6A4BB0 → #22163F`; status green `#3EE05B`, orange `#FFC796`, red `#FFB0B0`, grey `#FFFFFF` at 60 %.
- Repo rules: work in the `feat/pro-swarm-card` worktree; commit/push only when the owner authorizes; match surrounding style and comment density.

## Review Focus

- A Swarm whose Lead runs on another person's machine: card and recap work, no talk control, owner name shown (Task 1, Task 7 tests).
- Desktop closed or never opened the Swarm: cards still appear (no `tab` link), no focus frames, select still sends `dial_super_tab` harmlessly (Task 3, Task 6 tests).
- Backend error mid-session (network drop, 401 on one tab): last cards kept, only the failing tab dropped on 401/403 (Task 1 tests).
- Pro relinks after a lost frame: `supertabs` resent on attach/resync, open recap re-requested (Task 3, Task 7 tests).
- Echo loop: a device-made selection must not come back as `supertab.focus` and bounce (Task 3, Task 4 tests).

---

### Task 1: SwarmCards reader in the superTabs service

**Files:**
- Create: `cli/src/superTabs/cards.ts`, `cli/src/superTabs/cards.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type LeadState = 'ask' | 'stuck' | 'work' | 'done'
  export interface SwarmLead { id: string; projectId: string; project: string; engine: string; owner: string; local: string; state: LeadState; since?: number }
  export interface SwarmCard { id: string; name: string; count: number; leads: SwarmLead[] }
  export interface LeadRecap { tabId: string; leadId: string; text: string; at: number; none: boolean }
  export function leadsOf(state: Json, machineId: string, live: (harnessId: string) => { inTurn: boolean; since?: number } | null, me?: string): { count: number; leads: SwarmLead[] }   // me: the signed-in account id; owner is the machine owner's email
  export function lastLeadMessage(messages: Json[], leadId: string): { text: string; at: number } | null
  export class SwarmCards {
    constructor(core: CoreApi, machineId: string, options?: { now?: () => number; intervalMs?: number })
    want(on: boolean): void            // start/stop the 5 s poll
    tick(): Promise<void>             // one poll (tests call it directly)
    recap(tabId: string, leadId: string): Promise<LeadRecap>
    open(tabId: string, leadId: string | null): void   // the recap on the Pro, for pushes
    onCards?: (cards: SwarmCard[]) => void
    onRecap?: (recap: LeadRecap) => void
  }
  ```
- Consumes: `backend(core, method, path)` from `cli/src/superTabs/host.ts`.

- [ ] **Step 1: Write the failing tests** in `cards.spec.ts`:
  - `leadsOf` picks one Lead per project via `conversations[leadConversationId].leadId`; an old tab without `projects` uses the `lead` project; a project with no Lead agent is skipped and not counted.
  - status: project with a `needs_human` assignment → `ask`; `blocked` → `stuck` (ask wins over stuck); local Lead with `live().inTurn` → `work` with `since`; remote Lead with an assignment `working` → `work` without `since`; otherwise `done`.
  - `local` is the harnessId only when `agent.machineId === machineId` and `live()` is non-null; `owner` is the owner's name from `people[]` only for a Lead whose `machineOwnerId` is not the signed-in person.
  - order ask, stuck, work, done, ties in project order; 13 projects → 12 leads, `count` 13; names cut to 48 bytes on a UTF-8 boundary.
  - `lastLeadMessage` skips rows with `source` and rows by other authors, returns the newest; null when none.
  - `tick`: first call lists (`GET /api/super-tabs`, following `next`) and reads every tab; a second call with unchanged revisions reads no tab; a changed revision reads only that tab; a tab gone from the list disappears; a thrown list read keeps the last cards and calls `onCards` not at all; a 403 on one tab drops only that tab. More than 16 tabs → first 16.
  - `recap`: reads the newest page, falls back one page with `before` when the Lead has no row there, returns `none: true` after that; a second call with the same `lastMessageSequence` makes no request; text cut at 1,500 bytes.
  - `open` + a later `tick` where the open Lead's conversation advanced → `onRecap` fires once with the new text.
  - a paused tab keeps its card and every Lead reads `done`.
  - `want(false)` clears the interval; no request after it.

- [ ] **Step 2: Run** `cd cli && npx vitest run src/superTabs/cards.spec.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `cards.ts`.** Person identity (no `asAgentId`). Cache per tab `{ revision, state }` and per Lead `{ sequence, recap }` keyed by `lastMessageSequence` of the Lead conversation. Emit `onCards` only when the serialized list changed.

- [ ] **Step 4: Run** the spec again — Expected: PASS.

- [ ] **Step 5: Commit** `feat(super-tabs): read Swarm cards for the Harness Pro`.

### Task 2: Bridge service ↔ core ↔ devices

**Files:**
- Modify: `cli/src/core/api.ts` (`SuperTabsCore` near :1165, `DevicesPort` near :1204, `DEVICES_FALLBACKS`, `DEVICE_WINDOW_FRAMES` :1205), `cli/src/core/experimentQueries.ts` (QUERIES :37, switch near :123), `cli/src/services/processCoreApi.ts` (:239), `cli/src/core/main.ts` (:814 and the device attach replay near :891), `cli/src/services/devicesProcess.ts`, `cli/src/superTabs/service.ts`, `cli/src/testing/fakeCore.ts`
- Create: `cli/src/core/superTabCards.ts`, `cli/src/core/superTabCards.spec.ts`
- Test: `cli/src/services/processCoreApi.spec.ts`, `cli/src/superTabs/service.spec.ts`

**Interfaces:**
- Consumes: `SwarmCards`, `SwarmCard`, `LeadRecap` (Task 1).
- Produces:
  - `SuperTabsCore.cards(items: SwarmCard[]): void`, `SuperTabsCore.cardRecap(recap: LeadRecap): void` (service → core; queries `super_tab_cards`, `super_tab_card_recap`, superTabs service only).
  - `DevicesPort.swarmCards(items: SwarmCard[]): void`, `DevicesPort.swarmCardRecap(recap: LeadRecap): void` (core → devices; last list replayed on attach).
  - Service requests from the devices (through the core): `super_tabs { action: 'cardsWanted', on: boolean }`, `{ action: 'cardRecap', tabId, leadId }` → `LeadRecap`, `{ action: 'cardOpen', tabId, leadId: string | null }`.
  - `'dial_super_tab'` added to `DEVICE_WINDOW_FRAMES`.

- [ ] **Step 1: Write failing tests:** `superTabCards.spec.ts` — the core keeps the last list, forwards each list and recap to `devices`, replays the list on attach, validates items (ids `[A-Za-z0-9_-]{1,64}`, ≤16 cards, ≤12 leads, strings cut) and drops a malformed list; `processCoreApi.spec.ts` — `cards`/`cardRecap` map to the two queries; `service.spec.ts` — `cardsWanted` starts/stops `SwarmCards`, `cardRecap` returns its result, `cardOpen` calls `open`, all refused for a non-owner asker like other actions.
- [ ] **Step 2: Run** `npx vitest run src/core/superTabCards.spec.ts src/services/processCoreApi.spec.ts src/superTabs/service.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** following `core/superTabAttention.ts` and its wiring (`main.ts` :814, query list, `processCoreApi` :239, fake core).
- [ ] **Step 4: Run** the specs, then `npm run typecheck` and `npm run test:core` — Expected: PASS, coverage 100 %.
- [ ] **Step 5: Commit** `feat(core): carry Swarm cards from the superTabs service to the devices`.

### Task 3: Cable frames and the desktop link in the daemon

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (hello caps parse; `syncSwarms` area ~2529-2620; inbound switch near `swarm.select` :1298; `followApp` near :1263), `cli/src/cable/cableHost.ts`, `cli/src/services/devices.ts` (`swarms()` :460, `appFocus` :471, request routing), `cli/src/localWsServer.ts` (`appSwarmsFrom` :231), the `AppSwarms` type (cableSession.ts :252)
- Test: `cli/src/cable/cableSession.spec.ts`, `cli/src/services/devices.spec.ts`, `cli/src/localWsServer.spec.ts`

**Interfaces:**
- Consumes: `DevicesPort.swarmCards/swarmCardRecap` and the `cardsWanted/cardRecap/cardOpen` requests (Task 2).
- Produces (wire, spec §3): out `supertabs` (ids) + `supertab` (one per Swarm), `supertab.recap`, `supertab.focus`; in `supertab.recap.get`, `supertab.open`, `supertab.select`. `AppSwarms` items gain optional `superTabId: string` and `projectId: string`. Window frame `dial_super_tab { superTabId, projectId }`.

- [ ] **Step 1: Write failing tests** in `cableSession.spec.ts`:
  - a device without `swarmCard:"v1"` receives none of the three frames; with it, `supertabs` on attach, after a list change (debounced 300 ms), and on resync; each `item.tab` is the desk tab whose `superTabId` matches, else `""`.
  - a 16×12 list goes as one `supertabs` + 16 `supertab` frames, each under 512 JSON tokens; a change to one Swarm resends only its `supertab`.
  - `supertab.recap.get` → `cardRecap` request → `supertab.recap` frame; `supertab.open` → `cardOpen`; an unsolicited `swarmCardRecap` reaches the device only for the open Lead.
  - the active desk tab being a Swarm with `projectId` → one `supertab.focus` with that project's Lead; unchanged on repeat; none when the desktop has no Swarm tab active.
  - `supertab.select` → window frame `dial_super_tab {superTabId, projectId}`; the next `app_swarms` reporting that same project sends no `supertab.focus` (no echo).
  - `devices.spec.ts`: first capable device attached → `cardsWanted on:true`; last one gone → `on:false`.
  - `localWsServer.spec.ts`: `appSwarmsFrom` keeps `superTabId`/`projectId` (ids validated, dropped when malformed).
- [ ] **Step 2: Run** `npx vitest run src/cable/cableSession.spec.ts src/services/devices.spec.ts src/localWsServer.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the project→Lead map from the last `swarmCards` list to resolve `projectId` ↔ lead id for focus and select.
- [ ] **Step 4: Run** the specs, `npx vitest run src/superTabs src/cable src/services/devices.spec.ts src/architecture.spec.ts`, `npm run typecheck`, `npm run test:core` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cable): Swarm cards, Lead recaps and focus on the Harness Pro`.

### Task 4: Desktop reports the open Swarm project and opens one on request

**Files:**
- Modify: `desktop/lib/state/app_state.dart` (`_announceOpenPanesToDial` :5086-5194; window frame switch near `dial_swarm` :20106), `desktop/lib/super_tabs/controller.dart` (`select` :324)
- Test: `desktop/test/super_tab_dial_test.dart` (new)

**Interfaces:**
- Consumes: window frame `dial_super_tab { superTabId, projectId }` (Task 3).
- Produces: `app_swarms` rows with `superTabId` and `projectId` for `kind == 'superTab'`; `projectId` = `snapshot.projectFor(selectedId)?.id`.

- [ ] **Step 1: Write failing tests:** a Swarm tab row carries `superTabId` and the selected conversation's `projectId`; selecting another project re-announces; `dial_super_tab` for an open Swarm focuses that tab and calls `select(project.leadConversationId)`; for a Swarm not open it opens the tab first; a device-made selection sets a flag so the following announce is tagged and not echoed (assert the announce payload carries `fromDevice: true` once).
- [ ] **Step 2: Run** `cd desktop && flutter test --no-pub test/super_tab_dial_test.dart` — Expected: FAIL.
- [ ] **Step 3: Implement** in `app_state.dart` and `controller.dart`; have the controller notify the app on `select` so the announce runs.
- [ ] **Step 4: Run** the test, `flutter test --no-pub $(ls test/super_tab_*_test.dart test/swarm_*_test.dart)`, `flutter analyze --no-pub lib/super_tabs lib/state/app_state.dart` — Expected: PASS, no issues. (Task 3 then ignores a focus whose announce has `fromDevice: true`: add that case to its echo test if not covered.)
- [ ] **Step 5: Commit** `feat(desktop): tell devices which Swarm project is open; open one a device picks`.

### Task 5: Pro firmware — protocol and model

**Files:**
- Modify: `devices/harness-pro/firmware/main/cable/pro_cable.c` (hello near :224; dispatch; new handlers), `main/cable/cable_types.h`, `main/pro_app_api.h`, `main/app/pro_app.c`, `main/pod/pod_model.h`, `main/pod/pod_model.c`
- Test: `test/test_pro_cable.c`, `test/test_pod_model.c`

**Interfaces:**
- Produces:
  ```c
  enum { SWARMS_CARD_MAX = 16, SWARM_LEADS_MAX = 12, SWARM_TEXT_MAX = 1501 };
  typedef enum { POD_LEAD_ASK, POD_LEAD_STUCK, POD_LEAD_WORK, POD_LEAD_DONE } pod_lead_state_t;
  typedef enum { POD_RECAP_NONE, POD_RECAP_LOADING, POD_RECAP_LOADED, POD_RECAP_EMPTY } pod_recap_state_t;
  typedef struct { char id[ID_MAX], project[49], engine[16], owner[49], local[ID_MAX]; pod_lead_state_t state; uint32_t since_s, since_at_ms;
                   pod_recap_state_t recap; char *text; uint32_t text_at; } pod_lead_t;     // text in PSRAM
  typedef struct { char id[ID_MAX], tab[ID_MAX], name[49]; uint16_t count; uint8_t lead_n; pod_lead_t leads[SWARM_LEADS_MAX]; } pod_swarm_t;
  void pro_app_supertabs(const pod_swarm_t *items, int n);
  void pro_app_supertab_recap(const char *tab, const char *lead, const char *text, uint32_t at, bool none);
  void pro_app_supertab_focus(const char *tab, const char *lead);
  void pro_cable_supertab_send(const char *t, const char *tab, const char *lead);   // "supertab.recap.get" | "supertab.open" | "supertab.select"
  const pod_swarm_t *pod_model_swarm_for_tab(const pod_model_t *, const char *tab_id);   // desk tab → Swarm
  const pod_swarm_t *pod_model_swarm(const pod_model_t *, const char *swarm_id);
  ```
- [ ] **Step 1: Write failing tests:** hello contains `"swarmCard":"v1"`; `supertabs` with 2 Swarms × 3 Leads parses all fields; 20 Swarms → 16; 15 Leads → 12; a 60-byte name cut to 48 on a UTF-8 boundary; unknown `state` → done; a malformed item is skipped, not the frame; `supertab.recap` stores text (1,500-byte cut) and sets LOADED, `none:true` sets EMPTY; a new `supertabs` keeps cached recap text for Leads still present and frees it for Leads gone; `pod_model_swarm_for_tab` matches `tab`.
- [ ] **Step 2: Run** `cd devices/harness-pro/firmware && bash test/run.sh` — Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bash test/run.sh` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(pro): parse Swarm cards and Lead recaps`.

### Task 6: Pro firmware — Swarm card on Home

**Files:**
- Modify: `main/pod/home/ph_overview.c` (`card()` :338, `working_card` :401, `peek`, `ph_view_home`), `main/pod/home/ph.h` (colours), `main/pod/pod_view.c` / `pod_view.h` (home pages), `main/pod/pod_nav.h` (`swarm_page` beside `work_page` :27), `main/app/pod_glue.c` (swipe band :462-476, hits)
- Test: `test/test_ph_views.c`, `test/test_ph_glue.c`, `test/pod_render.c`, `test/golden.sh`, `test/golden.txt`, `test/golden-liberation.txt`

**Interfaces:**
- Consumes: `pod_model_swarm_for_tab`, `pod_model_swarm`, `pod_swarm_t` (Task 5).
- Produces: hit `POD_A_LEAD` (arg = lead index, id = swarm id) on each pet; `nav.swarm_page`; Swarms without a desk tab become extra Home pages after the desk tabs (`pod_home_pages`).

- [ ] **Step 1: Write failing tests:** a desk tab linked to a Swarm draws the Swarm card (title = Swarm name, count = `count`, label "workspaces"); orange dot present iff any Lead is ASK; 3 pets per page centred like Working; 4 Leads → page 2 shows 1 centred; a swipe in y 256-536 pages `swarm_page`, past the last page moves to the next card; status lines "working · 2:14", "needs you", "stuck", "done"; a remote Lead shows its owner line; a Swarm with no desk tab adds a Home page; `POD_A_LEAD` hits over each pet.
- [ ] **Step 2: Add render fixtures** `home:swarm:p1`, `home:swarm:p2`, `home:swarm:remote` to `pod_render.c` and `golden.sh`.
- [ ] **Step 3: Run** `bash test/run.sh` — Expected: FAIL.
- [ ] **Step 4: Implement** by sharing `working_card`'s pet-row drawing (extract `pet_row(...)` used by both) rather than copying it.
- [ ] **Step 5: Regenerate goldens** `bash test/golden.sh && PRO_FONT=fonts/LiberationSans-Regular.ttf bash test/golden.sh`; confirm the diff only adds the new screens; render the three fixtures to PNG and compare with the mockup's A1–A3.
- [ ] **Step 6: Run** `bash test/run.sh`, both `golden.sh --check` runs — Expected: PASS.
- [ ] **Step 7: Commit** `feat(pro): the Swarm card — workspaces and their Leads on Home`.

### Task 7: Pro firmware — Lead recap, follow and select

**Files:**
- Create: `main/pod/home/ph_lead.c`
- Modify: `main/pod/home/ph.h`, `main/pod/pod_view.h` (new view `POD_VIEW_LEAD`), `main/pod/pod_nav.c` (open/follow), `main/app/pod_glue.c` (horizontal swipe on the view, hits, `supertab.focus`), `main/app/pro_app.c`, `devices/harness-pro/docs/cable.md`
- Test: `test/test_ph_views.c`, `test/test_ph_glue.c`, `test/test_pro_app.py`, `test/pod_render.c`, `test/golden.sh`, goldens

**Interfaces:**
- Consumes: `POD_A_LEAD`, `pro_cable_supertab_send`, `pro_app_supertab_recap/_focus` (Tasks 5–6).
- Produces: `void ph_view_lead(pod_out_frame_t *, const pod_nav_t *, pod_model_t *, uint32_t now_ms)`; nav frame fields `swarm` (id) and `lead` (index).

- [ ] **Step 1: Write failing tests:** tapping a Lead pet opens `POD_VIEW_LEAD`, sends `supertab.select`, `supertab.open` and (cache cold) `supertab.recap.get`; LOADING draws "…", LOADED the bubble, EMPTY "No message yet"; header shows the Swarm name and the project; a horizontal swipe moves to the next/previous Lead in card order and sends `supertab.select` + `supertab.open`; leaving the view sends `supertab.open` with no lead; a local Lead's recap offers talk on its `local` harness, a remote one does not; `supertab.focus` opens that Lead's recap (not while talking or updating; pending until the Swarm list has it); the Lead removed while open moves to the next Lead, or Home if none; on relink the open view re-sends `supertab.open` and `supertab.recap.get`.
- [ ] **Step 2: Add render fixtures** `lead:loaded`, `lead:ask`, `lead:loading`, `lead:none`, `lead:remote`.
- [ ] **Step 3: Run** `bash test/run.sh` — Expected: FAIL.
- [ ] **Step 4: Implement** `ph_lead.c` from `ph_recap.c` (bubble, tail, signing pet; ask/stuck edge stripe in orange/red); document the frames in `docs/cable.md` §1–2.
- [ ] **Step 5: Regenerate goldens** (both fonts), compare PNGs with the mockup's B1–B3.
- [ ] **Step 6: Run** `bash test/run.sh`, both golden `--check`, and `. ~/esp/esp-idf-5.5.4/export.sh && idf.py -B build -DPROJECT_VER=0.0.99-ci build` — Expected: PASS, image fits `ota_0`.
- [ ] **Step 7: Commit** `feat(pro): Lead recaps — read, swipe, follow the desktop, pick a project`.

### Task 8: Review, real-device check, PR

- [ ] **Step 1:** Independent code review of the whole branch (fresh reviewer); fix findings with tests.
- [ ] **Step 2:** With the owner's go-ahead: `make install-cli` from the branch, build firmware with `-DPROJECT_VER=0.1.13-swarmcard`, flash unit 64:61 via `scripts/flash.sh` (FLASH_PORT from `ls /dev/cu.usbmodem*`), check the card, swipes, recap, follow and select against the mockup with the "openharness" Swarm.
- [ ] **Step 3:** With the owner's go-ahead: commit, push, open the PR listing every check run (vitest specs, test:core, flutter tests/analyze, firmware run.sh, goldens both fonts, IDF build) and the manual check.
