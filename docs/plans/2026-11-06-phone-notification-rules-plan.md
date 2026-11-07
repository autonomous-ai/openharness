# Phone notification rules Implementation Plan

> **How this plan is carried out:** by one Engineer in this session, task by task, each failing test committed and watched
> failing before the code that passes it (the project's way of working, not subagent-driven-development). Steps use
> checkbox (`- [ ]`) syntax.

**Goal:** The phone rings only when a person must act or a person speaks to you, the same way on the server's push and on
the app's own notices, and one task's stuck / needs-you / decision question is one notification.

**Architecture:** The backend's `phoneNotices` (`backend/src/push/notices.ts`) and the app's `SwarmAnnouncer`
(`mobile/lib/swarm/swarm_notices.dart`) already word and key the same notices so a push and the app's notice share one
slot. Each rule is applied in both places by the **type of the event** (who wrote it: person or agent; what it is: reply,
tag, decision, work waiting), never by its text. A decision and the work waiting on the same task get one shared slot,
`task:<swarm>:<conversation>`.

**Tech Stack:** TypeScript + vitest (`backend/`), Dart + flutter_test (`mobile/`).

**Spec:** the task #3607 brief (Tony's push thread, 2026-11-06) and the table in
[docs/phone-notifications.md](../phone-notifications.md), which this plan rewrites to the new rule.

## Global Constraints

- Ring (push or sound): an agent asks you to decide or approve and work waits on you (`decision.ask`, `needs_human` with an
  ask, a command approval); a sign-in from an unknown device; a person tags you; a person replies to you or in a thread you
  started.
- No ring, badge and Activity only: an agent finishing a turn or a whole task; an agent replying in your thread (unless it
  asks and waits for your approval, which is a decision); an agent tagging you without a decision or approval.
- Merge: "stuck", "needs you" and the decision question of the same task make one notification.
- Default per chat: Mentions only; All new messages only when the person turns it on.
- Classify by event type, never by reading message text. A notice never says what was written (unchanged).
- A reply keeps its reasons: `starter`, `quoted`, `tagged` push when a person wrote it; `replier` never (unchanged).
- Unchanged (Tony, 2026-11-06): questions and approvals ring; a device joining rings; thread replies share one notice; a
  question answered elsewhere takes its notice down; a teammate's Team-account agents never notify.
- Compatibility: a new phone on an old backend, and an old phone on a new backend, lose no alert. A tag whose tagger kind
  the phone does not know rings, as it does today.
- Swarm code stays out of `cli/src/core`. No schema, collection, index or query change.

**Decided, not asked:** (1) a reply in a thread you were tagged in (`tagged`) stays pushed when a person wrote it: it is
a person speaking to you, and the brief does not take it away. (2) A new *server push* for a device sign-in is not in
this change: the phone already rings for it locally (`New device on your account`), and a push there is sign-in code that
needs two security reviews; it goes to the PM as a follow-up.

**Design** (feature-design rules; this change exposes one field and stores nothing):

- growth, concurrency, read cost, scale, migration: N/A because nothing is stored and no read is added; the one field
  rides a row the mentions list already returns.
- compatibility: `leadKind` absent (old backend) rings as before; an old phone ignores it.
- audience: the field is the tagger's kind, already visible in the chat the person can read.
- identity: N/A. failure: a missing kind rings rather than loses an alert. platforms: iOS and Android alike.

## Review Focus

1. An agent's message whose words say "approve" or "decide" but is no decision stays silent (Task 1).
2. An old backend sends no `leadKind`: the phone still tells the tag (Task 3).
3. A task's decision answered on the desktop while its stuck notice is up: the one notification goes, and answering one of
   two needs leaves it up (Task 4).
4. Android: the push of a decision (tag = the task slot) is not posted again by the phone when it comes to the front, and
   does not sound twice (Task 4).
5. A person's tag in a muted chat still tells; a held tag (quiet chat) is still not pushed (Task 1).

---

### Task 1: Backend rings only for a person's reply and a person's tag

**Files:**
- Modify: `backend/src/push/notices.ts` (`phoneNotices`)
- Test: `backend/src/push/notices.test.ts`, `backend/integration/superTabActivity.test.ts` (three existing tests assume an
  agent's tag or reply pushes: "an agent's tag is worded with the agent's name…", the Buddy-chat reply test in
  `notices.test.ts`, and "words a tag as the phone does…")

**Interfaces:**
- Consumes: `ReplyRow.actorKind` (`'person' | 'agent'`), the tag message's `author.kind`.
- Produces: `phoneNotices` returns no reply notice for an agent actor and no tag notice for an agent author. Signature
  unchanged.

- [ ] **Step 1: Write the failing tests** in `notices.test.ts`, in a new `describe('phoneNotices: who rings (task #3607)')`:
  `an agent's reply rings nobody, for starter, quoted and tagged alike`; `a person's reply rings for starter, quoted and
  tagged, never replier`; `an agent's tag rings nobody, a person's tag rings`; `an agent's text that says approve or decide
  rings nobody (type, not words)`; `a tag held for a quiet chat is still not pushed`. Change the two existing tests that
  use an agent as the reply actor or tagger to use a person, and add the agent case beside them.
- [ ] **Step 2: Run** `cd backend && NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= npx vitest run src/push/notices.test.ts`. Expected: the new tests FAIL (agent notices returned).
- [ ] **Step 3: Implement** in `phoneNotices`: keep a reply row only when `row.actorKind === 'person'`; keep a tag row only
  when `byId.get(row.messageId)?.author.kind === 'person'`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Update** the integration test expectations for the agent tag and Buddy reply to "no push" (they run in PR CI).
- [ ] **Step 6: Commit** the failing tests, then (after Step 3) the code, as two commits.

### Task 2: Backend decisions share a task slot; the mentions list says who tagged

**Files:**
- Modify: `backend/src/push/notices.ts` (export `taskSlot`, use it for decisions), `backend/src/superTabs/mentions.ts`
  (`listMentions` adds `leadKind`)
- Test: `backend/src/push/notices.test.ts`, `backend/src/push/apns.test.ts` / `fcm.test.ts` only if they pin a decision's slot,
  the mentions list test in `backend/integration` that already reads `listMentions`.

**Interfaces:**
- Produces: `export const taskSlot = (tabId: string, conversationId: string) => \`task:${tabId}:${conversationId}\``; a
  decision notice keeps `key: decision:<id>` and gets `slot: taskSlot(tabId, row.conversationId)`. Each `listMentions` row
  gains `leadKind: 'person' | 'agent' | null` (the tag message's `author.kind`).
- Consumed by Tasks 3 and 4 (the app builds the same slot string and reads `leadKind`).

- [ ] **Step 1: Write the failing tests:** `two decisions in one task share one slot, two tasks do not`; `a decision's key
  stays decision:<id>`; `listMentions says whether a person or an agent tagged` (integration, next to the existing
  listMentions test).
- [ ] **Step 2: Run** the unit file; Expected: FAIL (slot equals key; no `leadKind`).
- [ ] **Step 3: Implement** both changes. `leadKind` is read from the message already loaded for `leadName`.
- [ ] **Step 4: Run** the unit file; Expected: PASS. Run `npm test` in `backend/` once before Ready (the unit suite).
- [ ] **Step 5: Commit** tests, then code.

### Task 3: App: an agent's reply or tag is badge and Activity only

**Files:**
- Modify: `mobile/lib/swarm/swarm_asks.dart` (`SuperTabMention.leadKind`), `mobile/lib/swarm/swarm_notices.dart`
  (`SwarmAnnouncer.announce`, `announceReply`)
- Test: `mobile/test/swarm/swarm_notices_test.dart`, `mobile/test/swarm/swarm_notice_repeat_test.dart`

**Interfaces:**
- Consumes: the server's `leadKind` (Task 2) and `SwarmActivityEntry.actorKind` (`'person' | 'agent'`).
- Produces: `SuperTabMention.leadKind` (`String?`, null when the backend does not send it);
  `bool get taggedByAgent => leadKind == 'agent'`.

- [ ] **Step 1: Write the failing tests:** `a tag by an agent posts no notice but still counts on the badge`; `a tag by a
  person rings`; `a tag with no leadKind (old backend) rings`; `a reply by an agent posts no notice and takes no thread slot`;
  `a reply by a person rings and one reply sounds once per thread` (kept).
- [ ] **Step 2: Run** `cd mobile && flutter test test/swarm/swarm_notices_test.dart test/swarm/swarm_notice_repeat_test.dart --concurrency=2`. Expected: the agent cases FAIL.
- [ ] **Step 3: Implement** `SuperTabMention.leadKind` parse; `announce` returns early (the need still counts in `settle`'s
  badge) when `need` is a `SwarmMentionNeed` with `taggedByAgent`; `announceReply` returns early when
  `entry.actorKind == 'agent'`, before it registers a thread slot.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** tests, then code.

### Task 4: App: stuck, needs you and the decision of one task are one notification

**Files:**
- Modify: `mobile/lib/swarm/swarm_notices.dart` (`swarmNotice`, `SwarmAnnouncer.announce`, `_posted`, `_takeDown`,
  `swarmRead`, `settle`)
- Test: `mobile/test/swarm/swarm_notices_test.dart`, `mobile/test/phone/phone_shell_swarm_notice_test.dart`

**Interfaces:**
- Produces: `String swarmTaskSlot(String swarmId, String conversationId)` returning `task:$swarmId:$conversationId`
  (the same string as the backend's `taskSlot`). `swarmNotice` for a `SwarmDecisionNeed` and a `SwarmWorkNeed` (stuck,
  needs you, at a prompt) uses that slot as its notice `key`; a `SwarmMentionNeed` keeps its own key.
- Behaviour: when a notice already shows that slot, the next one replaces it quietly. When `told.pushed(slot)` is true
  (the server's push shows it) the app posts none. The slot's notification is taken down only when no posted need holds it.

- [ ] **Step 1: Write the failing tests:** `stuck, needs you and a decision of one task post under one key, the later ones
  quiet`; `two tasks keep two notifications`; `answering one of two needs leaves the notification, answering both takes it
  down (two reads in a row, as before)`; `a task whose decision push shows its slot gets no local notice`; `the badge still
  counts each need`.
- [ ] **Step 2: Run** the Task 3 command plus `test/phone/phone_shell_swarm_notice_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement** `swarmTaskSlot`; make `_posted` map a need key to its swarm and slot; `announce` skips when
  `told.pushed(slot)`, and posts `quiet: true` when another posted need holds the slot; `_takeDown(needKey)` removes the need
  and cancels the slot only when no other posted need holds it.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** tests, then code.

### Task 5: App: an agent's finished turn posts no notification

**Files:**
- Modify: `mobile/lib/notify/done_notice.dart` (`decideDoneNotice`), `mobile/lib/notify/agent_announcer.dart`
  (`_announceEnd`) if the decision is not enough
- Test: `mobile/test/notify/done_notice_test.dart`, `mobile/test/notify/agent_announcer_test.dart`,
  `mobile/test/notify/local_system_notices_test.dart`

**Interfaces:**
- Produces: a finished turn never returns an `AgentNotice` that alerts or chimes; the agent's unread mark (dot, badge) is
  kept. Questions (`questionAsked`) are unchanged.

- [ ] **Step 1: Write the failing tests:** `a finished turn marks the agent unread and posts nothing, in front or away, at
  any tier`; `a question still posts and chimes`; `a turn that ends while a question is up leaves the question`.
- [ ] **Step 2: Run** `cd mobile && flutter test test/notify/done_notice_test.dart test/notify/agent_announcer_test.dart test/notify/local_system_notices_test.dart --concurrency=2`. Expected: FAIL.
- [ ] **Step 3: Implement** in `decideDoneNotice`: the strongest result is the mark. Update the tests that expected a done
  notice to the new rule (a deliberate behaviour change, not a loosened assertion).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** tests, then code.

### Task 6: The default per chat is Mentions only, pinned; the rule table in the docs

**Files:**
- Test: `backend/src/superTabs/chatSettings.test.ts` (or the file that already tests it), `mobile/test/swarm/swarm_chat_notices_test.dart`
- Modify: `docs/phone-notifications.md`

- [ ] **Step 1: Write the pinning tests:** backend `a chat with no row is mentions only, and a person's choice of all is kept`;
  app `SwarmNotify.parse(null)` and an unknown word are `mentions`; `a chat nobody set tells no new message; only a chat set
  to All new messages does`. They pass at once: the default already holds, and these keep it (no red phase; say so in the
  PR's evidence).
- [ ] **Step 2: Run** each file. Expected: PASS.
- [ ] **Step 3: Rewrite** the table in `docs/phone-notifications.md` to Ring / No ring with the new rule, the shared task slot
  and the tests that pin each row; keep the "Where each one comes from" section true.
- [ ] **Step 4: Commit.**

### Task 7: Evidence and Ready

- [ ] Run, in `backend/`, `npm test`; in `mobile/`, every file named above with `--concurrency=2`, rerunning any file lost to
  a flutter_tester connection error alone; `flutter analyze` on the changed Dart files; `npx tsc --noEmit` in `backend/`.
- [ ] For each task, check out the commit before its code and show its tests failing (red), then the commit with the code
  passing (green); post both in a PR comment.
- [ ] Run the changed behaviour once in the iOS simulator and once in the Android emulator (name the device with `-d`; never
  the attached iPhone): a person's tag, an agent's tag, a decision with the same task stuck. Record what each showed.
- [ ] Mark the PR ready and tell River (the Reviewer and Tester for this run are put on when it is Ready); Tony's iPhone
  test waits until he says the phone is free.
