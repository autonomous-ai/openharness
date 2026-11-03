# A Thread Reply Alerts Unless That Very Thread Is Open Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** A PM or Buddy reply inside a thread beeps and stays unread on the round dial while its chat is open on the desktop
or on the dial's face, unless that very thread is open there. A message in the main stream behaves as today.

**Architecture:** The dial's alert is a `LeadNotice` that `SwarmCards.raise` (cli/src/superTabs/cards.ts) makes from the
newest agent message, thread replies included. It gains an optional `thread`: the root of the thread the message replies
in, unset for a main-stream message, a thread's root, or a reply also sent to the chat. The cable session's `pushNotice`
(cli/src/cable/cableSession.ts) today counts a notice as read on the desktop whenever the window has its chat open; it
then also needs the window's `threadRoot` to be the notice's thread, both when the notice arrives (not sent) and later
(`supertab.notice.read`). A swarmThread dial gets `thread` on `supertab.notice`; the firmware (cable_client.c,
ui_habitat.c `ui_supertab_notice`) reads a thread notice at once only when the Lead's face shows that thread
(`thread_root`), otherwise it beeps and stays unread. A dial without swarmThread gets today's frame. The held-notice
`inChat` WeakSet in cards.ts says the same as `thread === undefined`, so it is replaced by the field.

**Tech Stack:** TypeScript (Vitest) for the CLI and cable; C11 with the Python-driven host tests for the firmware
(`devices/harness-device/firmware/test`).

**Spec:** Task #2463 (Diego, reported 10-29; replaces closed PR #2222; builds on the thread face #2718/#2756 and tasks in
threads #2704). Not done here: the brief's optional "tapping it enters that thread on the face".

## Global Constraints

- The PR body starts with: `Requested by diego@autonomous.ai through Harness.`
- Swarm code stays out of cli/src/core: the only core change is the generic optional `thread` on `LeadNotice`
  (cli/src/core/api.ts).
- Never publish firmware, run upload scripts or touch the device update manifest; the real-dial check is Diego's after
  merge.
- Compatibility: `thread` is optional everywhere. A dial without swarmThread gets the exact frame of today; old firmware
  ignores an unknown key; a notice without `thread` keeps today's rule on desktop and dial.
- Desktop tests use a memory store and a fake sign-in; nothing signs the Mac out of the real CLI.
- Backend changes: none (no backend file changes), so the full Super Tab integration suite is not required; the CLI
  coverage gate `npm run test:core` covers the touched core type.

## Design

- growth: N/A because the notice stays one held entry per Lead (and one Buddy entry), replaced by the next; nothing new
  is stored.
- concurrency: N/A because the notices are held in one process's memory and pushed on the session's one queue, as today.
- read cost: no new read; the thread is a field of the message rows `raise` already has.
- scale: N/A because one more short id on a frame; the frame is still cut to the dial's limit by `fitText`.
- compatibility: optional field; the frame key is sent only to a swarmThread dial (see Global Constraints).
- migration + rollback: N/A because nothing persists; rolling back restores today's behavior.
- audience: unchanged; the notice is built from messages the reader can already read.
- identity: unchanged.
- failure: a notice whose thread is unknown on the dial beeps (the safe side), never silently reads.
- platforms: CLI daemon on macOS, Linux and Windows; firmware on the round dial.

## Review Focus

1. A reply also sent to the chat, and a thread's root, are main-stream notices (Task 1 tests).
2. The desktop with the chat open but another thread, or no thread, open: a thread notice is sent and not read; opening
   that thread sends `notice.read` once (Task 2 tests).
3. An older dial (no swarmThread) gets `supertab.notice` without `thread`, byte for byte as today (Task 2 test).
4. The face showing the main chat beeps for a thread notice; the face in that thread reads it at once; a main-stream
   notice keeps today's rule (Task 3 tests).
5. The recap answered from a held notice (`held`) still never takes a thread reply for the chat's recap, now through
   `notice.thread` (existing test "never answers the chat recap from a notice that is a thread reply").

---

### Task 1: The notice names its thread

**Files:**
- Modify: `cli/src/core/api.ts` (`LeadNotice`), `cli/src/superTabs/cards.ts` (`lastAgentMessage`, `raise`, `held`)
- Test: `cli/src/superTabs/cards.spec.ts`

**Interfaces:**
- Produces: `LeadNotice.thread?: string`, the root of the thread the message replies in; absent for a main-stream
  message. `lastAgentMessage` returns the message's `thread` when it is a reply only in a thread.

- [ ] **Step 1: Write the failing tests** in `cards.spec.ts`, `describe('SwarmCards notices')`:
  - `a PM reply inside a thread is a thread notice` — a new PM line with `thread: 'x1'` in the Buddy chat: the notice is
    `{ chat: 'pm', chatId: 'pm-web', id: 'x2', ..., thread: 'x1' }`.
  - `a thread reply also sent to the chat, or a thread's root, is no thread notice` — `alsoInChat: true`, and a root
    (`thread` equal to its own id): the notice has no `thread`.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/cards.spec.ts` in `cli`: the first FAILS (no `thread`).
- [ ] **Step 3: Commit** the failing tests and push.
- [ ] **Step 4: Implement**: `thread?: string` on `LeadNotice`; `lastAgentMessage` returns `thread` for a row whose
  `thread` is a string other than its id and not `alsoInChat`; `raise` copies it; `held` uses `notice.thread ===
  undefined` and the `inChat` WeakSet goes.
- [ ] **Step 5: Run** the file and `npx tsc --noEmit -p .`: PASS.
- [ ] **Step 6: Commit and push.**

### Task 2: The desktop reads a thread notice only in that thread; the frame carries it

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (`noticeFrame`, `pushNotices`, `pushNotice`)
- Test: `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Consumes: `LeadNotice.thread` (Task 1); `activeSwarmProject().threadRoot`.
- Produces: `supertab.notice` with `thread` for a swarmThread dial.

- [ ] **Step 1: Write the failing tests** in `cableSession.spec.ts`, `describe('swarmThread')`:
  - `a thread notice is sent while its chat is open, and read only when the window opens that thread` — the window on
    `pm1` with no thread, then thread `other`: the notice is sent with `thread: 'r1'` and no `notice.read`; the window
    opens `r1`: one `notice.read`.
  - `a thread notice arriving while that thread is open is not sent` — noted as read.
  - `a dial without swarmThread gets today's frame for a thread notice` — `supertab.notice` with no `thread` key.
- [ ] **Step 2: Run** `npx vitest run src/cable/cableSession.spec.ts -t swarmThread` in `cli`: they FAIL.
- [ ] **Step 3: Commit** the failing tests and push.
- [ ] **Step 4: Implement**: `pushNotices` passes the window's open conversation and thread root; `pushNotice` counts a
  notice as open on the desktop when the chat matches and, for a thread notice, the root matches; `noticeFrame` adds
  `thread` when the session speaks swarmThread.
- [ ] **Step 5: Run** the file and `npx tsc --noEmit -p .`: PASS.
- [ ] **Step 6: Commit and push.**

### Task 3: The face beeps for a thread reply unless it shows that thread

**Files:**
- Modify: `devices/harness-device/firmware/main/cable_client.c` (`handle_supertab_notice`),
  `devices/harness-device/firmware/main/ui/ui_screens.h`, `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c`
  (`ui_supertab_notice`)
- Test: `devices/harness-device/firmware/test/test_touch_ui.py`, `devices/harness-device/firmware/test/test_cable_supertab.py`

**Interfaces:**
- Produces: `ui_supertab_notice(tab, lead, chat, chat_id, thread, text, at)`; `thread` is "" for a main-stream notice.

- [ ] **Step 1: Write the failing tests**:
  - `test_touch_ui.py`, in the thread face checks: a PM thread notice for `m9` while T0's face shows the main PM chat
    beeps and stays unread; while the face shows thread `m9` it is read at once and does not beep; one for another
    thread while the face shows `m9` beeps.
  - `test_cable_supertab.py`: `supertab.notice` with `thread` reaches the UI with it; without it, "".
- [ ] **Step 2: Run** `python3 test/test_touch_ui.py` and `python3 test/test_cable_supertab.py` in the firmware folder: FAIL.
- [ ] **Step 3: Commit** the failing tests and push.
- [ ] **Step 4: Implement**: `handle_supertab_notice` reads `thread` (an id that fits, else ""); `ui_supertab_notice`
  takes it; the face reads a notice at once only when it shows that chat and, for a thread notice, that thread. The
  Buddy's quiet word keeps its rule.
- [ ] **Step 5: Run** both files and `test/run.sh`: PASS.
- [ ] **Step 6: Commit and push.**

### Task 4: Evidence

- [ ] Red/green evidence (each failing run before its code, then green) in a PR comment.
- [ ] `npm run test:core` in `cli` (the touched core type), the cards and cable spec files, `npm run typecheck`, firmware
  `test/run.sh`.
- [ ] Mark the PR ready; add the review step.
