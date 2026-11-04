# The round dial beeps only when you're tagged Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** The round dial beeps and wakes when, and only when, someone tags the person: in a project chat, a task chat or
a thread. PM chatter that tags nobody never beeps (task #2965, Diego, 2026-11-04).

**Architecture:** Today `SwarmCards.watchNotices` (cli/src/superTabs/cards.ts) turns each Lead's newest message in its
Lead conversation or the reader's Buddy chat into the Lead's `notice`. The cable session sends it once as
`supertab.notice`, and the firmware beeps for every `lead`/`pm` notice unless that chat is on the face. Task chats never
alert (cable_client.c drops `chat: "group"`).

- The Lead's `notice` comes from the person's waiting tags instead. Each Swarm read already carries
  `derived.mentionsDigest` (backend read/service.ts), which moves when a tag is made, answered or expires. The cards keep
  the digest per Swarm. Only when it moves do they read `GET /api/super-tabs/:tab/mentions?state=waiting`, under the
  background reads' limit. A tag id not seen before is new. Each new tag becomes the notice of its project's Lead (newest
  per Lead), naming its conversation (`chatId`) and its thread (`thread`, the root, when the tag is a thread reply).
  `chat` is `lead` for the project's Lead conversation, `pm` for the reader's Buddy chat or a Chat with PM, and `group`
  for any other chat (a task chat).
- Baseline: the first digest seen for a Swarm after a device attaches, a sign-in or a daemon start records the tags
  waiting then, with no notice. When it is the empty digest, there is nothing to read. A tag id once seen is never a
  notice again. A read or done tag leaves the waiting list, so it can never be new again. The cable session already
  sends each notice id once and notes, without sending, the ones there at attach.
- Lead and Buddy-chat messages no longer raise notices; the Lead conversation is not read for alerts at all. The face
  recap is still read and pushed by `pushOpen` from the chat's sequence (unchanged), so the recap updates quietly. The
  Buddy's quiet `buddyNotice` (its own chat's reads) stays as it is.
- Firmware: `handle_supertab_notice` takes `chat: "group"` as `HT_CHAT_GROUP`. `ui_supertab_notice` already reads a
  notice on the face only when the face shows that chat and that thread, and beeps otherwise. Opening a message entry on
  the dial also sends `supertab.notice.open {tab, lead}`. The daemon then has the window open the tagged chat and thread
  (`superTabThread`, which selects that conversation and opens the thread), so the face follows it. A tag in a chat's
  main stream opens with its own message as the root. When the window first has to move to that Swarm and project (the
  dial's pick), the open waits for the window's announce of that project's Lead chat, at most 15 s.
- Older firmware drops `group` notices and never sends `supertab.notice.open`. On it, tags in Lead chats beep and open the
  project's face, and PM chatter is quiet. Tags in task chats need the new firmware.

**Tech Stack:** TypeScript (vitest) in cli/; C firmware with host tests (devices/harness-device/firmware/test/run.sh).

**Spec:** task #2965's brief.

## Global Constraints

- Read the waiting mentions only when the server's mentions digest moves, never on a timer.
- Each new tag beeps once, never again after it is read or marked read (Activity rule, #3005), including after a
  reconnect or daemon restart. What arrived with no device attached does not beep.
- No beep if the tagged chat or thread is on the face.
- A PM message that tags nobody refreshes the face recap quietly: no beep, no wake, no inbox entry, also in Chat with PM.
- Device rules: never publish firmware, never run upload scripts, never touch the OTA manifest.
- Swarm code stays out of cli/src/core. The one change there is the `LeadNotice.chat` union in core/api.ts, which is the
  contract the core declares for the Swarm, with no logic.
- PR body first line: "Requested by diego@autonomous.ai through Harness."

## Design

- Growth: nothing stored. The cards hold, per Swarm, one digest and the tag ids seen, capped at 500 (the server's own
  cap on a person's tags per Swarm). A Swarm that leaves the cards takes them with it.
- Concurrency: one poll at a time (`busy`). The mentions read takes one of the two background read slots.
- Read cost: one mentions read per digest move per Swarm, none otherwise. The Lead conversations' alert reads go away,
  about one page read per Lead message today.
- Scale: 10x tags means 10x reads when the digest moves, bounded by two in flight. The first metric to warn is mentions
  reads per minute in the backend's route timings.
- Compatibility: a backend without `mentionsDigest` gives no tag notices, and PM chatter is quiet. Old firmware: see
  above. An old Desktop ignores nothing new: `superTabThread` already exists.
- Migration and rollback: none; reverting the CLI brings back PM-message notices.
- Audience: the server lists only the person's own tags in conversations they can read (mentions.ts `readable`).
- Identity: read as the signed-in person, as every card read is.
- Failure: a failed mentions read is logged once per run of failures and tried again at the next poll, with the digest
  unchanged.
- Platforms: the CLI daemon on macOS, Linux and Windows; the round dial's firmware.

## Review Focus

- Two tags for one project between two reads: one notice (the newest) and one beep, the other still in Activity.
- A tag made while no device was attached, then the device attaches: no beep, and none when the digest later moves for
  another tag.
- A tag in a task thread whose task chat is on the face but whose thread is not: it beeps (the main chat shows it
  collapsed).
- A Swarm whose project has no Lead: its tags make no notice and the cards keep going.
- The tag read fails while the digest moved: nothing is lost; the next poll reads again.

---

### Task 1: Tags are the Lead's notice; PM messages are quiet

**Files:**
- Modify: `cli/src/superTabs/readContract.ts` (Derived: `mentionsDigest?: string`)
- Modify: `cli/src/superTabs/reassemble.ts` (state.mentionsDigest from derived)
- Modify: `cli/src/superTabs/fixtures/read/index.ts` (pass `mentionsDigest` through `partsOf`)
- Modify: `cli/src/superTabs/cards.ts` (`watchNotices` → tags; `held` no longer answers from `notices`)
- Modify: `cli/src/core/api.ts` (`LeadNotice.chat`: add `'group'`)
- Modify: `cli/src/superTabs/inCore/cards.ts` (`NOTICE_CHATS` takes `group`)
- Test: `cli/src/superTabs/cards.spec.ts`

**Interfaces:**
- Produces: `SwarmLead.notice: LeadNotice` with `chat: 'lead' | 'pm' | 'group'`, `chatId` the tag's conversation,
  `id` the tag's id, `text` "Author: text" cut to RECAP_BYTES, `at` the tag's createdAt in seconds, `thread` the root
  when the tag is a thread reply.

- [ ] **Step 1: Write the failing tests** in a new `describe('SwarmCards tag notices')`, with the fake backend serving
  `/api/super-tabs/:tab/mentions?state=waiting` from a list the test holds and the Swarm read carrying `mentionsDigest`:
  - the first digest is a baseline: no notice, and no mentions read when it is the empty digest;
  - a new tag in a task thread becomes the project Lead's notice `{ chat: 'group', chatId: 'g-web', id: 'tag2',
    text: 'Sam: @me look', at, thread: 'r1' }`, read once;
  - nothing moved: no second mentions read and the same notice; a later digest move that adds no new id raises none;
  - a tag in the Lead conversation is `chat: 'lead'`, in the reader's Buddy chat `chat: 'pm'`;
  - two new tags for one project: the newest is the notice;
  - 20 new Lead messages across 5 projects in a poll stream, with the digest unmoved: no notice, no mentions read, and
    no Lead conversation page read for alerts;
  - after `want(false)` and `want(true)` the waiting tags are a fresh baseline: no notice;
  - a failed mentions read keeps the digest, is logged once, and the next poll raises the notice.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/superTabs/cards.spec.ts -t 'tag notices'`. Expected: FAIL (no notice,
  or a Lead message notice).
- [ ] **Step 3: Update the old `SwarmCards notices` tests** that pin PM messages as notices, so they now say no notice
  comes from them, and the recap tests that answered from a Lead notice.
- [ ] **Step 4: Commit the failing tests.**
- [ ] **Step 5: Implement** `private async watchTags(): Promise<void>` in cards.ts, replacing the Lead and Buddy-chat
  part of `watchNotices` (the Buddy notices stay). State: `tagDigests: Map<string, string>`, `tagsSeen: Map<string,
  Set<string>>`, both cleared where `seen` is cleared. `held()` answers only from recaps and `buddyNotices`.
- [ ] **Step 6: Run** the cards spec and `src/superTabs/inCore` specs. Expected: PASS.
- [ ] **Step 7: Commit.**

### Task 2: Firmware takes task-chat tags

**Files:**
- Modify: `devices/harness-device/firmware/main/cable_client.c` (`handle_supertab_notice`: `group` → `HT_CHAT_GROUP`)
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (`ui_supertab_notice` comment; grey line)
- Test: `devices/harness-device/firmware/test/test_cable_supertab.py`, `test_touch_ui.py`

- [ ] **Step 1: Write the failing tests:** a `group` notice reaches `ui_supertab_notice` with `HT_CHAT_GROUP` and beeps;
  an unknown kind (`"tag"`) is still dropped. In `test_touch_ui.py`: a group notice with its chat and thread on the face
  is read at once with no beep; the same chat on the face with another thread beeps; a second notice with the same id
  after it was read adds no beep (the daemon sends each once; the dial's count does not rise).
- [ ] **Step 2: Run** `devices/harness-device/firmware/test/run.sh`. Expected: FAIL at the group case.
- [ ] **Step 3: Commit the failing tests.**
- [ ] **Step 4: Implement:** accept `group` in `handle_supertab_notice`.
- [ ] **Step 5: Run** `run.sh`. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 3: Opening a tag on the dial opens its chat and thread

**Files:**
- Modify: `devices/harness-device/firmware/main/cable_client.c` (`cable_client_supertab_send` allows
  `supertab.notice.open`)
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (`A_NOTICE`: a message entry also sends it)
- Modify: `cli/src/cable/cableSession.ts` (`supertab.notice.open`; the held notice keeps `chat` and `thread`)
- Test: `cli/src/cable/cableSession.spec.ts`, `devices/harness-device/firmware/test/test_touch_ui.py`,
  `test_cable_supertab.py`

**Interfaces:**
- Consumes: `LeadNotice` from Task 1; `CableHost.superTabThread(superTabId, conversationId, threadRoot)`.
- Produces: frame `supertab.notice.open {tab, lead}` from the dial.

- [ ] **Step 1: Write the failing tests:**
  - cableSession: after a `group` notice with thread `r1` was sent, `supertab.notice.open` for its Lead, with the window
    already on that project's Lead chat, calls `superTabThread(tab, 'g-web', 'r1')` once. With the window elsewhere, the
    call waits for the announce of that project's Lead chat, and is dropped after 15 s. A main-stream tag in a task chat
    opens with its own id as the root. A `lead` notice with no thread calls nothing. A notice the dial was never sent
    calls nothing.
  - firmware: opening a message entry sends `supertab.select` then `supertab.notice.open` with its tab and Lead; a
    question entry sends no `supertab.notice.open`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts -t 'notice.open'` and `run.sh`.
  Expected: FAIL.
- [ ] **Step 3: Commit the failing tests.**
- [ ] **Step 4: Implement** in cableSession: the held notice keeps `chat` and `thread`; `supertab.notice.open` sets a
  pending open `{ tab, lead, conversationId, root, until }`; `pushSwarmFocus` fires it when the window shows that
  project's Lead chat, and right away when it already does. In firmware: the `supertab.notice.open` frame and its send
  in `A_NOTICE`.
- [ ] **Step 5: Run** both. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 4: Red/green evidence and the pull request

- [ ] Run the cards, inCore, cableSession specs, `npm run typecheck` in cli/, and the firmware's `run.sh`, on the
  fix and with the fix reverted, and post the red/green evidence as a pull request comment.
- [ ] The PR says that tags in task chats need a firmware release and that the PM-quiet part works on current firmware.
