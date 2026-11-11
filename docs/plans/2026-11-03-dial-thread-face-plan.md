# Round Dial Thread Face Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The round dial goes into the thread its own words started (or the app opened), shows it unmistakably, and leaves it with a horizontal swipe.

**Architecture:** The daemon's cards service keeps one face thread per Swarm (the app's `threadRoot` from #2718, or the dial's own after a voice post), sends it on the face chat and on recaps to dials with the `swarmThread` capability, and asks the window to open or close the thread. The round dial firmware draws the thread face and sends `supertab.thread.leave`. Desktop opens or closes the thread on `dial_super_tab`.

**Tech Stack:** TypeScript (cli daemon, vitest), Dart/Flutter (Desktop), C + ESP-IDF (round dial firmware, host tests in `devices/harness-device/firmware/test`).

**Spec:** `docs/specs/2026-11-03-dial-thread-face.md`

## Global Constraints

- Branch `feat/dial-thread-face`, based on PR #2718's head (5c4a5aeb4); rebase on `main` once #2718 merges. Worktree `.claude/worktrees/dialthread`.
- Capability name `swarmThread`; inbound frame `supertab.thread.leave {tab, lead}`; lead fields `thread` (root id), `threadTitle`, `threadReplies`; recap field `thread`.
- Thread title: first line, at most 80 bytes (daemon); dial wraps on words to 2 lines of ~22 characters, "…" when longer.
- Colours: thread teal `#2dd4bf`; Buddy lilac unchanged. Copy: "↳ Thread", "↳ Thread · Buddy", "PM · N replies" ("Buddy · …" on the Buddy side; "1 reply"), "Waiting for the PM…", "Waiting for your Buddy…", "‹ chat".
- Thread face: no pet, no bottom arc text; bell pill kept.
- No backend change. Harness Pro firmware untouched. Never force-flash; any device check uses the repo's flash procedure and dev version `0.0.99`, only on Diego's go.

## Review Focus

1. The app closes its thread while the dial is in the dial's own thread of the same root: the dial leaves too (the focus moved) — Task 1 test "a focus move clears the dial's thread".
2. Words said while already in a thread reply there and do not start a nested thread — Task 1 test "words said in a thread reply in it and start nothing".
3. A recap for the main chat arriving after the face entered a thread (or the reverse) is refused by the dial — Task 4 test "a recap for another thread than the face's is refused".
4. One project with a thread: a horizontal swipe leaves the thread and does not reopen or reselect the project on the desktop — Task 4 test "a swipe on a thread face leaves it and selects nothing".
5. A dial without `swarmThread` gets no thread fields and its leave frames are ignored — Task 2 test "an older dial is sent no thread and its leave is ignored".

---

### Task 1: Face thread in the cards service (daemon)

**Files:**
- Modify: `cli/src/superTabs/cards.ts` (`want`, `side`, `target`, `recap`, `say`, the face chat built in `leadsOf`/`faceOf` path, new `threadLeave`)
- Modify: `cli/src/core/api.ts` (`SwarmChat`, `LeadRecap`, `SaidOnCard`)
- Test: `cli/src/superTabs/cards.spec.ts`

**Interfaces:**
- Produces: `SwarmChat.thread?: { root: string; title: string; replies?: number }`; `LeadRecap.thread?: string`; `SaidOnCard` success becomes `{ said: true; thread?: { tabId: string; projectId: string; root: string } }` (set only when the post started the dial's thread); `SuperTabCards.threadLeave(tabId: string, leadId: string): { tabId: string; projectId: string } | null` (the project whose thread the window should close, or null when there was none).

- [ ] **Step 1: Write the failing tests** in `cards.spec.ts`, `describe('the face thread')`:
  - "words said at top level start the dial's thread": `say()` on a face with no thread; the backend answers `{ result: { messageId: 'm9' } }` → resolves `{ said: true, thread: { tabId, projectId, root: 'm9' } }`; the next emitted card's face chat has `thread: { root: 'm9', title: <the words, first line> }`; the next `recap()` reads the thread and answers with `thread: 'm9'`.
  - "words said in a thread reply in it and start nothing": face already in thread `m9` → the post has `replyTo: 'm9'` and the answer has no `thread`.
  - "the app's thread is the face's": focus `{ conversationId: lead chat, threadRoot: 'r1' }` → face chat `thread.root === 'r1'`, title from the root's text in the thread read.
  - "a focus move clears the dial's thread": dial's thread `m9`, then `want(..., focus without threadRoot)` from the desktop → no `thread` on the face.
  - "threadLeave clears the dial's thread and names the project": returns `{ tabId, projectId }`; the face has no `thread`; a second call returns null.
  - "a thread lives only while its conversation is on the face": side swiped to buddy → no PM thread on the Buddy face.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/superTabs/cards.spec.ts -t "the face thread"` — Expected: FAIL.
- [ ] **Step 3: Implement**: a `threads = new Map<string, { conversationId: string; root: string; title: string }>()` beside `sides`, cleared where `sides` is (device gone, account change, lost Swarm) and on a desktop refocus (`want` with `!fromDevice`); `target()` takes the focus's `threadRoot` when it names the face's conversation, else the dial's thread when its `conversationId` is the face's; the face chat gets `thread` (title cut to 80 bytes on a character, first line); `recap()` sets `LeadRecap.thread`; `say()` starts the thread when the post had no `replyTo` and the answer's `result.messageId` is an id; `threadLeave` deletes and re-emits. Replies count from the thread read's summary when present.
- [ ] **Step 4: Run** the same command, then `npx vitest run src/superTabs/cards.spec.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): the dial's face keeps the thread its words started`.

### Task 2: Cable, host and service pass-through (daemon)

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (caps: `swarmThread`; `chatLead` adds `thread`, `threadTitle`, `threadReplies` for a `swarmThread` dial; `fitFrame` trims `threadTitle` like `chatName`; recap frame adds `thread`; `case 'supertab.thread.leave'`; after a voice post that returns `thread`, open it in the window)
- Modify: `cli/src/cable/cableHost.ts`, `cli/src/services/devices.ts`, `cli/src/superTabs/inCore/cards.ts`, `cli/src/superTabs/service.ts` (new `cardThreadLeave` action and its answer; `superTabSelected(tab, projectId, chat?, threadRoot?: string | null)`; `swarmSay` passes `thread` through)
- Test: `cli/src/cable/cableSession.spec.ts`, `cli/src/services/devices.spec.ts`, `cli/src/superTabs/inCore/cards.spec.ts`, `cli/src/superTabs/service.spec.ts`

**Interfaces:**
- Consumes: Task 1's `SwarmChat.thread`, `LeadRecap.thread`, `SaidOnCard.thread`, `threadLeave`.
- Produces: window frame `dial_super_tab` payload `{ superTabId, projectId, chat?, threadRoot?: string | null }`.

- [ ] **Step 1: Write the failing tests**: cableSession "a swarmThread dial is sent the face's thread and its recap's thread"; "an older dial is sent no thread and its leave is ignored"; "supertab.thread.leave asks the service and closes the window's thread" (`superTabSelected(tab, projectId, chat, null)`); "a voice post that starts a thread opens it in the window" (`superTabSelected(..., 'm9')`); service/inCore/devices: "cardThreadLeave reaches the cards and answers the project".
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts src/services/devices.spec.ts src/superTabs/inCore/cards.spec.ts src/superTabs/service.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the pass-through in the files above, in each file's existing style for `cardSide` / `supertab.side`.
- [ ] **Step 4: Run** the same command, then `npx tsc --noEmit -p .` and `npm run test:core` — Expected: PASS (the known `src/services/devicesProcess.ts` branch gap on main aside).
- [ ] **Step 5: Commit** `feat(cli): the dial is told its thread and may leave it`.

### Task 3: Desktop opens and closes the dial's thread

**Files:**
- Modify: `desktop/lib/state/app_state.dart` (`case 'dial_super_tab'`, `_openSuperTabProject`)
- Test: `desktop/test/super_tab_dial_test.dart`

**Interfaces:**
- Consumes: `dial_super_tab.threadRoot` (Task 2).

- [ ] **Step 1: Write the failing tests**: "a dial pick with threadRoot opens that thread beside the chat" (controller `openedThread.root == 'm9'` after the frame); "threadRoot null closes the open thread"; "no threadRoot keeps today's pick".
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_dial_test.dart` — Expected: FAIL.
- [ ] **Step 3: Implement**: after the project's chat is open, `threadRoot` string → `controller.openThread(root)`; `null` → close the thread pane through the controller's existing close (find the method the thread pane's close button calls).
- [ ] **Step 4: Run** the same command and `flutter analyze lib/state/app_state.dart` — Expected: PASS, no new issues.
- [ ] **Step 5: Commit** `feat(desktop): the dial opens and closes its thread in the app`.

### Task 4: Round dial firmware: thread face and swipe out

**Files:**
- Modify: `devices/harness-device/firmware/main/ui/habitat/supertab.h`, `supertab.c` (`ht_lead_t`: `thread_root[ID_MAX]`, `thread_title[HT_SUPERTAB_NAME * 2]`, `thread_replies` (-1 unknown); `ht_lead_in_t` the same as `const char *`/`long`; recap `thread[ID_MAX]`; `ht_supertabs_recap_put(..., const char *thread, ...)` compares it; `ht_supertabs_recap_open` keeps a held recap only for the same chat and thread)
- Modify: `devices/harness-device/firmware/main/cable_client.c`, `cable_client.h` (announce `swarmThread`; parse `thread`, `threadTitle`, `threadReplies` on leads and `thread` on `supertab.recap`; `cable_client_supertab_thread_leave(tab, lead)`)
- Modify: `devices/harness-device/firmware/main/ui/habitat/ui_habitat.c` (thread face drawing in the Swarm face path ~1440-1530; horizontal swipe ~3796-3802; the "face chat moved" re-ask ~5300 also on a thread change)
- Test: `devices/harness-device/firmware/test/test_supertab.c`, `devices/harness-device/firmware/test/test_cable_supertab.py`

**Interfaces:**
- Consumes: Task 2's frames.

- [ ] **Step 1: Write the failing tests**: `test_supertab.c` "a lead keeps its thread root, title and replies"; "a recap for another thread than the face's is refused"; "leaving the thread re-opens the main chat's recap"; `test_cable_supertab.py` "the hello names swarmThread", "lead thread fields parse", "recap thread parses", "the leave frame is {t: supertab.thread.leave, tab, lead}".
- [ ] **Step 2: Run** `cd devices/harness-device/firmware && test/run.sh` — Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** the model and cable changes; then the face: when the face Lead's `thread_root[0]`, draw the teal ring, "↳ Thread"/"↳ Thread · Buddy", the title (2 lines, ~22 chars, "…"), no pet, no bottom arc text, the recap card with a teal spine and the meta line ("PM · N replies"/"1 reply", omitted when unknown), "Waiting for the PM…"/"Waiting for your Buddy…" when the recap is empty, "‹ chat" at the left edge; bell pill as today. Horizontal swipe on a thread face: send the leave, clear the face's thread locally, `ht_supertabs_recap_open` and `SUPERTAB_RECAP_GET`, select nothing. Test "a swipe on a thread face leaves it and selects nothing" in `test_supertab.c` if the swipe decision can be reached there, else in the cable test by the frames sent.
- [ ] **Step 4: Run** `test/run.sh` — Expected: PASS. Build: `idf.py build` with IDF 5.5.4 and the xtensa toolchain on PATH (see the round release toolchain notes) — Expected: success.
- [ ] **Step 5: Commit** `feat(round): the dial shows the thread it is in and swipes out of it`.

### Task 5: Pull request and device check

- [ ] Push `feat/dial-thread-face`; open a PR to `main` that depends on #2718 (rebase once it merges), with the spec, the checks run per component, and the mockup path.
- [ ] Only on Diego's go: dev build `-DPROJECT_VER=0.0.99`, flash his round dial with the repo procedure, and check: voice a task → thread face; PM reply shows; swipe sideways → main chat; app opens a thread → dial follows. Record the result in the PR.
- [ ] Send the PR to Diego's Buddy for the PM to merge with `make merge-pr` once `ci/required` is green.
