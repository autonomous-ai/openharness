# Threads on the phone: a named row on Home, and a New on the thread line

- Date: 2026-11-06
- Scope: the phone app only (`mobile/`). Desktop and the backend do not change.
- Base: `origin/main`, branch `feat/mobile-swarm-threads-visible`
- Prototype: [2026-11-06-swarm-threads-visible/prototype.html](2026-11-06-swarm-threads-visible/prototype.html).
  Open it in a browser. It switches between the build ("Proposed") and `main` ("Before"), in both
  phone themes, with made-up messages.
- Status: **implemented**. Dee found Threads "a bit hidden". Tony asked for one prototype after
  Slack, then for it to be built.

## 1. Goal

Someone who opens the phone to catch up should see, without looking for it, that a thread they
follow has new replies, and reach it in one tap. Home must stay short.

## 2. What was wrong

Paths are relative to `mobile/lib/`.

1. **Threads had no name.** Since 2026-11-04 the only way in was an unlabelled icon in Activity's
   top bar, next to You (`swarm/swarm_activity_page.dart`). Its glyph (two speech bubbles) is close
   to Buddy's tab glyph (one bubble). Home had no way in at all.
2. **New replies gave no signal.** `SwarmThreadsMerge.unread` was written for a Threads row, but
   nothing drew it after the Home tiles went.
3. **A tag inside a thread was easy to lose.** It counts into the project's "@N" and is read on
   opening the project, but the reply sits in an older thread: the end of the chat shows nothing
   new.
4. **"N replies" did not read as a link in the dark.** It used the palette accent (Graphite
   `#bdcbdc`), close to body text, and it looked the same whether its replies were read or not.

**Biggest issue:** Threads had no name and no signal, so new replies sat unseen until someone went
looking for them.

## 3. What Slack does

From Slack's help center and its own write-up of the 2023 mobile redesign:

- **Threads is at the top of Home on mobile.** "From Home, tap Threads at the top" lists the threads
  you follow, and threads with unread replies come first.
- **A dot for replies, a number for what needs you.** In Slack's Activity, a dot meant only thread
  replies were unread; a number was kept for mentions, invitations and apps.
- **People open the phone to catch up.** Slack measured 15 to 20 opens a day of 20 to 30 seconds
  each, and built Home around getting to unread conversations fast.
- **Labels stay.** Slack tried icon-only tabs to fit more of them, and dropped the idea because it
  "came at the expense of two of Slack's non-negotiables: accessibility and comprehension". It cut
  five tabs to three instead.
- **Reply in thread** is a tap on the message, then "Reply in thread", or the reply box of an
  existing thread. The phone already works this way.

Sources:

- [Slack Help: Use threads to organize discussions](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions)
- [Slack Help: Triage notifications in the Activity tab](https://slack.com/help/articles/19693583638803-Triage-notifications-in-the-Activity-tab)
- [Slack Help: Activity tab (legacy)](https://slack.com/help/articles/45573197224467/)
- [slack.design: Re-designing Slack on mobile](https://slack.design/articles/re-designing-slack-on-mobile/)

Slack's documents do not describe how its "N replies" line under a message looks, so the New pill
below is our own call, not something taken from Slack.

## 4. What changed

1. **Home: one "Threads" row** between the need-you line and the projects, drawn like a project row
   with a glyph in place of `#`, 44 pt or taller. It is quiet while nothing is new. It turns bright
   and semibold, with a dot, while a followed thread has replies the person has not read. It shows
   no number. VoiceOver reads "Threads, new replies". A tap opens Threads for the Swarm Home shows.
2. **Activity: the Threads icon is gone.** Its top bar keeps You only, so there is one named way
   in.
3. **Chat: the thread line reads as a link.** "N replies" is a blue that holds 4.5:1 on both grounds
   (`AppCard.accentStrong`: `#1E40AF` light, `#5C7CFF` dark), and the faces grow from 20 to 24. While
   a followed thread has replies the person has not read, a filled **New** stands where "Last reply
   …" was. VoiceOver reads "N replies, new replies".

Unchanged: Home's top bar, the need-you line, the projects and "Other projects", the Threads page,
the Thread page, and how a reply is started.

## 5. Decisions

### D1. A named row, not an icon and not tiles

- **Why:** an icon was the cause (2.1), and Slack gave up unlabelled tabs for the same reason.
  Home's tile bar (away, Threads, Agents) was removed on 11-04 as too much for Home, so it does not
  come back. One row is the least Home can carry and still name Threads.
- **Cost:** Home has one more row. It stays quiet while there is nothing new.

### D2. A dot, never a number

- **Why:** a tag inside a thread already shows as "@N" on its project row and in Activity's count.
  A number on Threads would count it a third time. Slack also keeps the dot for plain replies.
- **Cost:** the row does not say how many threads are new. The Threads page does.

### D3. One source for "new": the server's unread list, less what this phone has read since

- `SwarmThreads.threadsUnread` and `SwarmThreads.hasNewReplies(conversationId, rootId)` take the
  followed threads the server lists as unread, and drop a thread once the read marks
  (`SwarmReadMarks.threadThrough`, the newest of the server's mark and this phone's) reach its newest
  reply.
- **Why:** the server's list alone lags. It is read at most every 15 s, so the dot would stay after
  the person read the thread. Read marks alone would show New on every thread never opened, the
  ones the person does not follow included.
- **Cost:** none on the server. A thread read on another device clears once that device's mark
  reaches this phone.

### D4. New only on threads the person follows

- **Why:** it is the same rule as the Threads page and Slack's. A busy chat would otherwise show New
  under most roots.

### D5. The strong blue for the link, faces at 24

- **Why:** the palette's accent is a near-grey in Graphite dark, so the count looked like text.
  `AppCard.accentStrong` is the blue already used for links on cards and passes 4.5:1 in both
  themes. At 24 the faces can be told apart.

### D6. Closing the Threads page tells the others after the frame

- Home's row and a chat's thread lines now listen to the same `SwarmThreads` as the Threads page.
  The page closes its threads when it goes, and that close notified them while the framework was
  tearing the page down. Going back from Threads to Home threw "setState() or markNeedsBuild()
  called when widget tree was locked" in debug.
- The page now closes, leaves the session and disposes its merge after the frame whenever the tree
  is being built or torn down (`_afterFrame` in `swarm_threads_page.dart`). Outside a frame it does
  so at once, as before.

### D7. Left as they were

- **Thread tags still count into the project's "@N".** Changing it changes `swarmProjectNews`,
  which matches Desktop (#2927). It needs both apps to move together.
- **No reply box inside the Threads list.** Slack has one; each card would need its own composer.
  A tap still opens the thread in its chat.

## 6. Done when

1. Home shows one "Threads" row between the need-you line and the projects, at least 44 pt tall,
   with no number in it.
2. The row is bright with a dot while a followed thread has unread replies, and goes quiet as soon
   as this phone reads past the newest reply, with no new read of the list.
3. Activity's top bar has You and no Threads icon.
4. "N replies" is `AppCard.accentStrong` in both themes, with faces 24 wide.
5. A followed thread with unread replies says New on its line until it is read. A thread the
   person does not follow never does.
6. Going back from Threads to Home raises no error.
7. Light and dark screenshots at 390 pt of every screen that changed.

## 7. Code map

- `swarm/swarm_threads.dart`: `threadsUnread` and `hasNewReplies` (D3).
- `swarm/swarm_home_rows.dart`: `SwarmHomeThreadsRow` (D1, D2).
- `swarm/swarm_page.dart`: a `SwarmThreadsMerge` over the Swarms Home shows, and `_threadsRow`.
- `swarm/swarm_activity_page.dart`: the top bar without the icon.
- `swarm/swarm_thread_line.dart`: link colour, faces, `fresh`, `SwarmNewPill` (D4, D5).
- `swarm/swarm_conversation_page.dart`: the message list also listens to the Swarm's threads and
  passes `fresh` to each thread line.
- `swarm/swarm_threads_page.dart`: `_afterFrame` (D6).

## 8. Tests

- `test/swarm/swarm_threads_test.dart`: unread less what was read since. Covers a read past the
  newest reply clearing at once with no list read, only server-listed threads counting, another
  device's mark, an older server with no reply sequence, and nothing before the marks load or after
  access is lost.
- `test/swarm/swarm_home_test.dart`, group "the Threads row": its place, height and no number; bright
  with a dot, semantics, and a tap opening Threads; the dot going after a read; nothing while the
  Swarms are still loading; back from Threads to Home without an error (D6).
- `test/swarm/swarm_activity_page_test.dart`: the top bar has You alone.
- `test/swarm/swarm_thread_line_faces_test.dart`: the count's blue in both themes, "Last reply"
  when read, the New pill and its semantics when not.
- `test/swarm/swarm_chat_test.dart`: New on a followed thread until it is read; never on one not
  followed.
- `test/swarm/swarm_threads_shots_test.dart` (run with `SWARM_THREADS_SHOTS=<dir>`): Home, the chat
  with New and once read, Activity, and the Threads page, at 390 pt in both themes.

## 9. Design (data)

This change stores nothing new and adds no route. It reads the followed-threads route
(`/api/super-tabs/<id>/threads`) the Threads page already used, from two more places.

- **Growth:** N/A because nothing is stored. The phone keeps the list in memory while something
  shows it.
- **Concurrency:** N/A because nothing is written. Read marks are written as before.
- **Read cost:** the list is read only while Home or a chat of that Swarm is up, only after the
  Swarm's changes say something moved, and at most once every 15 s (3 s while the Threads page is
  open). The dot clears from read marks the phone already has, with no extra read. A chat that is
  open now reads the list on the same terms, which it did not before.
- **Scale:** the route returns one page of followed threads. At 10x the threads a person follows, the
  first sign is the route's response time. The phone sends no more reads, because the 15 s gap
  bounds them.
- **Compatibility:** a server that does not have the route answers 404: no row dot and no New,
  as before. A server with no reply sequence on a thread keeps the server's word (D3).
- **Migration and rollback:** none. Reverting the PR brings back the Activity icon.
- **Audience:** the server enforces it. The route lists only threads in Swarms the person can read.
  Once access is lost, the phone drops the list it read and nothing shows as new.
- **Identity:** the signed-in account's session, as every Swarm read.
- **Failure:** a failed read leaves the row quiet and the lines without New. The Threads page still
  shows its own error and Retry.
- **Platforms:** iOS and Android draw the same widgets. Desktop does not change.

## 10. Open

- Whether thread tags should leave the project's "@N" (D7), on both apps together.
- A reply box inside the Threads list, if people ask for it.
