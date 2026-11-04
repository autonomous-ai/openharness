# Thread Replies Notify Everyone In The Thread Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** A reply in a thread notifies everyone in it (who started it, replied in it or was tagged in it) on the phone, on
Desktop and in Activity, without a tag. Unfollow on a thread stops it; a Muted chat stays quiet except tags; a tag always
notifies; never for one's own message or a notice for agents.

**Architecture:** The server decides every rule in the reply's transaction: `writeReplyActivity` (backend activity.ts)
writes one Activity reply row per person in the thread, taking the people from the thread summary facet that
`refreshReplies` (pageReads.ts) already computes in the same transaction, filtered by Unfollow marks, Muted chat settings,
the reply's own tags and who can read the chat. The phone (`SwarmActivityFeed` → `SwarmAnnouncer`) and Desktop (new
`SuperTabReplyNotices`) already learn of new rows from the Activity digest; each posts a notice for a new unread reply
row and decides nothing else.

**Tech Stack:** TypeScript, Prisma on MongoDB, Vitest with an in-memory replica set (backend/integration); Flutter/Dart
with flutter_test (mobile, desktop).

**Spec:** [2026-11-04-thread-reply-notifications-design.md](2026-11-04-thread-reply-notifications-design.md), task #2745.

## Global Constraints

- PR body first line: `Requested by dee@autonomous.ai through Harness.`
- No schema change, no new collection, no new index: reads are by `_id` only.
- Rules live on the server; clients only notify for new unread reply rows.
- Phone tests on the iPhone simulator only; never install on anyone's phone. Desktop tests use a memory store and a fake
  sign-in; nothing signs the Mac out of the real CLI.
- Swarm code stays out of cli/src/core (nothing in cli is touched).
- Phone notices never show message text (locked screen rule, swarm_notices.dart); Desktop's show it, as tag notices do.

## Review Focus

1. The people in a thread come from the facet already computed in the transaction: no extra read of the thread's rows.
2. Each rule has a test that fails without it: starter, replier, tagged-in-thread, Unfollow, Muted chat, tag in a Muted
   chat, own message, agent-only notice, Swarm notice (starter only), a person who cannot read the chat.
3. The fan-out cap and its order (starter, quoted author, tagged, repliers newest first).
4. Client notices: only rows new since the first read, unread, not one's own thread open now; one notice per row.

## Task 1: Server fan-out to everyone in the thread

**Files:**
- Modify: `backend/src/superTabs/pageReads.ts` (`refreshThreads`, `refreshReplies` return the facets by root)
- Modify: `backend/src/superTabs/store.ts` (`writeMessages` returns them; the command path passes them and the state on)
- Modify: `backend/src/superTabs/activity.ts` (`writeReplyActivity`)
- Test: `backend/integration/superTabActivity.test.ts`

**Interfaces:**
- `refreshReplies(tx, tabId, rows): Promise<Map<string, ThreadFacet>>` keyed by root id (empty for no replies).
- `writeReplyActivity(tx, tabId, state, messages, sequences, now, threads?: ReadonlyMap<string, ThreadFacet>)`; without
  `threads` it tells only the starter and quoted author, as before.
- `REPLY_FANOUT = 100` exported from activity.ts.
- No test seam in the code: the measure test counts rows written and Mongo commands made from the test itself.

- [ ] Write failing tests: a replier and a tagged person get a row for a later reply by someone else; the starter still
      gets one; a reply's author gets none; Unfollow stops a replier's rows; a Muted chat writes none for that person
      while a tag there still lists for them; a person tagged in the reply gets the tag and no reply row for it; an
      agent-only notice writes none; a Swarm notice reply (a sourced row) tells only the starter; a person who cannot
      read the chat gets none; the fan-out is capped at `REPLY_FANOUT` in the stated order.
- [ ] Run `npx vitest run -c vitest.super-tabs.config.ts integration/superTabActivity.test.ts`; watch them fail. Commit.
- [ ] Implement; run the same file and the files that import the changed functions; watch them pass. Commit.
- [ ] Measure: a test with a thread of 1, 10 and 50 people records rows written and Mongo commands per reply; paste the
      numbers in the PR.

## Task 2: Phone notice for a new reply row

**Files:**
- Modify: `mobile/lib/swarm/swarm_activity_feed.dart` (tell of new unread reply rows after the first read)
- Modify: `mobile/lib/swarm/swarm_notices.dart` (`SwarmAnnouncer.announceReply`, taken down when read)
- Modify: `mobile/lib/swarm/swarm_session.dart` (wire it; Activity's feeds exist from the session's start)
- Test: `mobile/test/swarm/swarm_activity_feed_test.dart`, `mobile/test/swarm/swarm_notices_test.dart`

**Interfaces:**
- `SwarmActivityFeed.onReply: void Function(SwarmActivityEntry entry)?`: each reply row new since the first read and
  unread, once.
- `SwarmAnnouncer.announceReply({swarmId, entry, project})`: title `<name> replied in a thread`, subtitle the project,
  body `Open Harness to read it.`, target the chat and message; not when `quiet`; once per row id (`SwarmTold`).

- [ ] Failing tests: first read posts nothing; a later read with a new unread reply posts one notice with that copy and
      target; the same row again posts nothing; a read row and a reaction row post nothing; quiet posts nothing.
- [ ] Watch them fail (`flutter test` on those files). Commit. Implement; watch them pass. Commit.
- [ ] Check on the iPhone simulator that the notice shows and its tap opens the thread.

## Task 3: Desktop notice for a new reply row

**Files:**
- Create: `desktop/lib/super_tabs/reply_notices.dart` (`SuperTabReplyNotices`)
- Modify: `desktop/lib/super_tabs/notifications.dart` (`superTabReplyNotice`)
- Modify: `desktop/lib/super_tabs/client.dart`, `desktop/lib/state/app_state.dart` (wire it as tag notices are)
- Test: `desktop/test/super_tabs/reply_notices_test.dart`

**Interfaces:**
- `SuperTabReplyNotices.of(controller).onReply: void Function(SuperTabReplyRow row)?`: reads `/activity` when
  `snapshot.activityDigest` moves; tells of each reply row new since the first read and unread, once; not while that
  thread is open and the window in front.
- `superTabReplyNotice(system, {web})`: null on the web; title `<name> replied in a thread`, body
  `<project> · <chat>: <text>`, click opens the thread at the reply.

- [ ] Failing tests: first read tells nothing; a new unread reply row tells once with that copy; the same row again,
      a read row, a reaction row, and a row of the thread open now tell nothing; a server answering 404 tells nothing.
- [ ] Watch them fail (`flutter test` on that file). Commit. Implement; watch them pass. Commit.
