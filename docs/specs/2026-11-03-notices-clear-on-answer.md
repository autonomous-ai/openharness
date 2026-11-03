# Notices clear when you read or answer (Diego, 2026-11-03)

## What Diego asked

1. When a person settles something by chatting with the PM or the Buddy directly, not through the notification UI, the
   notification list still clears.
2. When a person opens a thread and reads it, its notifications clear by themselves.

Both apply to the two kinds of rows in the menu bar list:

- **Swarm tags** ("Orion tagged you"): `SuperTabMention` rows on the server, listed by Desktop's menu bar, Activity's
  Needs you, the phone and every badge.
- **Ready questions** ("Harness Swarm lead coordination – What do you want to do?"): an agent's open terminal question
  (Claude Code's AskUserQuestion) on this Mac, a `blockedAgents` entry in Desktop.

Choices Diego made: both kinds clear; a post to an agent clears **every** open tag that agent made for that person in the
Swarm.

## How it works today (main b8a64b53e)

- A tag resolves only when the tagged person posts in the **same conversation** (`mentions.ts resolveByReply`, called from
  `store.ts:1765`) or presses Done (`mention.done`). Reading resolves nothing.
- Activity hides a tag read past its message (`activity.dart mentionUnread`: the chat mark, or the thread mark for a thread
  reply), but the menu bar lists every unresolved tag (`status_menu.dart:253`), and the phone and the badges count the
  server's unresolved ones (`mentionsWaiting`). Four surfaces, two rules.
- While an agent's pane shows a question, a Swarm message to it is withheld (`teamHold` → `team_waiting_user`,
  `core/input.ts deliveryHold`). The person's answer in the chat never reaches the agent, and the Ready row stays.
  Diego's daemon logged `withheld: team_waiting_user` every 1-2 s for both Lead coordination sessions on 2026-11-03.
- A thread left open beside the chat marks its replies read while the app is hidden (issue sent 2026-11-03 as #15:
  `controller.dart _seeThread` gates only on a restored thread). With reading now resolving tags, this would clear tags
  nobody saw, so it is fixed here too.

## Behaviour

### Reading clears a tag (server)

When a person's read mark moves past a tag's message, that tag resolves with `resolvedBy: 'read'`:

- a tag on a message shown in the chat (a top-level message, a thread root, or a reply also sent to the chat) resolves when
  the **chat** mark reaches its sequence (`markRead`);
- a tag on a thread reply shown only in its thread resolves when that **thread's** mark reaches its sequence
  (`markThreadRead`).

This is the rule Desktop's `mentionUnread` already uses, so Activity, the menu bar, the phone and the badges agree.

Mark all read (Desktop, phone) moves every chat mark to its newest message, so it resolves every tag those marks pass, as
Slack's does. Desktop's Undo still works: it holds the marks back until its time is up (controller.dart `markAllRead`),
so nothing is resolved before then. A tag held for a task's
no-worker grace (`holdUntil`) that is read or answered before its time is never listed, as a reply already does today.

### Answering an agent clears its tags (server)

When a person posts (`message.send`), besides today's same-conversation rule, every open tag of theirs in the Swarm made by
an agent the post **answers** resolves with `resolvedBy: 'answer'`. The post answers:

- each agent among the post's recipients (who it was addressed to, the coordinator a plain post in a project chat reaches,
  the Buddy or session a Buddy-chat post reaches);
- in the person's own Buddy chat, also the coordinator of each project the Buddy speaks for: every project they can read
  for the one Swarm Buddy chat, the chat's own project for a project Buddy chat. The Buddy relays to those PMs, so talking
  to the Buddy is talking to them.

Tags made by people, and by agents the post does not answer, stay.

### The menu bar lists what Activity lists (Desktop)

The menu bar's Swarm rows leave out a tag read past (`mentionUnread`), as Activity does, so a read clears its row at once,
before the server's next answer.

### A person's message closes the question it answers (CLI)

When a Swarm message from **the machine's own person** is due for a Claude Code session whose pane shows a question, the
host presses Escape once, waits for the pane to redraw, and delivers the message if nothing else holds it. Claude Code
ends the question as declined and the message arrives as the answer; the daemon's `question_close` drops the Ready row
everywhere.

Escape is pressed only when all of these hold, checked again under the pane's writer lock just before the key:

- the pane reads `question_open` and shows the same question as the reading that decided it;
- the core holds a pending AskUserQuestion record for that agent (not only the screen heuristic);
- the message was written after that question opened (a message from before it answers something else);
- the core may still write the delivery (`canWrite`), and no question answer (dial, card, phone) holds the terminal;
- the question's free-text row holds no typed answer.

Never for a permission prompt (`permission_open`), never for a message from an agent or from another person of the Swarm
(they keep waiting, as today), never for another engine (Codex and the others keep waiting).

### A hidden thread pane marks nothing read (Desktop, #15)

The open thread's read mark moves only while its pane is on screen, by the same rule as the chat (`_viewIsVisible`). A
reply that comes while it is hidden is marked when the pane shows again.

## Design

- **Growth:** no new rows. Two more ways to set `resolvedAt` on existing `SuperTabMention` rows, which the 30-day TTL
  index already deletes.
- **Concurrency:** each resolve is one `updateMany` on the person's own rows: right after the read-mark write (`markRead`,
  `markThreadRead`, not in its transaction) or inside the command transaction (`message.send`). Resolving is idempotent:
  `waiting` in the filter.
- **Read cost:** a read-mark write reads the person's waiting tags in that one conversation (indexed by tabId, personId,
  createdAt, capped at 500 as `tagRows`) and their messages by id; most marks find none and stop after the first read. A post
  adds one `updateMany` keyed by the person and the answered agent ids.
- **Scale:** at 10x tags per person the first read is still one indexed page; the warning metric is the existing
  `mentionsWaiting` read time.
- **Compatibility:** `resolvedBy` is a free string; Desktop and the phone only test it for null, so `'read'` and `'answer'`
  show as answered in old clients. An old Desktop still lists read tags in its menu bar until the server resolves them,
  which it now does on the read. An old daemon keeps withholding; nothing breaks.
- **Migration + rollback:** none. Rolling back stops new resolves; resolved rows stay resolved.
- **Audience:** the server resolves only the acting person's own tags (`personId = user.sub`); a Team session has no marks
  and is refused as today.
- **Identity:** the person's own account, never the machine owner's.
- **Failure:** a resolve after a read mark is best-effort: a failure is logged as a warning and the mark still answers
  (the tag stays waiting until a later mark passes it, and the new Desktop menu bar already hides it). A resolve in a post
  fails the command with its other writes. Escape is logged either way (`question closed for a person's message` or
  `Escape sent, question still open`); if the pane still holds after it, the delivery is withheld as today and retried.
  A Team session resolves nothing, by read or by post.
- **Platforms:** server for every client; Desktop macOS/Linux/Windows menu bar; the CLI change is engine `claude` only.
