# Thread Replies Notify Everyone In The Thread (Design)

Task #2745, requested by anh Dee on 2026-11-04 ("lets improve notifications", cc Diego and Huy), from a thread where two
people who had replied got no notification for the replies after theirs.

## What people see

Today a reply in a thread writes an Activity row only for the person who started the thread (and the author of a quoted
message). The phone shows that row in Activity but posts no notification, and Desktop never notifies of a reply unless
someone tags the reader. The other people in the thread hear nothing.

After this change, as in Slack, a reply in a thread notifies everyone in it, on the phone, on Desktop, and in Activity,
without a tag:

```
 iPhone (locked or in another app)          Desktop (macOS notification)
┌──────────────────────────────────────┐   ┌────────────────────────────────────────────┐
│ HARNESS                         now  │   │ Mia replied in a thread                     │
│ Mia replied in a thread              │   │ openharness · Web launch: sounds good, I'll │
│ openharness                          │   │ ship the copy today                         │
│ Open Harness to read it.             │   └────────────────────────────────────────────┘
└──────────────────────────────────────┘   click: opens that thread at the reply
 tap: opens that thread at the reply
```

The phone keeps its rule that a notice on a locked screen never shows what was written (swarm_notices.dart); Desktop
shows the text, as its tag notices do. Nothing on any screen changes layout.

## Rules

1. **Who is in a thread**: the person who started it, every person who replied in it, and every person tagged in it, as the
   Threads view already counts them (read/followedThreads.ts). A person who pressed Follow on the thread is in it too only
   if one of those holds or they read it; see "Not done here".
2. A plain reply (a message, not a Swarm notice) tells everyone in the thread, except its author.
3. A Swarm notice in a thread (a route line, a card, "added X") tells only who it told before: the thread's starter and
   the quoted message's author. A notice for agents alone tells nobody.
4. **Unfollow** on a thread (the existing per-person thread mark, `follow: false`) stops its replies for that person.
5. A chat set to **Muted** (the existing per-person chat setting) writes no reply rows for that person: only tags notify.
6. A **tag** always notifies, through the existing tag rows (mentions.ts), in a muted chat or an unfollowed thread too. A
   person tagged in the reply itself gets the tag and no second reply row for the same message.
7. Never a row for your own message. Agents get no rows.

All seven rules are decided on the server, in the transaction that writes the reply, so the phone, Desktop and Activity
always agree: the clients notify for each new unread reply row and decide nothing else.

## Server design

`writeReplyActivity` (backend/src/superTabs/activity.ts) gets, for each thread a reply is in, the people in it from the
thread summary the same transaction has just computed (`refreshReplies` → `threadFacet`, pageReads.ts): its parts are
grouped by author and its mentions by person, so the root's author, each replier and each tagged person are there with
no extra read. `refreshReplies` returns those facets and `writeMessages` hands them on.

Reads per reply transaction:

| Read | Before | After |
| --- | --- | --- |
| root and quoted message by id | 1 | 1 (unchanged) |
| thread summary facet | 1 (already, for the summary) | 1 (reused) |
| thread marks by id (Unfollow) | 1, ≤2 ids | 1, ≤ N ids |
| chat settings by id (Muted) | 0 | 1, ≤ N ids, only when N > 0 |

Writes: one Activity row per person told (N), one `createMany`. N is capped at `REPLY_FANOUT` (100): the starter and the
quoted author first, then tagged people, then repliers, newest reply first. A Swarm today has 5–30 people; the PR measures
N and the reads per reply in a test.

The people are also filtered in memory against the Swarm's state: a person no longer in the Swarm, or one who cannot read
the chat now (`canReadGroup`), gets no row. The list still filters again when read, as today.

## Clients

- **Phone** (mobile/lib/swarm): `SwarmActivityFeed` already reads each Swarm's rows when its Activity digest moves. It tells
  `SwarmAnnouncer` of each reply row that is new since its first read and still unread; the announcer posts it once, unless
  the person is looking at that thread now (its `quiet` check). Tests run on the iPhone simulator only.
- **Desktop** (desktop/lib/super_tabs): a new `SuperTabReplyNotices` reads `/activity` when the Swarm's Activity digest
  moves (the digest is already in the snapshot) and posts a system notice for each new unread reply row, unless that thread
  is open and the window in front. Not on the web, as tag notices. The Settings switch for system notifications applies.

## Design (feature design rules)

- growth: the existing hourly sweep deletes Activity rows after 30 days (sweepActivity); this adds rows, not a collection.
- concurrency: rows are written in the reply's own transaction; two replies at once each write their own rows (ids by
  message and person), and the summary's existing write conflict retries one of them.
- read cost: clients read `/activity` only when the digest moves, as today; the server adds one by-id read of chat settings
  per reply that tells anyone.
- scale: 10x people in a thread is still capped at 100 rows a reply; the metric that warns first is the reply
  transaction's time and the Activity collection's growth per day.
- compatibility: no new field; an older phone or Desktop shows the extra rows in Activity and simply does not notify.
- migration + rollback: none; rolling back stops writing the extra rows, and those written expire in 30 days.
- audience: the server writes rows only for people who can read the chat, and the list checks again when read.
- identity: rows are per person id; nothing uses a machine owner's login.
- failure: a failed Activity read on a client is retried when the digest moves, as today; nothing is dropped silently on
  the server, since the rows are in the reply's transaction.
- platforms: backend; iOS and Android phone app; Desktop on macOS, Windows and Linux (no notice on the web).

## Not done here

- A person who pressed Follow on a thread they never posted in: finding them needs a read of marks by thread, which has
  no index. Proposal for the PM if people ask for it.
- Merging a reply notice with a chat's "All new messages" notice for a reply also sent to the chat.
