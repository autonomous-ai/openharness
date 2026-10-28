# Round dial: a Swarm is its chats, not its work

Status: spec · 2026-10-28 · owner Diego · changes the Swarm tab of
[2026-10-23-round-swarm-tab-design.md](2026-10-23-round-swarm-tab-design.md) (§4 face, §5 alerts, §6 talk)

## Why

Today the dial's Swarm tab follows the **work**:
- A project's Lead face reads `work` whenever any agent of the project is in a turn here, or any group is `working` or
  `review` (`cli/src/superTabs/cards.ts` `leadsOf`). While it reads `work`, the face shows the working pet and clock
  and hides the recap (`ui_habitat.c` `render_swarm_face`).
- The dial alerts when a project turns `ask` or `stuck`, which a **group** causes (`needs_human` or `blocked`)
  (`supertab.c` lead events → `swarm_notice_raise`). A new message from the Lead alerts nothing.
- The recap is always the Lead's last message in the project's Lead conversation, and talking posts there, whatever
  the desktop has open.

The owner wants the dial to follow the **conversation**. Each project has three places to chat:
- Chat with PM (the person's private chat with the project's Lead);
- the Lead conversation (`# project`);
- one chat per group.

The dial should show the one the person is in, and speak up only when the Lead or the PM says something new.

## What the owner decided (2026-10-28)

1. A horizontal swipe on the dial moves between **projects**, as today. A project opens on its **Lead** chat.
2. When the person opens that project's **Chat with PM** or one of its **groups** on the desktop, the dial follows to
   that chat.
3. The face shows only the **recap of the chat's last message from the agent side** (the Lead, the PM, or an agent of
   the group). The person's own messages are not the recap.
4. **Working** shows only for a **group** chat whose group is `working`. Lead and PM chats never show working.
5. The dial **alerts only when the Lead or the PM posts a new message** (Lead conversation or Chat with PM). Groups
   never alert, whatever their state.
6. A question asked by the Lead's own terminal on this machine (the existing Super Tab wait, a `question` frame with
   `superTab`) **still alerts**, as today.
7. Talking on the dial posts into the chat on the face.
8. Round dial only. The Harness Pro keeps its current Swarm cards.

Approach chosen: **the daemon decides, the firmware draws** (A). The rules live in the CLI, so changing them later
needs a CLI release, not a firmware flash.

## Design

### 1. Desktop: say which chat is open

- `desktop/lib/state/app_state.dart` `_announceOpenPanesToDial`: a Swarm tab's row in `app_swarms` gains
  `conversationId`. It is the Swarm controller's `selectedId` when that id is a conversation in its snapshot (Lead
  conversation, Chat with PM or a group). Otherwise it is left out (a decisions view, a machine, not loaded yet).
- A change of the selected conversation re-announces, as a change of the project does since #1911.
- `cli/src/localWsServer.ts` `appSwarmsFrom` accepts it with the same id check as `projectId`.
  `cli/src/cable/cableHost.ts` `activeSwarmProject()` returns it.

### 2. Daemon: one chat per project, chosen and read here

The new rules apply only to a device whose hello carries **`swarmChat: "v1"`** (`cableSession.ts` hello parsing,
beside `superTab: "wait-v1"`). Every other device, the Pro and round firmware up to 0.0.94, keeps today's frames.

**The chat on a project's face** (`cli/src/superTabs/cards.ts`):
- If the window's active tab is this Swarm and its `conversationId` belongs to this project, it is that conversation.
- Otherwise it is the project's Lead conversation (`project.leadConversationId`).

**Its kind:**
- `lead`: the project's Lead conversation;
- `pm`: a conversation with `audience` (the reader's private chat) in this project;
- `group`: any other conversation of the project.

**The `supertab` frame, per Lead** (one per project, as today), for a `swarmChat` device:
- `chat`: `lead` | `pm` | `group`.
- `chatId`: the conversation id.
- `chatName`: "Lead", "PM", or the group's title, cut to 48 bytes like `project`.
- `state`: `work` only when `chat` is `group` and that group's `assignment.status` is `working`. Otherwise `done`.
  It is never `ask` or `stuck`, so group states raise nothing on the device. `since` is sent only with `work`, from the
  group agent's live turn here when there is one.

**Recap:**
- `supertab.recap.get {tab, lead}` answers with the last message of the **chat on that Lead's face** whose author is
  an agent and whose `source` is null (system rows such as "Routed to…" are not recaps).
- `lastLeadMessage` becomes `lastAgentMessage(messages, agentIds)`, where `agentIds` is the Lead for `lead`/`pm` and
  the group's `agentIds` for `group`.
- The `supertab.recap` frame gains `chatId`. A recap for another chat than the one on the face is dropped by the
  device, as a recap for another Lead is today.
- When the chat on the face changes (the desktop opened another one), the daemon sends the new `supertab` and, for a
  device that has that Lead's recap open, the new recap.

**Alerts (new frame `supertab.notice`):**
- For each project of each Swarm, the daemon watches two conversations: the Lead conversation and the reader's Chat
  with PM. It uses `lastMessageSequence` from the tab reads it already makes every 5 s (`SwarmCards`).
- When one moves, it reads that conversation's newest page once. That is the same read and the same 2-at-once limit
  as recaps (`MAX_RECAPS_IN_FLIGHT`).
- For each new message after the last one seen whose author is that project's Lead agent and whose `source` is null,
  it sends `supertab.notice {tab, lead, chat: "lead"|"pm", chatId, id, text, at}` once. `id` is the message id, and
  `text` is cut to the recap's length.
- **Baseline:** the first read of a conversation after the daemon starts, or after a device attaches, records the last
  sequence and alerts nothing. Old messages never alert.
- **Read on the desktop:** when the window's `conversationId` is a conversation with an open alert, the daemon sends
  `supertab.notice.read {tab, lead, chatId}`.
- Groups are never watched for alerts.

**Talk:** `say(harnessId, text)` posts into the chat on that Lead's face (`message.send` to `chatId`) instead of
always the Lead conversation. A remote Lead still has no talk (today's rule).

### 3. Firmware (round): draw the chat, alert on its notice

- **Hello:** add `swarmChat: "v1"` (`cable_client.c`, beside `superTab: "wait-v1"`).
- **Parse:** `handle_supertab` reads `chat`, `chatId` and `chatName` into `ht_lead_t` (`supertab.h`; `chat_name` sized
  like `project`). `handle_supertab_recap` reads `chatId`. New handlers parse `supertab.notice` and
  `supertab.notice.read`.
- **Face** (`render_swarm_face`):
  - The upper arc shows the project, as today. The chat name is shown under it when the chat is not `lead`.
  - The recap always shows when loaded. The working pet and clock show only for `state == work`, which only a group
    chat can be.
  - The asking pose comes only from an open Lead wait (decision 6). The firmware no longer draws it from `ask`/`stuck`
    for a `swarmChat` daemon; those states are not sent anyway.
- **Alerts:**
  - A `supertab.notice` raises that Lead's inbox entry, which stays one per Lead (today's `swarm_notice_raise`). The
    body is the message text, the green line is engine + project, the grey line is the Swarm name plus "PM" when
    `chat` is `pm`.
  - It beeps and wakes the display with the existing coalescing (one beep per 30 s).
  - The entry is read at once only when the face shows that Lead **and** the face's `chatId` equals the notice's.
    Otherwise it stays unread.
  - `supertab.notice.read` removes it.
  - A later notice for the same Lead replaces the text and counts as unread again.
- **Lead waits** (decision 6): unchanged. The `question` frame with `superTab` for a Lead's `local` sets the wait text
  and raises the entry. With a `swarmChat` daemon the Lead never reads `ask`, so `ui_supertab_wait_close` removes the
  entry instead of reverting it to the fixed text.
- **Following:** unchanged (`supertab.focus` picks the project). The chat comes with the next `supertab`.

### 4. What does not change

- TABS, the tab list and the entry into a Swarm (#1891, #1911).
- The swipe between projects, and PANES.
- `supertab.select`, `supertab.open` and the echo suppression.
- The Pro: it never says `swarmChat`, so it gets today's frames.

## Design (docs/feature-design-rules.md)

Reviewed revision: ______  Reviewer (another engine): ______

1. **Growth:**
   - The daemon's alert baseline is in memory: one sequence per watched conversation, at most 16 Swarms × 12 projects
     × 2 conversations.
   - Entries are deleted when a Swarm or project leaves the cards, and the whole map when the account changes or the
     daemon stops.
   - The device keeps one inbox entry per Lead, as today. [x]
2. **Concurrency:**
   - Alerts and recaps are computed on the cable session's queue (`queued`), one at a time per device.
   - The baseline map has one writer, the cards refresh. Two moves seen in one refresh produce one read. [x]
3. **Read cost:**
   - No new periodic read: sequences come from the 5 s tab reads that already run.
   - A message page is read only when a watched sequence moved, capped at 2 at once.
   - The frames grow by about 70 bytes per Lead, under the 512-token guard for 12 Leads (test). [x]
4. **Scale:** at 10× messages from Leads, reads grow with messages, still capped at 2 at once and by the 5 s tab
   cadence. The first warning is the existing "too many recap reads at once" log line. [x]
5. **Compatibility:**
   - Gated on `swarmChat: "v1"`: old firmware and the Pro get today's frames.
   - New firmware with an old CLI gets today's frames and behaves as today.
   - A desktop without `conversationId` gives the Lead chat always.
   - Existing readers of `supertab`/`supertab.recap`: `cable_client.c`, `cableSession.ts`, `superTabs/inCore/cards.ts`
     (validation `STATES`), and the Pro firmware, which is not gated in. [x]
6. **Migration and rollback:**
   - Order: CLI, then Desktop, then firmware. Each is safe alone.
   - Rolling back the CLI returns every device to today's frames.
   - Rolling back the firmware (0.0.94) just stops saying `swarmChat`. [x]
7. **Audience:**
   - Chat with PM is private. The daemon reads as the signed-in person, and the backend returns only that person's
     private chats (`visibleState`).
   - The recap and the alert of a PM chat go only to that person's own dial: the daemon owns the USB device only for
     the console user (`usbConsoleUser.ts`), never the Team account. [x]
8. **Identity:** reads and the talk post run as the signed-in person (`backend(this.core, …)`), as today. [x]
9. **Failure:**
   - A failed page read is logged once and retried when the sequence moves again.
   - A failed recap leaves "…" and the device asks again (today's 5 s retry).
   - Nothing alerts twice: the baseline only advances past messages it has sent or skipped. [x]
10. **Platforms:** the round dial on macOS, Linux and Windows daemons alike. No platform-specific code. [x]

## Testing

- **CLI** (`cards.spec.ts`, `cableSession.spec.ts`, `localWsServer` spec):
  - `conversationId` parsing.
  - The chat on the face: default Lead, follows a PM chat or group of the same project, ignores one of another project.
  - Kind detection for `lead`, `pm` and `group`.
  - `state` is `work` only for a working group, and never `ask`/`stuck` for a `swarmChat` device.
  - Recap is the last agent message of the chat and skips the person's messages and `source` rows.
  - Alerts:
    - one alert per new Lead or PM message;
    - none for a group message, for the person's own message or for a system row;
    - none for messages before the baseline;
    - `notice.read` when the desktop opens the chat.
  - Talk posts to the face's `chatId`.
  - A device without `swarmChat` gets byte-identical frames to today.
- **Desktop** (`super_tab_dial_test.dart`): opening a PM chat or a group re-announces with its `conversationId`;
  opening a decisions view leaves it out.
- **Firmware host tests** (`test_cable_supertab.py`, `test_touch_ui.py`):
  - parse of the new fields and frames;
  - the face with a PM chat (chat name, recap, no working);
  - a working group (working pet), and a done group (recap);
  - a notice for another chat stays unread, one for the face's chat is read at once;
  - `notice.read` removes it;
  - no alert from `ask`/`stuck`;
  - a Lead wait still alerts;
  - `make device-test`.
- **On Diego's round** (dev build 0.0.99, flashed with Diego's yes):
  1. Swipe between projects: each opens on its Lead.
  2. Open Chat with PM, then a group, on the desktop: the dial follows.
  3. A working group shows working; the Lead chat never does.
  4. A new PM message alerts once; a group message does not.

## Unverified

- ~~That the messages page of a Chat with PM names the Lead as `author.id` in the same shape as the Lead
  conversation.~~ Checked 2026-10-28: `author: {kind: 'agent', id: <Lead agent id>}`, `source: null`, as in the Lead
  conversation.
- Group titles can be long. Check how the 48-byte `chatName` looks under the project on the arc with a mockup in
  `devices/harness-device/mockup/` before the firmware task.
