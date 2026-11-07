# A person's own Buddy asks them in Decisions: implementation plan

> Written by the task's Engineer by superpowers writing-plans, and implemented by the same Engineer task by task, test first
> (project instructions, Roles › Engineer). Task #4525.

**Goal:** Everything waiting on a person shows in their Decisions, their own Buddy's questions included (anh Dee, 11-07 17:08:
about nine of his Buddy's questions stayed buried in his chat).

**Architecture:** `decision.ask` opens to a Buddy, in its own chat and only for its own owner, checked by the server. Its rows
carry a `kind` (`buddy`, or `buddy-send` for a line waiting for the owner's OK to post to a project's PM) so the 24-hour PM
sweep never takes them and "Let PM decide" never shows. A `buddy-send` row stores the exact words with the proposal's goal,
scope, priority and project, and offers Send and Not now; Send, from Decisions or from the owner's ok in chat, posts those
stored words through the same code as `buddy.propose`. Answered in Decisions: one line in the Buddy chat tells the Buddy.
Answered in chat: the Buddy settles the decision with `decision.answer` naming its owner's message there.

**Tech Stack:** TypeScript backend (Prisma on MongoDB, vitest), CLI skill text (TypeScript), Flutter Desktop.

**Spec:** the task brief of #4525 (conversation ff1d80cd1b7fe08df01be8f8).

## Global Constraints

- Server-enforced audience: a Buddy adds Decisions only for its own owner at their current membership, only in its own chat.
- MAX_OPEN_DECISIONS per asker still holds (writeDecisions).
- Send posts exactly the stored words; nothing else of the private chat. A send decision has no default time and is never
  taken by a sweep.
- Compatibility: backend ships first. `buddy.propose` stays for older Buddies and for proposals with files; new fields are
  optional; Desktop reads the new list fields with defaults, so an older backend still works.
- Desktop copy by desktop/design/desktop-design-system.md: buttons 1-2 words, verb first, no filler.

## Review Focus

- Only the owner's own Buddy can add a Decision for them (another person's Buddy, another chat, a project agent in a Buddy
  chat: refused).
- Send posts exactly the words shown, once (a concurrent second answer conflicts).
- An answer in either place settles it in both.

## Design

- growth: a Buddy's open decisions are capped by MAX_OPEN_DECISIONS per asker and person; answered ones go after the
  ledger's weeks (writeDecisions), as every decision.
- concurrency: the command's transaction; recordAnswer's conditional write makes the first answer win.
- read cost: no new reads on a request path beyond the owner message for a chat settle (by id, one indexed findFirst, and
  the chat's newest 50 rows as buddy.propose reads).
- scale: rows per person bounded by the cap; no new query shapes. The overdue sweep's `$match` adds `kind $nin` on the same
  index range.
- compatibility: optional `send` field and new `kind` values; older Desktops show a Buddy decision as any other and their
  Let PM decide is refused with a message.
- migration and rollback: none; an optional field. Rolling back leaves rows an older backend lists as plain decisions.
- audience: the server checks the asker is the person's own Buddy, and the answerer is the person (or that Buddy with its
  owner's message).
- identity: posts as the owner only through the stored words they okayed, as buddy.propose does.
- failure: refusals have names (BUDDY_ASKS_OWNER, BUDDY_DECISION_UNASKED); a failed Send leaves the decision open.
- platforms: backend (Linux), CLI skill (all), Desktop macOS/Windows/Linux/web.

## Task 1: A Buddy asks its owner, and only its owner

**Files:** backend/src/superTabs/decisions.ts, buddies.ts, commands.ts, prisma/schema.prisma, buddyDecisions.test.ts (new)

**Interfaces:** `decision.ask` from a Buddy: `{conversationId: its chat, personId: owner, projectId?, questions}`; a question
is either the usual one or `{send: {text, goal, scope, priority, projectId?}}`.

- [ ] Failing test: a Buddy's ask in its chat for its owner opens decisions of kind `buddy`; for another person, in another
  chat, and a project agent asking in a Buddy chat are refused; a send question stores its words with Send / Not now and
  refuses a default time.
- [ ] Code: BUDDY_COMMANDS takes decision.ask and decision.answer; checkBuddyAsker; askDecisions takes a project for a chat
  with none; schema `send Json?`.

## Task 2: Answers settle in both places; Send posts the shown words

**Files:** decisions.ts, commands.ts, store.ts, overdueDecisions.ts, buddyDecisions.test.ts

- [ ] Failing test: the owner's answer writes one line in the Buddy chat to the Buddy and no PM notice; Let PM decide is
  refused for a Buddy decision; Send posts the stored words in the project chat as the owner, Not now posts nothing; the
  Buddy settles with its owner's message, never Send without one, never a stale one; the overdue sweep skips Buddy kinds.
- [ ] Code: answerDecision Buddy branch; the propose body shared with Send; store loads the owner message and the project
  chat; overdue `$nin`.

## Task 3: The Buddy skill uses it

**Files:** cli/src/lib/swarmSkills.ts and its spec

- [ ] Failing test: the Buddy skill names decision.ask for its owner and the send decision.
- [ ] Code: skill text.

## Task 4: Desktop shows a Buddy's decisions like any other

**Files:** desktop/lib/super_tabs/decisions.dart, decisions_view.dart, desktop/test/super_tab_decisions_test.dart,
desktop/design/desktop-design-system.md

- [ ] Failing test: a Buddy decision offers no Let PM decide; a send decision shows its words with Send and Not now, no
  "Recommended" mark and no second Not now.
- [ ] Code: `fromBuddy`/`send` read from the list.
