# Final spec: people talk to their Buddies, the PM works from proposals, the Board is the project

Merged 2026-11-06 by River from Ken's business spec (backend, roles, flow) and anh Dee's frontend (layout and look,
thread in the harness project chat, 12:55-13:15). Where they differed, the call and who made it is marked **[merge]**.


2026-11-06. What people see and what each role does. Phase 1 (below) is already being built for Desktop by anh Dee's
decision; everything else is built after Dee and Ken approve this spec.

> **This is a large change.** It changes who talks to whom in every project: people stop talking to the PM, and the PM
> stops talking to people. Tasks running now that assume people chat with the PM, or that the PM relays to people, need
> replanning before they continue or ship (see "Work in progress" at the end).

## Why

The PM is the bottleneck today. Every person writes to it in the project chat, and it has to read, answer, route and
build in one thread:
- While it runs a command it hears no one, so people wait on it.
- Its context fills with conversation and with every answer it gives, and it forgets or misapplies the project's own
  rules (it had the rule and did something else).
- Its answers are spread over chat, threads and private lines, so nobody sees in one place what was asked and what
  became of it.

The fix is to split the two jobs:
- **Talking with people** goes to each person's own Buddies. A Buddy holds that person's context, one Buddy per
  purpose, so no context is shared or diluted.
- **Deciding and running the work** stays with the PM. It works only from proposals, by the workflow the project's
  instructions define, so each project still writes its own flow in words.

## What changes, in one view

| | Today | After |
|---|---|---|
| Selecting a project | Opens the project chat with the PM | Opens the project's Task Board; there is no chat with the PM |
| Who a person talks to | The PM, in the project chat | Their own Buddies |
| How work enters a project | A message to the PM, or a Buddy's proposal | A proposal (from a Buddy, or from the Board) |
| How a person hears back | The PM's reply somewhere in chat | The proposal's card on the Board, and their Buddy at three moments |
| Buddies per person | One | As many as they want, one per purpose |
| The PM's inputs | People's messages, proposals, notices | Proposals, answers on proposals, and the Swarm's notices |

## Roles

### Person
- Talks only to their own Buddies.
- Sees every project they belong to as a Task Board.
- Steers work from the Board: priority, pause, answering what is asked of them.
- Writes in a task's thread when they take part in that task (a tester's retest, a reporter's extra screenshot).

### Buddy
- A person's own assistant. A person may have several, each named for its purpose (for example Code, Research,
  Planning), so each keeps its own context.
- Talks with its person, helps shape an idea, and sends it to a project as a proposal with its person's agreement.
- Before sending, checks that the same thing is not already proposed or in work. If it is, it adds to that one instead.
- Answers the PM's questions about the proposals it sent: on its own when its context is enough, otherwise by asking
  its person and bringing the answer back.
- Tells its person, in one short line, at three moments of a proposal it sent: **decided** (accepted, reshaped,
  later or declined, with the PM's reason), **needs you**, and **shipped**. A person who disagrees with a decision says
  so through the same Buddy, on the card. *(Call made in drafting.)*

### PM
- Never chats with people, and is never in a person's conversation.
- Is woken when a proposal arrives. A P0 or hotfix proposal is handled before anything else; other proposals are
  handled in priority order.
- For each proposal, decides by the project's instructions and writes the result on its card:
  - **Accept**: it becomes a task in Next.
  - **Reshape**: the version it will do instead.
  - **Later**: and when it will look again.
  - **No**: and why.
- Asks what it needs to know on the card, to the Buddy that sent it, always with a default and a time. When the time
  passes it applies the default, except where a rule says a person must agree.
- Merges duplicates into one card, and everyone who proposed it is told.
- Runs the work by the project's instructions: tasks, crew, review, test, merge, release.

## The Task Board

What a person sees when they select a project. Five columns **[merge]** (Ken's; today's Board has Proposals, Next up, Working, Waiting, Shipped: Waiting folds into
Working with a mark, and Merged is new):

| Column | Holds |
|---|---|
| Proposal | Proposals the PM has not decided yet, and those waiting on an answer from their sender |
| Next | Accepted work not started yet, in priority order |
| Working | Work being done, and work waiting (on review, test, CI, a person, a decision), marked on the card |
| Merged | Merged, not yet released |
| Shipped | Released |

On each card a person can see:
- the proposal's words, who proposed it, and through which Buddy;
- the PM's decision and its one-line reason;
- any open question and its default and time;
- the task's state once there is one;
- a mark when the card waits on them.

Actions on the Board:
- Propose directly from the Board, for a person with no Buddy yet.
- Change priority and pause or resume a task, within the rights below.
- Answer a question or decision asked of them.
- Open a task's thread.

A "Needs you" bar at the top lists everything waiting on the reader in this project.

Who may do what on the Board:

| Who | May |
|---|---|
| Every member | Propose, answer what is asked of them, set P1–P3 on their own cards |
| The project owner and the project's top decider (for openharness: Dee), named in the project's settings | Set P0 on any card, pause or resume any task |
| The PM | Reorder priorities by the project's instructions, with a one-line reason on the card |

Setting P0 and pausing stay with a few people because a P0 goes ahead of everything and a pause stops other people's
work.

### Screens (Desktop) *(anh Dee)*

```
+- left (hide/show) ---+ +- harness . Board -----------------------------------------+ +- right (hide/show) ------+
| autonomous.ai v      | | Needs you: 2                     Search  Mine  Lane v    | | (*) Code  ( ) Planning   |
| Decisions            | |                                                           | | [+ New Buddy]            |
| Mentions             | | PROPOSAL   NEXT       WORKING     MERGED    SHIPPED       | |--------------------------|
|                      | | +-------+  +-------+  +-------+   +------+  +------+      | | the selected Buddy's     |
| Projects             | | |[CLI]  |  |[Desk] |  |[back] |   |#3628 |  |#3607 |      | | chat (the person's main  |
|  > harness           | | |title  |  |#3765  |  |#3747  |   |      |  |1.3.84|      | | chat), or a clicked      |
|    lamp              | | |Tuan . |  |P1     |  |Headfix|   +------+  +------+      | | card's chat              |
|    computer          | | +-------+  +-------+  |review |                           | |                          |
|                      | |                       +-------+                           | | [Message...]     [Send]  |
+----------------------+ +-----------------------------------------------------------+ +--------------------------+
```

- **Left:** Swarm switching, Decisions, Mentions and the projects list, as today. No Buddy entry and no Threads entry
  in it. A hide/show icon collapses it, remembered per person.
- **Middle: the Board,** opened by default when a project is selected, and the most important screen. It looks and
  feels like Trello: tinted columns with a bold title and count, raised rounded cards with a thin lane-colour strip, the
  title first and one quiet line (priority, who proposed or who works on it, PR), gentle hover, smooth horizontal
  scroll; calm, no heavy borders or red boxes; light and dark. The "Needs you" bar sits on top of it.
- **Right:** the person's Buddies (a list with + New Buddy) and the selected Buddy's chat, which is the person's main
  chat. Clicking a card shows that card's chat here instead (the task's thread, flat), with a header back to the
  Buddy. A hide/show icon collapses it, remembered.
- **No Threads feature.** There are no nested thread replies on Desktop: a task's conversation is its card's one flat
  chat, and old thread replies show inline in time order. **[merge]** Ken keeps the task's conversation open to people
  taking part in it; Dee removes the Threads feature. Both hold: the conversation stays, as the card's chat; only the
  separate Threads view and reply-in-thread go.

## A proposal's life

1. A person talks with one of their Buddies. When an idea is ready, the Buddy shows the exact proposal and the person
   agrees.
2. The Buddy checks for an existing proposal or task about the same thing. If there is one, it adds to it and stops.
3. The proposal goes in with its goal, why, "done when" and any evidence (screenshots, logs). A proposal missing one of
   these is refused with what is missing.
4. The PM wakes and decides: Accept, Reshape, Later or No, written on the card.
5. If the PM needs more, it asks on the card. The sending Buddy answers, or asks its person and answers. Past the
   time, the PM applies the default.
6. Accepted work runs through the project's workflow. The card moves Next → Working → Merged → Shipped.
7. The sending Buddy tells its person when the proposal is decided (whatever the decision), when something needs them,
   and when it ships.
   Every other step is visible on the Board only.

If the Buddy that sent a proposal has been removed, its messages go to the person's default Buddy.

## Steering and teaching the PM without chat

| A person wants to | They |
|---|---|
| Change what goes first | Change the card's priority on the Board |
| Stop something | Pause the task on the Board |
| Give a lasting rule ("from now on…") | Send a rule proposal through their Buddy. The PM decides it like any proposal (Accept, Reshape, Later, No); an accepted rule is saved into the project's instructions word for word with who gave it. A person with the right to edit the instructions may also edit them directly *(call made in drafting)* |
| Decide something a rule names them for (for example a production write, a product decision) | Answer the decision, which reaches them through their default Buddy and the Board's "Needs you" bar |

## When an agent needs a person

An agent working on a task that needs a person's answer asks that person directly, never through the PM:
- The question goes to the person's default Buddy and shows in the Board's "Needs you" bar, always with a default and
  a time.
- It goes to one person: the task's requester by default, or the person a rule in the project's instructions names for
  that kind of decision (for example a production write, a product decision).
- The PM only sees the card marked as waiting on that person. Past the time, the default applies, except where a rule
  says the person must agree; only then does the PM step in.

## Talking about a task

A task's thread stays open to people:
- the people taking part in it can write there (the requester, a tester, a reviewer who is a person);
- they talk with the agents working on that task.

Only the chat with the PM goes away.

A thread is for the task as accepted. New scope written there ("also do X") is not taken up by the agents: they say
so in one line, and the person proposes it through their Buddy. *(Call made in drafting.)*

## People without their own machine

A person whose Buddy cannot run on their own machine (phone only, no machine yet) gets their Buddy on one of the
Swarm's shared Team machines, so they can start with no setup:
- It runs on the Team account's subscription, as Team agents do today.
- A person has at most one Buddy on Team machines, counted within their Buddy cap.
- Once the person signs in their own subscription, their Buddy uses theirs.

Until they have any Buddy, they can propose straight from the Board.

## Many Buddies

- A person creates, names and removes their own Buddies. The PM never manages them.
- Buddies belong to the person within one Swarm, as today. A person in two Swarms has separate Buddies in each, and
  the cap counts per Swarm. *(Call made in drafting.)*
- One Buddy is the person's default: it receives the messages of a removed Buddy and the decisions addressed to the
  person.
- An idle Buddy sleeps and wakes when its person writes to it or a proposal it sent needs it, so many Buddies do not
  hold machine memory or quota while unused.
- Each person has a maximum number of Buddies, set per Swarm.

## Rollout

- Per project: a project switches to this way of working when its owner turns it on. Projects not switched keep
  today's behaviour, so a project with its own established flow (for example one built around a device queue) moves
  when it is ready.
- **[merge]** Desktop first, today (anh Dee: "focus on building desktop only, ship desktop asap"); phone and web follow
  on the same spec, so in the end a person sees the same Board and the same Buddies on each.
- The history of a switched project's chat with the PM stays readable, but nobody can write in it.
- When a project switches on, every message to the PM still unanswered becomes a proposal on the Board, under its
  author's name, so nothing is dropped. When it switches back, undecided proposals stay open and the PM answers them
  in the chat as today. *(Call made in drafting.)*

## Phases

**Phase 1, Desktop, building now (#3787, Signincheck; release today):** Board opens by default for a project; Trello
look; left pane without Buddy and Threads; right pane = Buddy chat, or a clicked card's flat chat; hide/show icons on
both side panes. Built on what the backend has today (tasks, steps, PRs, task conversations, one Buddy, proposals as
they are). The project chat stays readable for apps that don't have the Board yet.

**Phase 2, after Dee and Ken approve this spec:**
1. Backend (Ken): proposals as their own records with a decision (Accept, Reshape, Later, No + reason), questions on a
   card with a default and a time, duplicate merge; many Buddies per person with a default and a cap; an agent's ask
   goes to the person's default Buddy and the "Needs you" bar; the PM's inputs become proposals, answers and notices
   only; the per-project switch; the Board read returns only what changed.
2. Desktop: Merged column and Waiting folded into Working; decision, question and "needs you" on the card; Needs you
   bar; propose from the Board; priority and pause by role; + New Buddy and Buddy list.
3. Phone and web: the same Board and Buddies.
4. Instructions and the PM: drop the chat rules (answer in threads, inbox, owed asks) once the project switches.

## Design

- **Growth:** proposals live as long as their card. A shipped or declined card leaves the Board after a set time and
  stays in the project's history. Buddies are deleted by their person; a sleeping Buddy's folder is dropped after a
  long idle time.
- **Concurrency:** one PM per project decides each proposal once. Two Buddies proposing the same thing end as one card.
  A question to a person is answered once; a late second answer is shown but changes nothing.
- **Read cost:** the PM reads only new proposals and new answers since it last looked, never the whole Board. A
  person's Board updates only with what changed.
- **Scale:** at 10× the people (many Buddies each), the first warning is proposals waiting on the PM longer than the
  project's limit; the cap on Buddies per person bounds machine load.
- **Compatibility:** apps that do not know the Board mode still show a switched project, read-only. A project not
  switched works as today with every app.
- **Migration and rollback:** switching a project on is reversible by its owner. Switching back reopens chat with the
  PM; proposals and cards made meanwhile stay as tasks.
- **Audience:** who sees a project's Board, who may propose, and who may change priority follow the project's members
  and roles, enforced by the server, never by the app alone.
- **Identity:** a proposal names the person who agreed to it and the Buddy that sent it. A Buddy on a shared Team
  machine acts as its person, never as the machine's owner, and spends the Team account's subscription until its
  person signs in their own.
- **Failure:** a proposal the PM has not answered within the project's limit is shown as late on its card and in the
  "Needs you" bar of the project owner. A Buddy that cannot be reached is marked on its person's list. Nothing waits
  silently.
- **Platforms:** Desktop (macOS, Windows, Linux), phone (iOS, Android) and web.

## Out of scope

- How any of this is built: the build plan comes after this spec is approved.
- Changing the workflow inside a project (crew, review, test, merge, release). That stays defined by each project's
  instructions.
- People talking with each other. Only the person-to-PM chat is replaced.

## Work in progress that needs replanning

Before they continue, check work running now that assumes any of these:
- **People write to the PM and the PM answers them:** the PM inbox, answering each message once, the "messages
  waiting on the PM" strip, and the rules about how the PM talks in the project chat.
- **Only the PM reaches people,** with agents' asks to people routed through the PM. Under this spec, an agent asks the
  person directly, through their default Buddy and the Board.
- **One Buddy per person:** Buddy creation, the Buddy chat, Buddy thread sessions, and the Buddy's news about work it
  requested.
- **Proposal consent and wording rules,** which assume one Buddy and a proposal posted into the project chat.
- **The Board's columns and the phone's project tabs,** which today open on the chat and have no Merged column.
- **The PM's built-in schedule,** which wakes it for what people wrote to it.
- **Instructions lines** that tell people to talk only to the PM, or tell the PM to answer people in the chat.
