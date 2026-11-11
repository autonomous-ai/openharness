# Activity shows only what needs you (Diego, 2026-11-04)

Mockups: `desktop/mockup/activity-slack.html` (chosen layout) and `desktop/mockup/activity-needs-you.html` (the rules), in the
main checkout's gitignored mockup folder.

## What Diego asked

- The red number on Activity is too high (11 on 2026-11-04), and most of what it counts does not need him. It should count
  only what he must decide himself.
- Anything he leaves untouched for a day goes to the PM, who handles it.
- A **Let PM decide for all** button.
- **Mark read** for Mentions and for thread replies.
- A calmer view, organised the way Slack's Activity is: one list at a time, each row saying who said what.

Choices Diego made: count decisions and agents that asked him by name; tags leave the number. An agent waiting on him that
is left for a day is answered by the PM.

## How it works today (main 4f5f7425c)

- The number is `SuperTabActivity.count` (`desktop/lib/super_tabs/activity.dart:225`): open tags + `decisionsWaiting` +
  tasks with status `needs_human`/`blocked` whose `askedOf ?? requesterId ?? ownerId` is the reader. A stuck task nobody
  was asked about counts for its requester or the Swarm owner.
- The sidebar falls back to `mentionsWaiting + decisionsWaiting` before Activity loads (`project_sidebar.dart:1027`).
- The `decided` set that keeps a task with an open decision from counting twice is built from the decisions **loaded on
  the client**, while the decision part of the number is the server's count. Until Activity is opened once, such a task
  counts twice.
- An agent asks a person by name only through `work.status` with `ask` (`backend/src/superTabs/commands.ts:3312-3333`),
  which writes a decision and sets `askedOf`. So "an agent asked you by name" is a decision, except when the asker already
  has `MAX_OPEN_DECISIONS` (20) open for that person: then `askedOf` is set and the decision is not written.
- A `needs_human` or `blocked` status already reaches the task's lead (`commands.ts:3357`). The PM hears about a stuck task
  at once; only the person's number also counted it.
- **Let PM decide** exists for one decision at a time: `decision.answer` with `delegate: true` takes the recommended
  option, which every decision must have (`decisions.ts:63`, `:121`). Nothing delegates on its own, and nothing records
  when a person set a decision aside (Not now is local to Desktop: `controller.decisionsAside`).
- The view stacks Needs you, New replies and Done today on one page. Every mention row reads "X mentioned you in
  # project", every row is bold, and a thread row's title is the root message's whole text.

## Behaviour

### The number (Desktop)

The Activity number counts only **Needs you**:

- every open decision asked of the reader;
- every task whose agent waits on the reader by name (`assignment.askedOf` is the reader, status `needs_human`) and that
  has no open decision of the reader's.

Tags, thread replies and stuck tasks nobody was asked about are not counted. A stuck task with no `askedOf` stays with the
PM, who was told when it got stuck; it no longer falls to the requester or the Swarm owner in Activity.

The decision part is the server's `decisionsWaiting` until the reader's decisions are loaded, then the loaded list. The
`decided` set is only applied to the loaded list, so a task with an open decision never counts twice.

The Activity row is bold when the number is above zero or a tag or followed thread is unread. With nothing counted it shows
no number. The sidebar's fallback before Activity loads is `decisionsWaiting` alone.

### A decision left for 24 hours goes to the PM (backend)

A decision still unanswered **24 hours after it was asked** (`createdAt + 24h`) is left to the PM: answered with its
recommended option and recorded as `delegated: true, overdue: true`. The clock does not restart. Not now and Hide stay
local to Desktop, as today.

- The sweep runs hourly in the worker. Each pass reads the waiting decisions asked between 8 days and 24 hours ago, at most
  500, oldest first, so a row that failed or did not fit is tried again next hour until it is 8 days old. Each answer goes through `decision.answer` as the asked person, with
  `operationId = overdue-decision-<id>`. A repeated pass or a person answering at the same moment replays or gets
  `DECISION_ANSWERED`, never a second answer.
- Withdrawn decisions, decisions whose work is over and routing reflections (which expire on their own after 7 days) are
  skipped.
- The notice in the conversation says: "A decision asked in this conversation waited 24 hours, so it was left to the
  {PM name}, who took its recommended option." The PM's line in the person's Buddy chat is the one a delegated answer
  writes today. The leaderboard gives the person no credit, as for any delegated answer (`recordDecision`).
- A pass with any failure logs `[swarm-sweeps] overdue decisions failed` at error level with the count and error codes,
  every time; the decisions stay waiting and the next pass retries. A person no longer in the Swarm or Workspace is skipped.

A task waiting on the reader by name with no decision (the 20-decision cap) is not delegated: it has no recommended option.
It stays in Needs you, and its row's Open takes the reader to the task. That case is rare.

### Let PM decide for all (Desktop)

The Needs you tab shows a bar above its list: "{PM name} takes over anything you leave for 24 hours" and a button **Let
{PM name} decide for all**. The name is the coordinator's when every listed decision is in one project, else "the PMs".
The button is shown while at least one listed decision can be delegated.

Pressing it opens a confirmation: "Let {PM name} decide all {n}?", naming how many decisions it answers ("{PM name} takes
each one's recommended option"), with Cancel and **Let {PM name} decide**. Confirming sends one `decision.answer` with
`delegate: true` per decision, then reads the lists once. Tasks without a decision and tags are not included. A decision
that fails keeps its card's existing failure line and Retry.

### Mark read (Desktop)

- **Mentions:** hovering a row shows **Mark read**, which is today's `mention.done` (it replaces the Mark done label). The
  bar above the list has **Mark all read**, which sends `mention.done` for every unread mention listed, then reads once.
- **Threads:** hovering a row shows **Mark read**, which moves that thread's read mark to its newest reply
  (`controller.markThreadRead(conversationId, rootId, lastReplySequence)`). **Mark all read** does it for every listed
  thread. Unfollow moves to the row's second hover action.

Neither opens anything. Mark all read never touches decisions.

### The view (Desktop)

Activity has three tabs, one list on screen at a time: **Needs you** (red count), **Mentions** and **Threads** (grey
counts of unread rows). It opens on Needs you when it has something, else on the tab with unread rows, else Needs you.
The tab is kept while the view is open, and not saved.

- **Rows** carry an avatar (the author's initial and colour), the author's name, "in # {project}" (the lock mark for a
  private project), the time at the end, and a one-line preview under them. An unread row has a blue dot at its start; a
  read row is not bold and its preview is fainter.
- **Days** split each list into Today, Yesterday and Earlier.
- **Needs you rows** show the question as the preview and its options as buttons under it, the recommended one marked; a
  tap answers. Its end shows "PM in {h}h": hours until `createdAt + 24h`, rounded up, "PM in <1h" in the last hour and
  amber under 2 hours. A task row reads "{agent} is waiting on you" with its question as the preview, and Open.
- **Mentions** lists unread mentions, then recently answered ones (`mentions.earlier`). Mentions from the same author in
  the same conversation and thread that follow each other in the list fold into one row: the newest preview and
  "+{n} more from {author}". Mark read on a folded row marks all of them. An **Unreads only** switch hides read rows.
- **Threads** lists followed threads with unread replies (`attention.shown` where `isNew`). A row's title is the thread's
  subject; its preview is "{last replier}: {last reply text}" (falling back to the root author and text), then "# {project}";
  its end shows "{n} new". **Unreads only** applies here too.
- **Thread subject:** if the root text has a `Title: ` the subject is what follows it up to " — ", ". " or the line's end;
  otherwise the root's first line. Cut to 90 characters with an ellipsis.
- **Empty Needs you:** "Nothing needs you", and when the PM answered any of the reader's decisions today, "{PM name}
  handled {n} for you today" with **See what**, which lists them with the option chosen. Done today is removed; shipped
  tasks remain in their chats and the Tasks view.

### Out of scope

The menu bar list, the phone, the dial and their badges keep their counts. Reactions, saved views and a dense layout are
not added. No change to how tags are made, resolved or expired.

## Design

- **Growth:** one optional field (`overdue`) on existing `SuperTabDecision` rows; nothing new is stored per read. Decisions
  are removed as today.
- **Concurrency:** the sweep answers through `decision.answer`, whose `recordAnswer` updates only waiting rows; a racing
  answer wins once. The receipt id makes a repeated pass a replay.
- **Read cost:** the hourly query reads only waiting decisions asked in the last 8 days, through a new
  `[answeredAt, createdAt]` index (`decision_waiting_created`); answered rows are never examined. Desktop reads no new list.
- **Scale:** at 10x waiting decisions the read grows linearly (capped at 500 a pass); the warning metric is the pass's `overdue` count and
  duration in the `[swarm-sweeps] done` log.
- **Compatibility:** older Desktops ignore `overdue` and show "PM decided"; the new Desktop treats a missing `overdue` as
  false. Older backends have no sweep; the new Desktop still works and only its "PM in" hint is never honoured.
- **Migration + rollback:** `overdue` is optional (no migration). The index is added by the backend release's schema step;
  rollback drops it (`db.SuperTabDecision.dropIndex('decision_waiting_created')`) and reverts the release.
- **Audience:** the sweep acts as the asked person and through the same `answerable` check; Desktop changes only presentation.
- **Identity:** the answer is recorded as the PM's choice (`delegated`), never the person's own, and earns them no credit.
- **Failure:** a failed pass logs every time and retries next hour; a failed send from the button keeps the card's failure
  line and Retry.
- **Platforms:** backend; Desktop on macOS, Linux, Windows and web (the same Flutter screen). Phone and dial unchanged.
