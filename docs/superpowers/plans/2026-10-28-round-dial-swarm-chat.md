# Round dial: a Swarm is its chats — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The round dial's Swarm tab shows, per project, the chat the person has open (Lead by default, Chat with PM or a
group when the desktop opens one): its last agent message, working only for a working group, and alerts only on new Lead or
PM messages.

**Architecture:**
- The Super Tab service's `SwarmCards` (`cli/src/superTabs/cards.ts`) decides, per Lead:
  - the chat on the face;
  - its kind;
  - whether it works;
  - the newest Lead/PM message since a baseline.
- These ride on `SwarmLead` through the existing cards path.
- `CableSession` gates the new frames on the device's hello `swarmChat: "v1"`. The firmware draws them.
- The desktop tells the daemon which conversation is open.

**Tech Stack:** TypeScript (CLI, vitest), Dart/Flutter (Desktop), C on ESP-IDF 5.5 with Python host tests (round firmware).

**Spec:** `docs/superpowers/specs/2026-10-28-round-dial-swarm-chat-design.md`

## Global Constraints

- New behaviour only for a device whose hello has `swarmChat: "v1"`. Every other device (the Pro, round ≤ 0.0.94) gets
  byte-identical frames to today.
- Chat kinds:
  - `lead`: `project.leadConversationId`;
  - `pm`: a conversation with `audience` whose project is this one;
  - `group`: any other conversation of the project.
- `state` for a `swarmChat` device is `work` only for a `group` chat whose `assignment.status === 'working'`, else
  `done`. It is never `ask` or `stuck`.
- Recap and notice text: the newest message whose `source` is null and whose `author.id` is an agent of the chat:
  - the Lead for `lead`/`pm`;
  - the group's `agentIds` for `group`.
- Alerts only for the Lead conversation and the Chat with PM, only for messages written by the project's Lead agent. Group
  messages never alert.
- Baseline: messages at or before the first sequence seen after the service starts, or when a device attaches, never
  alert.
- Names are cut to 48 bytes (`NAME_BYTES`), texts to 1500 bytes (`RECAP_BYTES` / `truncateUtf8(…, 1500)`), and ids are
  checked with `CARD_ID` / `cardId`.
- A Lead's own terminal question (the `question` frame with `superTab`) still alerts on the dial.
- Firmware dev builds are `-DPROJECT_VER=0.0.99`. Flash only with Diego's yes, naming MAC `28:84:85:90:63:E8` and the build.
  Never upload firmware or touch the OTA manifest.
- Verified on 2026-10-28 (spec's first Unverified line): Chat with PM messages carry `author: {kind: 'agent', id: <Lead
  agent id>}` and `source: null`, the same shape as the Lead conversation.

## Review Focus

1. **A device re-attaches or the daemon restarts while a Lead notice is in the cards.** The cards replay must not beep
   again. Tested in Task 3: `replays a held notice without sending it`.
2. **Two Lead messages land between two tab reads.** One notice for the newest, not two beeps. A failed page read must
   not advance the baseline, so the next move retries. Tested in Task 1: `one notice for the newest of two messages` and
   `a failed read keeps the baseline`.
3. **The desktop already has the PM chat open when the PM writes.** No beep: the notice is not sent, or is read at once.
   Tested in Task 3: `does not send a notice for the chat the desktop has open`.
4. **The desktop opens a conversation of another project or another Swarm, or one that is archived.** That project's
   face stays on its Lead chat, and a recap for the old chat is dropped by the dial. Tested in Task 1
   (`ignores a focus outside the project`) and Task 5 (`drops a recap for another chat`).
5. **An old dial or the Pro next to a new daemon.** Frames are byte-identical to today, the Pro's recap is still the
   Lead conversation, and talk still goes to the Lead conversation. Tested in Task 3: `a device without swarmChat gets
   today's frames`.

---

### Task 1: SwarmCards picks each project's chat, its recap and its Lead/PM notice

**Files:**
- Modify:
  - `cli/src/core/api.ts:1218-1225` (types)
  - `cli/src/superTabs/cards.ts` (`leadsOf`, `lastLeadMessage`, `SwarmCards.want/recap/open/say`, a notice watcher)
  - `cli/src/superTabs/inCore/cards.ts` (validate the new fields)
- Test: `cli/src/superTabs/cards.spec.ts`, `cli/src/superTabs/inCore/cards.spec.ts`

**Interfaces:**
- Produces (in `core/api.ts`):
  ```ts
  export type ChatKind = 'lead' | 'pm' | 'group'
  export interface SwarmChat { kind: ChatKind; id: string; name: string; working: boolean; since?: number }
  export interface LeadNotice { chat: 'lead' | 'pm'; chatId: string; id: string; text: string; at: number }
  // SwarmLead gains:  chat?: SwarmChat; notice?: LeadNotice
  // LeadRecap gains:  chatId?: string
  export interface CardFocus { tabId: string; conversationId: string }
  ```
- Produces (in `cards.ts`):
  - `leadsOf(state, machineId, live, me?, focus?: string)`. `focus` is the conversation the window has open in this tab.
    Every Lead gets `chat`. `state` keeps today's meaning, for old devices.
  - `lastAgentMessage(messages: Json[], agentIds: ReadonlySet<string>): { text: string; at: number; id: string; sequence: number } | null`.
    It replaces `lastLeadMessage`, whose callers pass `new Set([leadId])`.
  - `SwarmCards`:
    - `want(on: boolean, include?: string[], focus?: CardFocus | null): void`. A focus change rebuilds the cards at once.
    - `recap(tabId, leadId, chat = false): Promise<LeadRecap>`. With `chat`, it reads the face chat with its agents and
      returns `chatId`.
    - `open(session, tabId, leadId, chat = false)`. With `chat`, it watches the face chat's sequence.
    - `say(harnessId, text, chat = false)`. With `chat`, it posts to the face chat's id.

- [ ] **Step 1: Write the failing tests** in `cards.spec.ts`:
  - `leadsOf` (in `describe('leadsOf chats')`):
    - `opens each project on its Lead chat`: `chat` is `{kind:'lead', id: leadConversationId, name:'Lead', working:false}`.
    - `follows the window to the project's Chat with PM`: focus = the audience conversation, giving `{kind:'pm', name:'PM'}`.
    - `follows the window to a group`: `{kind:'group', name: <group title cut to 48 bytes>}`.
      `working` is true only when that group's `assignment.status === 'working'`, and `since` comes from a live turn of
      one of its agents here.
    - `ignores a focus outside the project`: a conversation of another project, an unknown id, or an archived group leaves
      the Lead chat.
  - `lastAgentMessage`: `takes the newest row by any of the chat's agents, skipping the person and source rows`.
  - `SwarmCards` notices (use the existing fake backend and tab reads):
    - `records a baseline on the first read and sends no notice`.
    - `notices a new Lead message in the Lead conversation`, giving `notice = {chat:'lead', chatId, id, text, at}`.
    - `notices a new Lead message in Chat with PM`, giving `{chat:'pm', …}`.
    - `never notices a group message, the person's message or a system row`.
    - `one notice for the newest of two messages`.
    - `a failed read keeps the baseline`: the read throws, then the next move notices the message.
  - `SwarmCards` recap:
    - `recap with chat reads the face chat and names its chatId`;
    - `recap without chat is today's Lead recap`.
  - `SwarmCards` say: `say with chat posts message.send to the face chat`.
  - In `inCore/cards.spec.ts`: `keeps a sound chat and notice, drops a malformed one`. Bad kind, non-id `chatId`, and
    over-long text are cut or dropped, and the Lead is kept without them.

- [ ] **Step 2: Run to verify they fail**

  Run: `cd cli && npx vitest run src/superTabs/cards.spec.ts src/superTabs/inCore/cards.spec.ts`
  Expected: FAIL (no `chat`/`notice`, `lastAgentMessage` undefined).

- [ ] **Step 3: Implement the types, `leadsOf` chat selection, `lastAgentMessage`, and the notice watcher**
  - Notice watcher: `SwarmCards` keeps `seen: Map<conversationId, sequence>` and `notices: Map<leadKey, LeadNotice>`
    (lead key `${tabId}:${leadId}`).
  - On each tab read, for each project's Lead conversation and PM chat, `lastMessageSequence > seen` triggers one page
    read, under the `MAX_RECAPS_IN_FLIGHT` limit, taking the newest Lead-written message after `seen`.
  - It sets `notices` and advances `seen` only after a successful read. A first sight sets `seen` without reading.
  - Clear both maps when the account changes (where `recaps.clear()` is today). Drop a tab's entries when it leaves the
    cards.
  - `leadsOf` callers attach `notice` from `notices`.

- [ ] **Step 4: Run to verify they pass**

  Run: `cd cli && npx vitest run src/superTabs && npx tsc --noEmit -p .`
  Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

  `git add cli/src/core/api.ts cli/src/superTabs/cards.ts cli/src/superTabs/cards.spec.ts cli/src/superTabs/inCore/cards.ts cli/src/superTabs/inCore/cards.spec.ts`
  `git commit -m "feat(swarm): cards carry each project's chat on the face and the Lead's newest message as a notice"`

### Task 2: The window's open conversation reaches SwarmCards, and the chat flags reach the service

**Files:**
- Modify:
  - `cli/src/localWsServer.ts:234-262` (`appSwarmsFrom`: `conversationId`)
  - `cli/src/cable/cableSession.ts:274` (`AppSwarms` row type)
  - `cli/src/cable/cableHost.ts`:
    - `activeSwarmProject()` adds `conversationId?`;
    - `swarmCardRecap`, `swarmCardOpen` and `swarmSay` take `chat = false`.
  - `cli/src/services/devices.ts:170, 226-233, 490-500`:
    - `tellCards` sends `focus`;
    - the `swarms` handler re-tells on a focus change;
    - the chat flags are passed on.
  - `cli/src/core/devicesLink.ts:126-131`: pass `focus` and `chat`.
  - `cli/src/superTabs/service.ts:348-362`: read `focus` (both ids `cardId`) and `chat === true`.
- Test: `cli/src/localWsServer.spec.ts`, `cli/src/services/devices.spec.ts` (or the existing devices-wiring spec), `cli/src/superTabs/service.spec.ts`

**Interfaces:**
- Consumes: `CardFocus`, `SwarmCards.want/recap/open/say` (Task 1).
- Produces:
  - `DaemonCableHost.activeSwarmProject(): { superTabId; projectId; conversationId?; fromDevice } | null`;
  - `swarmCardRecap(tabId, leadId, chat?: boolean)`, `swarmCardOpen(session, tabId, leadId, chat?: boolean)`,
    `swarmSay(harnessId, text, chat?: boolean)`;
  - service actions `cardsWanted {on, include, focus?}`, `cardRecap {…, chat?}`, `cardOpen {…, chat?}`,
    `cardSay {…, chat?}`.

- [ ] **Step 1: Write the failing tests**
  - `localWsServer.spec.ts`: `app_swarms keeps a Swarm tab's conversationId, and drops one that is not an id`.
  - Devices spec: `tells the cards the window's open Swarm conversation, again only when it changes`.
  - `service.spec.ts`: `cardsWanted passes focus to the cards; cardRecap, cardOpen and cardSay pass chat`.

- [ ] **Step 2: Run to verify they fail**

  Run: `cd cli && npx vitest run src/localWsServer.spec.ts src/superTabs/service.spec.ts <devices spec>`
  Expected: FAIL.

- [ ] **Step 3: Implement the field and the pass-through.**
  `focus` is `{tabId: superTabId, conversationId}` of the window's active Swarm tab, or null when the active tab is not
  a Swarm or names no conversation.

- [ ] **Step 4: Run to verify they pass**

  Run: same command, then `npx tsc --noEmit -p .`
  Expected: PASS, clean.

- [ ] **Step 5: Commit** — `feat(swarm): the window's open Swarm conversation reaches the cards; the dial's chat flag reaches the service`

### Task 3: CableSession speaks `swarmChat: "v1"`

**Files:**
- Modify: `cli/src/cable/cableSession.ts`:
  - hello parsing, around 1240: `this.swarmChat = str('swarmChat') === 'v1'`, reset with the others at 684;
  - `pushSwarmCards`, around 2648;
  - `onSuperTab` recap/open, around 2720-2750;
  - `swarmCardRecap`, around 2714;
  - the talk path that calls `host.swarmSay`.
- Test: `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Consumes: `SwarmLead.chat/notice`, the chat flags (Tasks 1–2).
- Produces, the wire for a `swarmChat` device:
  - `supertab` lead entries add `chat`, `chatId` and `chatName`; `state` is `chat.working ? 'work' : 'done'`, and `since`
    is `chat.since` (or none).
  - `supertab.recap` adds `chatId`.
  - New frame `supertab.notice {tab, lead, chat, chatId, id, text, at}`.
  - New frame `supertab.notice.read {tab, lead, chatId}`.

- [ ] **Step 1: Write the failing tests** in `describe('swarmChat')`:
  - `a device without swarmChat gets today's frames`: same `supertab` bytes as before for a card with `chat`/`notice`
    set. The recap is requested without `chat`, and talk without `chat`.
  - `a swarmChat device gets chat, chatId, chatName and work only for a working group`.
  - `sends a notice once per id`.
  - `replays a held notice without sending it`: attach, or a forced cards push, with a notice already present sends
    nothing. A later new id is sent.
  - `does not send a notice for the chat the desktop has open`: the active `conversationId` equals `notice.chatId`.
  - `sends notice.read when the desktop opens a chat with a sent notice`.
  - `asks recaps and talks with chat, and passes chatId on the recap`.
  - The frame size: `12 Leads with chats stay under the device's 512-token guard`. Count tokens as the existing guard
    test does.

- [ ] **Step 2: Run to verify they fail**

  Run: `cd cli && npx vitest run src/cable/cableSession.spec.ts -t swarmChat`
  Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Keep per session `sentNotices: Map<leadKey, noticeId>`. On attach and on `force`, fill it from the current cards
    without sending.
  - The notice-read check runs in `pushSwarmCards` against `host.activeSwarmProject()?.conversationId`.

- [ ] **Step 4: Run to verify they pass**

  Run: `cd cli && npx vitest run src/cable src/superTabs && npx tsc --noEmit -p .`
  Expected: PASS, clean.

- [ ] **Step 5: Commit** — `feat(cable): swarmChat devices get the chat on the face, Lead/PM notices and chat recaps`

### Task 4: Desktop announces the open Swarm conversation

**Files:**
- Modify: `desktop/lib/state/app_state.dart`:
  - `_announceOpenPanesToDial` swarm rows, around 5660-5700: add `conversationId`;
  - the #1911 re-announce listener: also fire when the selected conversation changes.
- Test: `desktop/test/super_tab_dial_test.dart`

**Interfaces:**
- Produces: the `app_swarms` row field `conversationId`. It is the controller's `selectedId` when
  `snapshot.conversation(selectedId) != null`, else absent.

- [ ] **Step 1: Write the failing tests**
  - `a Swarm tab announces the open conversation's id`: the Lead conversation, then the PM chat, then a group.
  - `selecting another conversation re-announces`.
  - `a decisions view or an unloaded Swarm leaves conversationId out`.

- [ ] **Step 2: Run to verify they fail**

  Run: `cd desktop && flutter test test/super_tab_dial_test.dart`
  Expected: FAIL.

- [ ] **Step 3: Implement** next to the existing `projectId` line, with the same `superTabs.peek(tabId)` guard.

- [ ] **Step 4: Run to verify they pass**

  Run: `cd desktop && flutter test test/super_tab_dial_test.dart && flutter analyze lib/state/app_state.dart`
  Expected: PASS, no issues. `dart format` on the touched files only.

- [ ] **Step 5: Commit** — `feat(desktop): tell the dial which Swarm conversation is open`

### Task 5: Firmware model and cable: parse the chat, the chat recap and the notices

**Files:**
- Modify:
  - `devices/harness-device/firmware/main/ui/habitat/supertab.h:14-40`:
    - `typedef enum { HT_CHAT_LEAD, HT_CHAT_PM, HT_CHAT_GROUP } ht_chat_kind_t;`
    - `ht_lead_t` adds `ht_chat_kind_t chat`, `chat_id[ID_MAX]` and
      `chat_name[HT_SUPERTAB_NAME]`;
    - `ht_lead_in_t` adds `chat`, `chat_id` and `chat_name`;
    - the recap struct adds `chat_id[ID_MAX]`.
  - `supertab.c`: copy the fields in `ht_supertab_lead_add`/`ht_supertabs_put`. `ht_supertabs_recap_put` takes `chat_id`
    and drops a recap whose `chat_id` differs from the face Lead's.
  - `main/cable_client.c`:
    - hello `msg_string(&root, "swarmChat", "v1")` beside line 323;
    - `handle_supertab` reads `chat`/`chatId`/`chatName`;
    - `handle_supertab_recap` reads `chatId`;
    - new `handle_supertab_notice` and `handle_supertab_notice_read`, registered beside line 1375, calling
      `ui_supertab_notice` and `ui_supertab_notice_read`.
  - `main/cable_client.h`: declare the two `ui_` functions next to `ui_supertab_focus`.
- Test: `devices/harness-device/firmware/test/test_supertab.c`, `test/test_cable_supertab.py`

**Interfaces:**
- Produces (C):
  ```c
  void ui_supertab_notice(const char *tab, const char *lead, ht_chat_kind_t chat, const char *chat_id, const char *text, uint32_t at);
  void ui_supertab_notice_read(const char *tab, const char *lead, const char *chat_id);
  ```
  - A missing `chat` means `HT_CHAT_LEAD`, `chat_id` "" and `chat_name` "", for frames from an old daemon.

- [ ] **Step 1: Write the failing tests**
  - `test_supertab.c`:
    - `lead keeps chat, chat_id, chat_name`;
    - `drops a recap for another chat`;
    - `a lead without chat fields reads as the Lead chat`.
  - `test_cable_supertab.py`:
    - `hello says swarmChat v1`;
    - `supertab with chat fields parses`;
    - `supertab.notice and supertab.notice.read reach the ui calls with their fields`;
    - `a notice with a non-id chatId or no lead is ignored`.

- [ ] **Step 2: Run to verify they fail**

  Run: `source ~/esp/esp-idf/export.sh && make device-test`
  Expected: the new cases FAIL.

- [ ] **Step 3: Implement the fields, parsing and handlers.** The `ui_` bodies land in Task 6. Here, a weak stub in the
  test harness records the calls.

- [ ] **Step 4: Run to verify they pass**

  Run: `make device-test`
  Expected: all PASS.

- [ ] **Step 5: Commit** — `feat(dial): parse a Lead's chat, chat recaps and Lead/PM notices; say swarmChat v1`

### Task 6: Firmware face and alerts follow the chat

**Files:**
- Mockup first, not committed: `devices/harness-device/mockup/swarm-chat.html` in the **main checkout** (gitignored).
  - It shows the face for a Lead chat, a PM chat, a long group name and a working group.
  - Open it with `open`, and get Diego's OK on how the chat name sits under the project before coding.
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c`:
  - `render_swarm_face` (~1290);
  - `swarm_notice_raise`/`swarm_notice_drop` (~4892-4930);
  - `ui_supertab_wait_close` (~5051);
  - new `ui_supertab_notice` and `ui_supertab_notice_read` after `ui_supertab_focus` (~5005).
- Test: `devices/harness-device/firmware/test/test_touch_ui.py` (add the two functions to its lifted list at line 238)

**Interfaces:**
- Consumes: the `ht_lead_t` chat fields and the two `ui_` declarations (Task 5).

**Behaviour:**
- Face:
  - The chat name is drawn under the project on the upper arc when `chat != HT_CHAT_LEAD`.
  - The recap shows whenever it is loaded for the face's `chat_id`.
  - The working pet and clock show only when `l->state == HT_LEAD_WORK`.
  - `asking` comes only from an open wait.
- Alerts:
  - `ui_supertab_notice` raises the Lead's single entry with the text as its body. The grey line is the Swarm name,
    plus " · PM" for `HT_CHAT_PM`.
  - It beeps and wakes with the existing coalescing.
  - It is read at once only when `on_face(lead)` and the face Lead's `chat_id` equals the notice's.
  - A newer notice replaces the text and marks the entry unread.
  - `ui_supertab_notice_read` removes the entry when its `chat_id` matches.
- `ui_supertab_wait_close`: when the Lead's state is not `ask`/`stuck`, which is always the case with a `swarmChat`
  daemon, the entry is dropped, as the `else` branch already does. Check that no change is needed there and add the test.

- [ ] **Step 1: Write the failing tests** in `test_touch_ui.py`:
  - `swarm face shows PM under the project and the recap, no working`;
  - `a working group shows the working pet`, `a done group shows its recap`;
  - `notice for the face's chat is read at once and does not beep`;
  - `notice for another chat stays unread and beeps once`;
  - `notice.read removes the entry`;
  - `a second notice replaces the text and is unread again`;
  - `a Lead wait still raises its entry`;
  - `no entry from a lead state change when chats are on`.

- [ ] **Step 2: Run to verify they fail**

  Run: `make device-test`
  Expected: the new cases FAIL.

- [ ] **Step 3: Implement** as described under Behaviour.

- [ ] **Step 4: Run to verify they pass, and build**

  Run: `make device-test`, then
  `idf.py -C devices/harness-device/firmware -B build-dev99 -DIDF_TARGET=esp32s3 -DSDKCONFIG=build-dev99/sdkconfig.dev -DDEVICE_FORCE_PROD=1 -DPROJECT_VER=0.0.99 build`
  Expected: all PASS; build succeeds.

- [ ] **Step 5: Commit** — `feat(dial): the Swarm face shows the open chat; alerts come from Lead/PM notices`

### Task 7: Real check on Diego's round, and the docs

**Files:**
- Modify:
  - `docs/superpowers/specs/2026-10-23-round-swarm-tab-design.md`: a short note at §4/§5 pointing to the new spec for
    `swarmChat` devices;
  - `docs/swarms.md`: the device part, if it describes dial alerts.

- [ ] **Step 1:** Run the CLI from this branch on Diego's Mac only with his yes (`make install-cli`, without
  `--no-updates`). Or wait for the release that carries Tasks 1–3.
- [ ] **Step 2:** Ask Diego, naming MAC `28:84:85:90:63:E8` and the build (0.0.99 from this branch's HEAD). On his yes,
  flash with the round procedure:
  1. quit the app;
  2. write the flasher flag;
  3. `harness stop`;
  4. `idf.py -p /dev/cu.usbmodem21301 flash`;
  5. remove the flag;
  6. `harness start`;
  7. reopen the app.

  Check that the log shows `on fw 0.0.99` with `swarmChat`.
- [ ] **Step 3:** Diego's checks:
  1. Swipe between projects: each opens on its Lead.
  2. Open Chat with PM, then a group, on the desktop: the dial follows.
  3. A working group shows working; the Lead chat never does.
  4. A new PM message alerts once; a group message does not.

  Read the daemon log lines for each.
- [ ] **Step 4: Commit** the docs: `docs: the round Swarm tab follows the chat for swarmChat devices`.
