# Round Dial: Recap at Once, the App's Project Order, and Threads Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** The round dial's recap answers at once on a side switch, its projects swipe in the app's A to Z order, and its chat recap skips thread replies while a thread open on Desktop is shown and answered on the dial.

**Architecture:** All three live in `SwarmCards` (cli/src/superTabs/cards.ts). (1) The dial's own recap read gets a lane of its own, one at a time, apart from the two background reads (notices, pushes); a recap held for the same chat, or a notice from it, is answered first and refreshed after, and the dial's daemon logs an empty or failed recap once per Lead and reason. (2) `leadsOf` ranks projects by name, case-insensitively A to Z, ties in server order, and `order` is that rank. (3) `lastAgentMessage` takes where to look (the chat's main stream, or one thread); Desktop names the open thread on the Swarm row (`threadRoot`), which rides the focus to the cards; a face with a thread reads and answers in it.

**Tech Stack:** TypeScript, Vitest (CLI); Dart, Flutter 3.47.2 (Desktop).

**Spec:** Task #2300 (Diego's three dial proposals), its brief in conversation 1ef9eace7e5c207a545f1a22.

## Global Constraints

- The PR body starts with: `Requested by diego@autonomous.ai through Harness.`
- No firmware change. Never publish firmware, run upload scripts or touch the device update manifest.
- Swarm code stays out of `cli/src/core`: the focus's `threadRoot` is typed in the Swarm's files, not in `core/api.ts`.
- Never run a test that signs this Mac out of the real CLI; Desktop tests use a memory store and a fake sign-in.
- Before Ready: a failing-first test for every risk below, red/green evidence in a PR comment, and the full Super Tab integration suite (`npm run test:super-tabs`).
- Files beyond the brief's list, each a pass-through or a comment: `cli/src/localWsServer.ts` (reads `threadRoot` off `app_swarms`), `cli/src/superTabs/inCore/cards.ts` and `cli/src/superTabs/service.ts` (carry it in the focus), `desktop/lib/super_tabs/client.dart` (re-announces on a thread opening or closing), `desktop/lib/super_tabs/controller.dart` (says whether the thread's pane is on screen), `desktop/lib/super_tabs/project_sidebar.dart` (the note that the orders must match).

## Review Focus

1. Two dials, or one dial asking in a loop: device reads queue one at a time, so the backend never sees more than three recap reads at once (two background, one device). Test: two device recaps asked together both answer, and the second read starts after the first ends.
2. A held recap from before another person signed in is never answered: the cache is cleared on a change of reader, as today. Test: covered by the existing reader-change test, kept green.
3. A thread on the face whose root is in another conversation (the window moved to another chat with the thread pane still naming the old one) is not used: the thread counts only when it is in the face's own conversation. Test in Task 4.
4. Words said while a thread was on the face that closed before they were sent go to the chat, never to a thread no longer shown. Test in Task 4.
5. A project named with only case differences ("web" and "Web") keeps server order between them. Test in Task 2.

---

### Task 1: The dial's recap is never refused, answers at once from what is held, and an empty one is logged

**Files:**
- Modify: `cli/src/superTabs/cards.ts` (`recap`, `pushOpenNow`, `prune`, `watchNotices`/`raise`)
- Modify: `cli/src/services/devices.ts:255-257` (`swarmCardRecap`: a refusal throws its code instead of null)
- Modify: `cli/src/cable/cableSession.ts:3031-3043` (log once per Lead and reason)
- Test: `cli/src/superTabs/cards.spec.ts`, `cli/src/cable/cableSession.spec.ts`

**Interfaces:**
- Produces: `SwarmCards.recap(tabId, leadId, chat)` is the device's read: it waits for the device lane (one at a time) and never throws "too many recap reads". A private `read(tabId, leadId, chat, lane: 'device' | 'background')` does the backend read; `pushOpenNow` uses `'background'` (still at most `MAX_RECAPS_IN_FLIGHT = 2`, a refusal retried next tick).
- Produces: a recap held for the target's cache key (any sequence), else the Lead's notice for the target chat when it is a main-stream message, is answered at once; when it is older than the chat (`sequence` moved, or answered from a notice) a device-lane refresh follows and `onRecap` pushes it when its text, time or chat differ.
- Produces: `prune` keeps a recap while its chat could be on this Lead's face (`chatOfLead`), not only while it is on it, so a swipe back finds it.

- [ ] **Step 1: Write the failing tests** (cards.spec.ts, `describe('SwarmCards dial recap')`)
  - `answers the dial's recap while two background reads run`: message reads take 50 ms; a tick reading a moved Lead conversation and a side switch's push are in flight; `await cards.recap('t1', 'a1', 'buddy')` resolves to the Lead's text, no throw.
  - `answers a side switch from the held recap with no backend request`: PM recap read, swipe to Buddy (recap read), a tick, swipe back to PM; `cards.recap` answers the PM text and no `GET …/messages` is made.
  - `answers a stale held recap at once and pushes the newer one`: the Lead conversation moved; `cards.recap` answers the old text, then `onRecap` gets the new text.
  - `queues two device recaps one after the other`.
- [ ] **Step 2: Write the failing test** (cableSession.spec.ts) `logs a recap answered empty once per Lead and reason`: host recap answers null twice for a1 → one log line naming a1; a failure with a reason → one more line; a good answer and another null → a line again.
- [ ] **Step 3: Run** `cd cli && npx vitest run src/superTabs/cards.spec.ts src/cable/cableSession.spec.ts` — Expected: the new tests FAIL ("too many recap reads at once", a messages read made, no log line).
- [ ] **Step 4: Commit the failing tests.**
- [ ] **Step 5: Implement** as the Interfaces say; devices.ts throws `new Error(String(r.error ?? 'not a recap'))` for a refused or unsound answer; cableSession keeps a `Set` of `${lead}:${reason}` logged, cleared for that Lead by a recap that came back.
- [ ] **Step 6: Run** the same command — Expected: PASS, whole files.
- [ ] **Step 7: Commit.**

### Task 2: Leads in the app's order

**Files:**
- Modify: `cli/src/superTabs/cards.ts:124-182` (`leadsOf`)
- Modify: `desktop/lib/super_tabs/project_sidebar.dart` (comment at both sorts: the dial's `leadsOf` must match)
- Test: `cli/src/superTabs/cards.spec.ts`

**Interfaces:**
- Produces: each `SwarmLead.order` is its project's rank by `name.toLowerCase()` compared by code unit (Dart's `compareTo`), ties by server index; urgency sort ties go by that rank; the 12 most urgent are kept.

- [ ] **Step 1: Write the failing tests:** `orders Leads as the app lists projects`: projects `Zeta, alpha, Mid` → `order` alpha 0, Mid 1, Zeta 2 and, all done, leads `[alpha, Mid, Zeta]`; `keeps server order for a name tie`: `web` then `Web` → orders 0, 1. Update the two existing order tests to the A to Z rank.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/cards.spec.ts -t "order"` — Expected: FAIL (creation order).
- [ ] **Step 3: Commit the failing tests.**
- [ ] **Step 4: Implement** the rank in `leadsOf`, the note in both files.
- [ ] **Step 5: Run** the file — Expected: PASS. **Step 6: Commit.**

### Task 3: The chat recap skips thread replies

**Files:**
- Modify: `cli/src/superTabs/cards.ts:198-212` (`lastAgentMessage`)
- Test: `cli/src/superTabs/cards.spec.ts`

**Interfaces:**
- Produces: `lastAgentMessage(messages, agentIds, place: 'any' | 'chat' | { thread: string } = 'any')`. `'chat'`: the main stream (`!thread || thread === id || alsoInChat`, backend catchUp.ts `inMainStream`); `{ thread }`: rows whose `thread` is that root. Notices keep `'any'`; recaps of a chat use `'chat'`.

- [ ] **Step 1: Write the failing tests:** `lastAgentMessage in the chat skips a thread reply but keeps one also sent to the chat`; `the chat recap is the agent's latest top-level message, not a thread reply` (SwarmCards.recap over a page whose newest Lead row is a thread reply).
- [ ] **Step 2: Run** — Expected: FAIL (the reply's text). **Step 3: Commit.**
- [ ] **Step 4: Implement.** **Step 5: Run** — PASS. **Step 6: Commit.**

### Task 4: A thread open on Desktop is the dial's face

**Files:**
- Modify: `desktop/lib/state/app_state.dart:6080-6154` (`_dialThread`, `'threadRoot'` on the row)
- Modify: `desktop/lib/super_tabs/controller.dart:862-877` (`threadPaneOnScreen`; `threadPaneShown` notifies)
- Modify: `desktop/lib/super_tabs/client.dart:766-769` (an `openedThread` change calls `onSelection`)
- Modify: `cli/src/cable/cableSession.ts:328` (`AppSwarms` row `threadRoot?`), `cli/src/localWsServer.ts:237` (read it, an id or nothing)
- Modify: `cli/src/cable/cableHost.ts:580` (`activeSwarmProject` carries `threadRoot`), `cli/src/services/devices.ts:583` (focus carries it, a change refocuses)
- Modify: `cli/src/superTabs/inCore/cards.ts:146`, `cli/src/superTabs/service.ts:500` (carry it)
- Modify: `cli/src/superTabs/cards.ts` (`want`, `target`, `Opened`, `pushOpenNow`, cache key, `say`)
- Test: `desktop/test/super_tab_dial_test.dart`, `cli/src/superTabs/cards.spec.ts`, `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Produces: the `app_swarms` row's `threadRoot` (the open thread's root id) while the selected conversation's thread pane is on screen; absent otherwise.
- Produces: `SwarmCards.want(on, include, focus: CardFocus & { threadRoot?: string })`; a change of `threadRoot` is a refocus.
- Produces: `Target.thread?: string`, set when the face's conversation is the focused one and the focus names a thread; `recap` then reads `…/messages?thread=ROOT` and takes the newest agent message there; the cache key and `Opened` include the thread; `say` posts `replyTo: thread` when `target` at send time has it.

- [ ] **Step 1: Write the failing tests:** Desktop `the Swarm row names the open thread while its pane shows, and not after it closes`; cards.spec `a thread on the face shows its newest agent reply and closing it pushes the chat recap`; `words said with a thread on the face reply in it`; `a thread whose chat is not on the face is not used` and `words said after the thread closed go to the chat` (Review Focus 3, 4); cableHost.spec `activeSwarmProject carries the thread root`.
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_dial_test.dart` and the CLI files — Expected: FAIL. **Step 3: Commit.**
- [ ] **Step 4: Implement** as the Interfaces say. **Step 5: Run** — PASS, then `npx tsc --noEmit -p cli`, `npm run test:super-tabs`, `flutter analyze` on the changed files. **Step 6: Commit and push.**
