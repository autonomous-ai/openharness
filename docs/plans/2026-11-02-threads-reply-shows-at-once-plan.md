# Threads page: your reply shows at once

Task #2054, asked for by Scholes on 2026-11-02.

**Problem:** a reply sent from the box on a Threads card did not appear on the card. The card lists the replies it read
when it first showed, so the reader's own reply appeared only on a later visit, after an agent had answered, and looked unsent.

## Change

- `SuperTabAttention.ownReplies` gives a card the reader's replies: on their way or failed, from
  `SuperTabController.outgoing`, and those sent during this visit, which it notes on every controller change, because a
  send can go from on its way to read back between two frames.
- The card shows each under its replies: Sending…, then Sent, or the thread pane's Not sent with Retry and Delete.
- Only a reply first seen on its way is noted: a sent one stays in `outgoing` until its chat's transcript loads, and one
  from an earlier visit must not come back as new (review).
- A reply of files alone says Files.
- A failed reply keeps its whole text in that row. Text whose files fail to upload stays in the box, as today.
- A reply the card already read back is not shown twice (the same message id).
- A sent one shows only while the card is new; one on its way or failed shows on any card.

## Tests (each fails on main)

In `desktop/test/super_tab_attention_test.dart`: shows at once and stays after an answer, failed then Retry, failed then
Delete, not shown twice, not back as new on a later visit, and a failed reply's whole text.

## Design

- growth: `_ownThisVisit` holds one short entry per reply sent this visit, cleared when the view closes.
- concurrency: N/A because all of it runs on the UI isolate; sends keep the controller's one send lane.
- read cost: no new reads; `outgoing` is walked for each listed chat on a controller change while the view is open.
- scale: N/A; a person's own replies during one visit.
- compatibility: N/A; Desktop and web share this view, and no frame or endpoint changes.
- migration + rollback: none; revert the PR.
- audience: N/A; only the reader's own sends, and the server still enforces who may post.
- identity: the row is the signed-in account's own person row.
- failure: a refused or unanswered reply says Not sent and is never called sent.
- platforms: Desktop and the web build, which share `threads_view.dart`; the phone app is out.
