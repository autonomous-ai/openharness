# Harness Pro: the Swarm card and its Leads

Status: design approved in the Lead chat on 2026-10-22 (questions 1–5 and design parts 1–4). Mockup: `devices/harness-pro/mockup/pro-supertab/swarm-card.html` (v2, gitignored).

## Problem

A Swarm (Super Tab) tab reaches the Pro as an ordinary desktop tab: the desktop reports its terminal panes, which is only the Lead of the
selected project, so the Pro's card for the Swarm "openharness" reads "1 agent". The Pro cannot see the Swarm's projects, their Leads, what a
Lead last said, or which project the desktop has open, and it cannot follow a Lead that runs on another person's machine.

## Goal

On the Pro, a Swarm is a card that reads "N workspaces" and shows each project's Lead the way the Working card shows working agents. A Lead
opens on a recap of its last message in the Swarm chat. The Pro follows the project the desktop has open, and picking a Lead on the Pro opens
that project on the desktop. Display only, apart from talking to a Lead that runs on this computer (as with any local agent).

Out of scope: answering or posting into the Swarm chat from the Pro; showing workgroups (non-Lead agents); the round dial.

## Decisions (owner's answers)

1. **Last message** = the newest message the Lead itself posted in its project's Lead conversation, not the terminal turn summary. Automated
   rows (any message with a `source`) are skipped.
2. **Lead status** is combined, in this order: any assignment in the project is `needs_human` → **needs you**; any is `blocked` → **stuck**;
   the Lead's harness is in a turn (local Leads only) or any assignment in the project is `working`/`review` → **working**; else **done**.
3. **Source**: the daemon reads the Swarms from the backend itself, so the Pro is right while the desktop is closed. The desktop only says
   which Swarm and project it has open.
4. **Leads on other people's machines** show like any Lead and open their recap; the owner's name is shown under the status; no talk.
5. **Two-way**: the Pro follows the desktop's open project, and picking a Lead on the Pro opens that Swarm tab and project on the desktop.
6. Approach A: a separate Swarm channel on the cable (not extra fields in the `swarms` frame, which is near its size budget).

## Design

### 1. Daemon: reading the Swarms (superTabs service)

A new `SwarmCards` unit in the superTabs service process (`cli/src/superTabs/cards.ts`).

- **Runs only while a device that asked for Swarm cards is attached** (the core tells the service; see §3). Stopped otherwise: no backend
  traffic without a Pro.
- Every 5 s: `GET /api/super-tabs` (person identity, all pages via `after`). For each tab whose `revision` changed since the last read (or that
  is new), `GET /api/super-tabs/:tabId`. Tabs that left the list are dropped. Paused tabs are kept (their Leads read as done).
- **Leads**: for each project in `state.projects` (or the synthetic `lead` project of an older tab), the Lead is
  `conversations[project.leadConversationId].leadId` → `agents[]`. A project without a Lead agent is skipped. Per Lead:
  `{ id: leadAgentId, project: project.name, engine: configuration.engine, owner, local, state, since }` where
  - `local` = the Lead's `harnessId` when `agent.machineId` is this daemon's machine and the core has that harness; else empty;
  - `owner` = the machine owner's email (from `people[]`, which has no display name) when the Lead is not on one of this account's machines; else empty;
  - `state`/`since` follow decision 2; `since` (seconds into the current turn) only for a local Lead in a turn.
- **Order**: Leads that need you, then stuck, then working, then done; ties keep project order. At most 12 Leads per Swarm; at most 16 Swarms.
- **Last message** (on request only): `GET …/conversations/:leadConversationId/messages` (newest page); the newest row whose `author.id` is
  the Lead and has no `source`. If none on that page, one more page back with `before`; else "none". Cached per Lead by the conversation's
  `lastMessageSequence`; a request whose cache is current costs nothing. When a Lead's conversation advances and that Lead's recap is the one
  the Pro has open, the new text is pushed.
- **Failures**: a failed read keeps the last good data; nothing is removed on an error. Backend 401/403 for one tab drops only that tab.

### 2. Bridge: superTabs service ↔ core ↔ devices

Same pattern as the Super Tab waits (`core/superTabAttention.ts`):

- service → core: `superTabs.cards(items)` (the whole set on change) and `superTabs.cardRecap(tabId, leadId, recap)`.
- core → devices port: `swarmCards(items)`, `swarmCardRecap(...)`; replayed to a device on attach.
- devices → core → service: `swarmCardsWanted(boolean)` (a capable device attached / none left), `swarmCardRecapWanted(tabId, leadId)`,
  `swarmCardOpen(tabId, leadId)` (the open recap, for pushes; empty when closed).
- devices → windows: `dial_super_tab { superTabId, projectId }` (a new `DEVICE_WINDOW_FRAMES` entry) for decision 5.

### 3. Cable protocol (Pro only, capability-gated)

The Pro hello adds `"swarmCard":"v1"`. Only a device that says so gets any frame below; the round dial and older Pro firmware see no change.

Daemon → device:

```
{"t":"supertabs","ids":["<superTabId>",...]}                       (the current set and order, ≤16)
{"t":"supertab","id":"<superTabId>","tab":"<desk tab id or empty>","name":"openharness","count":4,
  "leads":[{"id":"<leadAgentId>","projectId":"<projectId>","project":"mobile","engine":"claude","owner":"","local":"<harnessId or empty>","state":"ask|stuck|work|done","since":134}]}   (one per Swarm)
{"t":"supertab.recap","tab":"<superTabId>","lead":"<leadAgentId>","text":"…","at":1792560000,"none":false}
{"t":"supertab.focus","tab":"<superTabId>","lead":"<leadAgentId>"}
```

Device → daemon:

```
{"t":"supertab.recap.get","tab":"<superTabId>","lead":"<leadAgentId>"}
{"t":"supertab.open","tab":"<superTabId>","lead":"<leadAgentId or empty>"}    (the recap on screen; empty when it closes)
{"t":"supertab.select","tab":"<superTabId>","lead":"<leadAgentId>"}
```

- The Pro's cable refuses a frame over 512 JSON tokens, so the list goes as `supertabs` (ids only) plus one `supertab` per Swarm (12 Leads ≈ 200
  tokens). Sent on attach, on change (debounced 300 ms; only the Swarms that changed, plus `supertabs` when the set or order changed) and on
  resync; each frame carries `seq` like every Pro frame. Names cut to 48 bytes.
- `tab` links a Swarm to the desk tab of the same Swarm (from the desktop's `app_swarms`, §5); empty when the desktop has no such tab open.
- `text` is cut at 1,500 bytes on a UTF-8 boundary.
- `supertab.focus` is sent when the desktop's open Swarm project changes (§5) and on attach.

### 4. Pro firmware

- **Model** (`pod_model`): a `pod_swarm_t` list (id, tab, name, leads[12] with the fields above plus a cached recap text and its state:
  none / loading / loaded / empty). Parsed in `pro_cable.c` (`handle_supertabs`, `handle_supertab_recap`, `handle_supertab_focus`).
- **Home**: a desk tab whose id matches a Swarm's `tab` is drawn as that Swarm's card instead of the tab card; a Swarm with no desk tab gets
  its own card after the desk tabs. The card reuses the Working card's layout (`working_card` in `ph_overview.c`): the Swarm's name as the
  title, the number of workspaces (projects that have a Lead) in `ph_bd_84` with "workspaces" (an orange pulsing dot before it while any Lead needs you), and three Lead pets
  a page with the project name and the status under each (green "working · m:ss", orange "needs you", red "stuck", grey "done"; a remote
  Lead adds its owner's name in a smaller muted line). A horizontal swipe in the pet band pages the Leads (`swarm_page`, like `work_page`);
  past the last page it moves to the next card. No page dots.
- **Lead recap** (a new view `ph_lead.c`, built from `ph_recap.c`): the Swarm's name (small, purple) and the project (title) at the top, the
  message bubble, the Lead's pet signing it with "Lead" and its status. States: loading ("…"), loaded, none ("No message yet"). Opening the
  view sends `supertab.recap.get` (unless cached and current) and `supertab.open`; closing sends `supertab.open` with no lead. A horizontal
  swipe moves to the previous/next Lead of the same Swarm in card order and sends `supertab.select`; a vertical drag scrolls a long message.
  Tapping a pet on the card also sends `supertab.select`.
- **Talk**: on a local Lead's recap the existing talk control works on `local` (the harness); a remote Lead has none.
- **Follow**: `supertab.focus` opens that Lead's recap the way `focus` opens an agent today (same rules: not while talking or updating; a
  pending focus waits for the Swarm list).
- Memory: Swarm list in PSRAM; one cached text per Lead (1.5 KB × 12 × 16 worst case ≈ 288 KB, PSRAM).

### 5. Desktop

- `app_swarms` rows for `kind:'superTab'` gain `superTabId` and `projectId` (the project of the selected conversation). Sent on every change of
  the selected conversation, so the daemon can map desk tab → Swarm and send `supertab.focus` (for the active desk tab only).
- `dial_super_tab { superTabId, projectId }`: focus (or reopen) that Swarm tab and select the project's Lead conversation, exactly as a click
  on the Lead row in the project sidebar. A selection that came from the device is marked so the next `app_swarms` does not echo a focus back.

## Errors and edge cases

- Backend unreachable or signed out: the Pro keeps the last cards; nothing is removed until a successful read says so.
- A Swarm with no projects/Leads: no card.
- A Lead removed while its recap is open: the recap moves to the next Lead, or back to Home when none is left.
- Recap request with no answer in 5 s: the view shows the cached text if any, else "…" stays and is retried once on the next open.
- More than 12 Leads: the first 12 by order; the frame carries the real count (`count`) and the card shows it.

## Testing

- **Backend**: none needed (existing endpoints).
- **CLI**: `cards.spec.ts` (listing, revision-gated reads, Lead extraction, status combination, order, caps, recap selection/cache/push,
  failures); bridge specs like `superTabAttention.spec.ts`; `cableSession.spec.ts` (capability gate, frames, budget shrink, focus/select
  round trip, resync); `devices.spec.ts`; `test:core` coverage gate.
- **Desktop**: controller/app_state tests for the new `app_swarms` fields, `dial_super_tab` handling and no echo.
- **Firmware**: `test_pro_cable.c` (parsing, limits, UTF-8 cuts), `test_ph_views.c` / `test_ph_glue.c` (card pages, swipes, recap states,
  follow, select), render fixtures + goldens for both fonts: card page 1, card page 2, needs-you first, remote Lead, recap loaded / loading /
  none; `bash test/run.sh`; IDF build.
- Manual: flash a `-swarmcard` build on unit 64:61 with a dev CLI and check against the mockup.
