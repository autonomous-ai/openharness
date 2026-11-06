# Board view: projects | board | Buddies

Requested by anh Dee, 2026-11-06 (thread in the harness project chat, 12:55-13:05). Ken designs the backend and
infra side; this is the frontend. Desktop first, then web, then phone, all on this one design.

## Why

- The project chat stresses the PM and makes it hallucinate: every person, agent and notice lands in one stream and
  the PM must answer all of it.
- lampOS ran on GitHub issues with lane labels (builder:x), a taken mark and a proposal label, and it worked: work is
  visible, claimed and closed in one place.
- So: the board replaces the project chat and GitHub issues. People talk to their own Buddies; a Buddy turns a talk
  into a proposal card; the PM only rules on cards.

## Layout (Desktop, three panes)

```
+- Swarm + left rail -+ +- harness . Board -----------------------------------------------+ +- Buddies ----------------+
| autonomous.ai v     | | [+ New proposal]        Lane: all v  Person: all v   Search     | | (*) My Buddy  ( ) Design  |
|                     | |                                                                 | | [+ New Buddy]             |
| Projects            | | PROPOSED (3)  TO DO (5)    DOING (4)     REVIEW (6)   SHIPPED   | |---------------------------|
|  > harness          | | +---------+  +---------+  +---------+   +---------+  +-------+  | | (chat with the selected   |
|    lamp             | | |[Desktop]|  |[CLI]    |  |[backend]|   |[Desktop]|  |[phone]|  | |  Buddy: the main chat)    |
|    computer         | | |Threads  |  |#3765 ...|  |#3747    |   |#3684    |  |#3607  |  | |                           |
| Decisions (2)       | | |select   |  | P1      |  |Answers  |   |Revoked  |  |1.3.83 |  | | Buddy: want me to propose |
| Mentions (5)        | | |Kelvin   |  |         |  |Headfix  |   |rev 2/2 v|  +-------+  | | this? [Propose to board]  |
| Threads             | | +---------+  +---------+  |test ..  |   |test 1/2 |             | |                           |
|                     | |                           +---------+   +---------+             | | [Message My Buddy..][Send]|
+---------------------+ +-----------------------------------------------------------------+ +---------------------------+
```

- **Left rail:** Swarm switcher, projects, Decisions, Mentions, Threads, as today. The Buddy entry leaves the left
  rail (it moves to the right pane). The project chat entry goes away; selecting a project opens its board.
- **Middle: the board**, the most important screen. It must look and feel like Trello: soft column backgrounds,
  rounded white (dark: raised) cards with a small lane colour strip, generous spacing, smooth scroll, no clutter.
  Light and dark, Harness design language (`scripts/check-ui-style.py`).
- **Right: Buddies.** A list of the person's Buddies (one today) and the selected Buddy's chat, which is the person's
  main chat. "+ New Buddy" appears when the backend supports more than one Buddy (Ken). A Buddy's reply can carry
  "Propose to board", which posts a proposal card with the Buddy's goal, scope and priority (the existing proposal).

## Columns and how a card moves

| Column | What is in it | How a card gets there |
|---|---|---|
| Proposed | proposals not yet ruled on | a person's "+ New proposal", or a Buddy's "Propose to board" |
| To do | accepted tasks with no one on them | the PM accepts (or reshapes) a proposal; a task opened directly |
| Doing | a crew member works on it | the task is assigned and working |
| Review | its PR is ready; review and test steps run | the task goes to review |
| Shipped | merged, and shipped once a release holds it | merge recorded; shipped mark from the release record |

- Only the PM (and a person with the PM's rights) moves a Proposed card: Accept → To do, Reshape (edit, then To do),
  Later (stays with a date), No (archived, with the reason shown on the card). Nobody else drags cards: every other
  move is the task's real state, so the board never lies.
- Blocked, needs a person, lost or stalled: a red or amber badge on the card in its column, not a column of its own.
  A card that needs a person shows their name.
- Shipped cards stay 7 days, then leave the board (still searchable).

## The card

- Front: lane chip (backend, CLI, Desktop, mobile, docs, from the task's area), `#number` and title (about eight
  words), priority dot (P0 red, P1 amber), who asked (avatar), who is on it (agent avatar), step chips (Review
  2/2 ✓, Test 1/2, Linux, Windows), PR link icon, age. Nothing else.
- Open (side panel over the board): the brief (goal, changes, constraints, checks), the comments (the task's thread
  today: people and agents comment here; this replaces the project chat), steps with verdicts, PR and CI, history
  (moves with who and when). The PM's ruling on a proposal sits at the top of a proposal card.

## Where the team-wide news goes

Releases out and outages show as a thin banner at the top of the board ("Desktop 1.3.84 is out", "internal builds
broken on main") with a link; it hides after a day. No chat is needed for them.

## What the backend already gives, and what goes to Ken

- Already there: tasks (number, title, priority, requester, area/lane, status, assignee), steps with verdicts, PR
  links and merge/ship records, task threads (comments), Buddy proposals with goal/scope/priority, a person's Buddy
  chat.
- For Ken: (1) proposals as their own records with a ruling (proposed/accepted/reshaped/later/no + reason), not only
  messages in the project chat; (2) more than one Buddy per person per Swarm; (3) a board read that returns one
  project's open cards and the changes since a cursor; (4) where the release/outage banner comes from.

## Design rules (docs/feature-design-rules.md)

- Growth: shipped cards leave the board after 7 days; archived proposals are kept, out of the default view.
- Concurrency: every move is a server command on the task (the PM's ruling, assignment, status); the UI shows the
  server's state and never moves a card on its own guess.
- Read cost: the board loads one project's open cards once, then reads changes since its cursor.
- Scale: 500 open cards in one project stays smooth (columns build lazily); board load time is the warning metric.
- Compatibility: older clients keep the project chat; the server keeps it until the board ships on every client.
- Migration and rollback: UI only, no data migration; rollback is a revert. No on/off switch (Ken).
- Audience: the server sends only cards the viewer can read; private tasks never reach the board.
- Identity: moves and comments are the person's own, never the machine owner's.
- Failure: a board that fails to load says so with Retry; never an empty board that looks real.
- Platforms: Desktop on macOS, Windows and Linux first (docs/windows-rules.md), then web (same layout, phone width
  shows one column at a time with tabs), then the phone app (columns as tabs, Buddies as its home).

## Done when (Desktop)

- Selecting a project opens its board; the project chat is gone from Desktop; left rail and Buddies pane as above.
- Cards show and move exactly as their tasks do, within a few seconds of the change.
- The PM can rule on a proposal from its card; a Buddy's "Propose to board" lands a card in Proposed.
- Widget tests with a memory store and a fake sign-in for the board, the card, the panel and the proposal ruling;
  light and dark screenshots of every screen; a recording on Windows with no window flash.
