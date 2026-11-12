# Offers accepted on the agent's own computer

Package 16 of [the allocator's build](BUILD.md). Status, 12 November: this design, **the server's half** and **the
daemon's half are built**, each in a pull request of its own; [what is owed](#owed) is listed at the end. Written before
the code; the numbers under [Measured](#measured-modelled-assumed) were added after it ran.

## In short

Today the PM's person's daemon puts `builder:<name>` on an issue, and the builder's `take` asks only that the label is
there. GitHub cannot set a label "only if unset", so two writers can each label one task, and the builder's own
computer is never asked whether it has room.

With offers:

1. The PM's daemon plans as today and **offers** the task to one agent: a record on the Swarm's server, nothing on
   GitHub.
2. The server keeps **one record for a task**. While it is live, a second offer of that task is refused.
3. The agent's own daemon checks its machine and its subscription's window and **accepts** or **declines**.
4. The agent runs `take` as today. `take` goes through on the live accepted offer, and puts `builder:<name>` and
   `status:taken` on the issue itself, in its person's name.
5. An offer nobody answers lapses after 2 minutes; one accepted and not taken, 10 minutes after it was accepted. The
   PM's next pass offers the task again.

The server referees that one record. It picks nobody, offers nothing again, starts no timer and never writes on
GitHub. That is why this is not the workflow in server code the plan does not build, and not what #3908 removed
(route decisions, rules, costs and model evidence: a server that decided).

## The record

One document for a task in a Swarm, in a collection of its own (`SuperTabTaskOffer`), outside the Swarm's state: an
offer never contends with a command, and never wakes a reader of the Swarm.

| Field | What |
|---|---|
| `_id` | `<tabId>\|<repository, lower case>\|<issue number>`: the task. One document, so one offer |
| `tabId`, `projectId` | The Swarm, and the project whose PM offered it: who may read it |
| `repository`, `number` | The task, as the project names its repository |
| `agentId` | The agent it is offered to |
| `offeredAt` | When |
| `expiresAt` | Live while the server's clock is before it. An offer: `offeredAt` + 2 min. Accepted: `acceptedAt` + 10 min. Declined: brought to the moment of the decline |
| `acceptedAt` | When its agent's daemon accepted, or null |
| `declinedAt`, `declined` | When it declined and why, in one lower-case word, or null |

Ids, a repository's name, a number, times and one word. No task text, no login, no quota number.

**Live** is one comparison, on the server's clock alone: `expiresAt > now`. A decline brings `expiresAt` to now, so
there is no second condition to forget. What a reader is told (`offered`, `accepted`, `declined`, `lapsed`) is worked
out from the fields as it is read; nothing stores a state, and nothing moves one.

**Indexes.** Every query uses one, and none scans.

| Index | Serves |
|---|---|
| `_id` | The offer, the accept and the decline: each reads or writes the one document of its task |
| `tabId, projectId, expiresAt` | A project's offers, live or ended in the last 10 minutes |
| `tabId, agentId, expiresAt` | An agent's live offers |
| `expiresAt`, with an expiry (`task_offer_expiry`) | Removes a document a day after it ended |

## One live for a task, under two requests at once

Not a read then a write. The offer is **one write**: an upsert of the task's `_id` whose filter is "no longer live"
(`_id` and `expiresAt <= now`).

| What stands for the task | What the one write does |
|---|---|
| Nothing | Inserts the record |
| An ended record | Matches it and replaces every field |
| A live record | Matches nothing, tries to insert, and the unique `_id` refuses it. Nothing is written |

MongoDB applies a write to one document atomically, so of two offers at once one is applied and the other then
matches nothing and meets the unique key.

An accept and a decline are each one conditional update (`findAndModify`): `_id`, this agent, `expiresAt > now` (an
accept also "not accepted yet", so asking twice extends nothing). A lapsed offer cannot be accepted, an offer cannot
be accepted by another agent, and an accept racing a newer offer of the same task finds another `agentId` and changes
nothing.

**Found while building it.** The first version used Prisma's `updateMany` with a filter, as the read marks do. Read
in the profiler, Prisma sends that as two commands: a read of the ids the filter matches, then an update **by id
alone**. Two requests at once both read "matches" and both write: two offers both answered "offered", and an accept
that read its own live offer could mark the next agent's as accepted. So every write here is a raw command that
carries its whole condition, and a test reads each write's own filter from the profiler
(`integration/superTabTaskOffers.test.ts`, "says what each write rests on in the write itself").

The same offer again (the same task to the same agent, still live) answers the standing record and writes nothing: a
command that arrives twice does its work once.

## The routes

All under `/api/super-tabs/:tabId/task-offers`. The server enforces who; a daemon's own checks are only a courtesy.

| Route | Who may call it | What |
|---|---|---|
| `POST ?asAgentId=<PM>` `{ repository, number, agentId }` | The computer that runs `asAgentId`, signed in as that agent's own person; and `asAgentId` is the PM of a project on that repository. The agent offered reads that project and is not the PM itself | Offers the task. `409 OFFER_LIVE` while another agent's offer of it is live. At most 1,200 new offers an hour for one PM |
| `POST /accept?asAgentId=<agent>` `{ repository, number }` | The computer that runs `asAgentId`, signed in as that agent's own person; and the live offer of the task is that agent's | Accepts. `409 OFFER_NOT_LIVE` otherwise, in one answer whether it lapsed, was declined, is another's or never was |
| `POST /decline?asAgentId=<agent>` `{ repository, number, reason }` | The same | Declines, with a reason word. Also after accepting, while it is live |
| `GET ?repository=<owner/name>[&asAgentId=…]` | A person or an agent that reads a project on that repository | That project's offers, live or ended in the last 10 minutes: at most 200, and whether there are more |
| `GET /mine?asAgentId=<agent>` | The computer that runs `asAgentId`, signed in as that agent's own person | The agent's live offers: at most 20 |

Every answer carries the server's time, so no daemon compares its own clock with an expiry.

A Swarm the caller cannot reach answers as every Swarm route does: one "not available", whether it is missing,
left or never joined. Inside a Swarm the caller reads, a refusal keeps its own words (`PM_REQUIRED`,
`AGENT_NOT_IN_PROJECT`, `OFFER_LIVE`, `OFFER_NOT_LIVE`).

**Told, not polled.** When an offer is stored, the server tells the offered agent's computer that its Swarm changed,
through the push hosts already hear (`swarm_host_changed`). The daemon then reads `/mine`. No new frame, and nothing in
the daemon's core.

## The expiry

| | How long | Why |
|---|---|---|
| An offer with no answer | 2 minutes | Its daemon answers by code within seconds of being told. Its own safety read is once a minute: two minutes cover a lost push and one more read |
| An accepted offer | 10 minutes from the accept | Its agent's time to run `take`, as today's rule for a task given and not taken |
| A declined offer | Ends at once | The task is free for the next pass |
| The document | Removed a day after it ended | A TTL index. Long enough to ask why a task waited, short enough that the collection is a day's tasks |

The longest an offer can hold a task is 12 minutes, and no caller can lengthen it: the server sets every time.

**No way to withdraw.** The PM cannot take an offer back. If it could, it could free a task while its taker's label
was on its way to GitHub, and the next agent would take it too. An accepted offer is a firm hold until its time.

## What the daemon checks, and what it says

On the agent's own computer, for an offer to one of its person's own agents running there
(`cli/src/superTabs/taskOffers.ts` `noRoom`, read in this order):

| Check | Declines with |
|---|---|
| The task is of a project of the agent's, open, an issue, and carries no other builder's label and no `status:taken` but its own (one read of GitHub) | `gone` |
| The machine has each tool its `needs:` labels name, its system and a GPU as asked (the tools probed here, as a start probes them) | `tools` |
| The cores of the task's size (1, 2, 4) beside those of the tasks this computer's other agents build (taken, no pull request of theirs yet) fit its logical cores | `cores` |
| Free memory holds the task's size (s 2 GB, m 4 GB, l 8 GB), and memory pressure is not critical | `memory` |
| The project's disk, less the 10 GB its person keeps, holds it (1, 2, 4 GB) | `disk` |
| Each known window of the agent's subscription has room for it above its person's 20% (3, 10, 25% of a 5-hour window; a fifth of that of a weekly one) | `quota` |
| Later, when `take` is refused for good: at its limit of four, or another builder's label came on as it took it | `limit`, `gone` |

Not checked: CPU as a reading (a momentary one once refused every start, `capacity.ts`): cores are counted, as the
plan counts them. An agent whose session does not run here is not answered for: its offer lapses. What cannot be read
(memory, disk, a window) is no reason: an unknown window is not read as unused and not as full, and the offer is
accepted, as the plan gives to such a builder today. The windows' percentages are read on this computer
(`usage_read`) and never leave it.

A decline says one word. No number, no path, no account. Its person is told once in the agent's chat, per reason,
until it accepts again ("I was offered acme/app#14, and this computer has no room for it: not enough free memory").
A task gone is not said.

Then `take`:

- with the builder's label on the task: as today, and no question to the server (a task a person or an older PM's
  daemon gave);
- without it: only on a live accepted offer of the task for this agent, read from `/mine`, with at least 2 minutes
  left by the server's clock. Each GitHub call ends within 10 seconds and a take makes at most five, so its labels
  land while its hold stands. It then puts `builder:<name>` and `status:taken` on in one call. If that call's answer
  shows another builder's label, it takes its own two off and declines `gone`; refused at its limit of four, it
  declines `limit`.

## Offered again, with no write to GitHub on a timer

An offer, an accept, a decline and a lapse write **nothing on GitHub**. The first write for a task is its taker's own
`take`: two labels in one call and one comment, once. Today a task costs four writes, two of them in the PM's
person's name (the label and "for **Pip**: …"); with offers it costs two, none in the PM's person's name.

A lapsed or declined task looks free on GitHub, so the PM's next pass (each minute, as today) plans it and offers it:
one small write to the server, rewriting the same document.

What bounds a stuck case is a rest, kept in the PM's daemon's memory: a builder that declined or let an offer lapse is
offered nothing for 10 minutes, doubling to 2 hours while it keeps doing so, and at once again after it accepts. An
offer taken lapses too (the server never hears of a take), but its task then carries its builder's label, and nobody
rests for it.

| Stuck case | Writes to GitHub a day | Writes to the server a day |
|---|---|---|
| A task every one of M builders declines for one reason | 0. Each builder's person is told once in its chat, for each reason | At most 16 offers and 16 declines a builder (10, 20, 40, 80 minutes, then every 2 hours) |
| A builder whose daemon never answers | 0 | At most 16 offers |
| An agent that accepts and never takes | 0 from offers. Its own idle watch types the task three times, then tells its person (`nextThing.ts`, unchanged) | At most 16 offers and 16 accepts |
| Today, a task given by label that nobody takes | 4 for each builder it is moved to (label, comment, take back, comment) | 0 |

## Compatibility

The server ships first. It only adds: a collection, five routes, one push. Nothing existing reads or writes them.

| Server | PM's daemon | Agent's daemon | What happens |
|---|---|---|---|
| new | old | old | As today. The routes are not called |
| new | new | old | The agent's computer does not report `taskOffers`, so its tasks are given by label, as today |
| new | old | new | Given by label; `take` goes through on the label. `/mine` is read and is empty |
| new | new | new | Offers |
| old, or rolled back | new | new | The offer is answered "no such route" (a 404 that is not the Swarm's own refusal): the PM's daemon gives by label for 10 minutes, then asks again. A task it offered itself in the last 12 minutes is left alone until then. An accepted offer the server no longer answers for lets no `take` through |

How a daemon says it speaks offers: `taskOffers` among the capabilities its machine already reports. The server
takes any capability word, so this needs no server change and an older server stores it unread.

Dates:

- **12 November 2026**: the server's half.
- **The daemon's half** is released after the backend's release is live.
- **A daemon that does not speak offers is given tasks by label until 30 days after that CLI release**: 14 December
  2026 if it is released on 14 November. From then the PM's daemon gives only by offer, a builder on an older daemon
  is given nothing and its PM is told once, and `give`'s label path and `openWaiting` are deleted. The pull request
  that ships the daemon's half writes the date beside that code.
- `take` keeps the label for good: a builder that a person names for a task stands.
- **The quota percentages leave the machine's report** only after that date, with package 15's price. Not now.

## Design (docs/feature-design-rules.md)

1. **Growth.** One document for a task, rewritten by each later offer of it. Removed a day after it ended (TTL), and
   with its Swarm (`purge.ts`). Limit: 1,200 new offers an hour for one PM, so a loop writes at most 28,800 small
   documents a day; a team's real day is its tasks (lampOS: about 90).

   | Event | What happens to the record |
   |---|---|
   | Offer | Inserted, or takes the place of the ended one for its task |
   | Accept, decline | One conditional update |
   | Lapse | Nothing is written: the clock passes `expiresAt` |
   | Its agent's daemon is gone | It lapses in 2 minutes, or 10 if it had accepted |
   | Its agent, person or project leaves the Swarm | It can no longer be answered (the access check fails at that moment) and lapses. A deleted project's offers cannot be read |
   | The same person joins again | Nothing carries over: an answer is checked against the Swarm as it is then |
   | The Swarm is deleted | Unreadable at once, as all of it; purged with it |
   | Purge | A day after `expiresAt` |
   | The same task again | The same `_id`: the new offer overwrites the old. There is no version to reset |

   Readers of "all offers": the project read lists live ones and those ended in the last 10 minutes, and says which;
   the agent's read lists live ones only.
2. **Concurrency.** A write locks one document, the task's. Invariants: one live offer for a task (the `_id`, and the
   replace only where `expiresAt <= now`); only its agent answers it (`agentId` in the filter); a lapsed offer is
   never accepted (`expiresAt > now` in the same update). No transaction spans two documents. The Swarm's state is
   read for the access check and never written.
3. **Read cost.** The project read loads and sends at most 200 rows of about 250 bytes, and its index holds only the
   project's live and just-ended offers. The agent's read, at most 20. An ended offer leaves the agent's list, so a
   removal reaches its reader. A test reads each plan: documents examined equal documents returned.
4. **Scale.** At ten times today (300 builders in one project) there are at most 300 live offers: the project read
   says `more`, and a task whose offer the PM's daemon did not see is refused a second offer, so nothing is given
   twice. Warns first: `swarm_task_offers_total{outcome="live"}` (a second coordinator, or a PM's daemon that forgot
   its offers) and `{outcome="limited"}` (a PM near its hourly limit).
5. **Compatibility.** Above. Existing readers of the new record: none.
6. **Migration and rollback.** The release's schema step makes the expiry index before the push, as it does the
   verdict records'. No stored data is rewritten. Rolled back, the previous release reads none of it, the rows
   expire by their index, and daemons fall back to labels.
7. **Audience.** One predicate, `canReadProject`, on both reads. Copies of a record: the two reads. The push carries
   only the Swarm's id. Nothing is in the Swarm's state, a change feed, a notification, a chat or a log; the
   counters carry no id.
8. **Identity.** An offer is made as the PM, and an answer as the offered agent, each from the computer that runs
   that agent, signed in as that agent's own person: the owner of a lent machine can neither offer nor answer for
   another person's agent there, and that person cannot from any other computer. A take's writes are made with that
   person's own `gh` (`service.ts`, unchanged). Where the identity is missing the call is refused; nothing falls
   back to the machine's owner.
9. **Failure.** A refusal has a code and words. An offer nobody answers lapses, and the PM's daemon logs it once with
   the builder's rest. One accepted and not taken lapses, and its agent was typed it once and its person told once
   (`nextThing.ts`). A decline for a want of room is told once to its agent's person, for each reason. A server
   without the routes is said once in each daemon's log and worked around. A PM at its hourly limit is told `429`,
   said once in its log, and tries next pass.
10. **Platforms.** The server: Linux. The daemon's half: macOS, Linux and Windows alike; it starts no process and
    opens no window. No screen changes.

## The three attacks

| Attack | Stopped by |
|---|---|
| **A task given twice**: two offers live for one task | One document for a task. The insert fails on the key; the replace matches only an ended record; both are single-document writes |
| ... two daemons both coordinate | Only the project's PM, from the computer that runs it, may offer. The record refuses the second whoever it is |
| ... an agent takes on an offer that just lapsed | `take` asks the server at that moment and needs 2 minutes left; the next agent's `take` reads the issue fresh and stops at another builder's label |
| ... a label given by hand beside an offer | `take` refuses a task that carries another builder's label, as today, before it writes |
| **A task never given**: an offer that is never answered | It lapses by the server's clock in 2 minutes; accepted, in 10. Nobody can lengthen it, and asking to accept twice extends nothing |
| ... an agent that declines or lapses for ever | Only its own offers. The PM's daemon rests it, and the task goes to the next |
| ... a record stuck live | Every time is the server's. The longest hold is 12 minutes |
| **An offer forged by another member**: offering as the PM | The caller's own computer must run the agent it speaks as, under that agent's own person's sign-in, and that agent must be the project's PM. Another member is refused before anything is written |
| ... accepting or declining another agent's offer | The same check, and the update's filter names the agent: another agent's answer changes nothing |
| ... offering to an agent outside the project | The agent must read the project. One answer whether it does not or does not exist |
| ... filling the collection | 1,200 new offers an hour for one PM; a repeat of a standing offer writes nothing |

Two cases the record does not close, each no worse than today:

- **A second project on the same repository, in the same Swarm.** The task is the issue, so its PM's offers hold
  tasks from the first project's PM for as long as each lives. Today the same PM can put its builder's label on any
  issue: the record gives it no new power, and each refusal is counted (`live`).
- **Two Swarms on one repository.** A record is its Swarm's own, as a verdict record is, so each Swarm sees the
  other's offered task as free until it is taken: at most 12 minutes, where a label showed within seconds. Both may
  offer it. The second `take` reads the issue and stops at the first's label, so the task is built once and one
  agent loses a turn.

## Left out, on purpose

Each would be a rule the next review breaks.

- **A way to withdraw an offer**, and any write that shortens another agent's hold.
- **A "taken" mark on the server.** GitHub says who holds a task. The record only says who may take it.
- **An offer's own id or a version.** The task is the key.
- **A stored state, a sweep, a timer.** Live is one comparison.
- **A second free-text field.** A decline is one word.
- **"Until when" on a decline.** What a window is worth leaving its computer is package 15's.
- **A new push frame, and anything in the daemon's core.**
- **A comment on GitHub for an offer.**
- **The builder's label put on when the offer is accepted.** The task would show held on GitHub at once. But an
  accepted offer that lapsed would then need a write to take the label off: a write on GitHub for every round of a
  stuck agent. The label goes on with `take`, when the work is its agent's.

## Measured, modelled, assumed

**Measured** (12 November, the in-memory MongoDB 7.0 the backend's tests use, on one Mac; plans read with the
profiler in `integration/superTabTaskOffers.test.ts`):

| Call | Operations on the offers | Plan | Examined | All database operations |
|---|---|---|---|---|
| A project's offers (7 listed of its 87, among about 300 in the collection) | 1 read | `IXSCAN { tabId, projectId, expiresAt }` | 7 keys, 7 documents, 7 returned, 2.3 kB | 8 on a cold cache |
| An agent's own (2 listed of its 42) | 1 read | `IXSCAN { tabId, agentId, expiresAt }` | 2 keys, 2 documents, 2 returned, 0.8 kB | 3 |
| Offer, new or in place of an ended one | 1 read, 1 write | `IXSCAN { _id }` each | 1 key, 1 document | 10 |
| The same offer again | 1 read | `IXSCAN { _id }` | 1 key, 1 document | 9 |
| Accept, decline | 1 write | `IXSCAN { _id }` | 1 key, 1 document | 9 |
| Accept again | 1 write that matches nothing, 1 read | `IXSCAN { _id }` each | 1 key, 1 document | 10 |

The other seven or eight operations of a call are the Swarm's own load for the access check, the same a verdict
record's write pays today. No scan anywhere, and no read examines a document it does not return.

Races, on the same database through the routes: 12 offers of one task at once to three agents left one record, the
winner's four answered the same offer and the other eight `OFFER_LIVE`; 10 at once for a lapsed record, one took its
place; an accept of a lapsed offer racing the next offer of its task was refused four times in four, whichever came
first. And each write's own filter was read from the profiler: every one carries `_id` and `expiresAt`, and an
answer its `agentId`.

Not measured: latency on production's cluster, and anything under real load. The numbers above are counts and
plans, which do not change with the machine; times on a laptop running other suites were not kept.

**Modelled**: the writes a day in the stuck cases above, counted from the rests.

**Assumed, not measured**:

- An agent's daemon answers within seconds of being told. Built, and timed only in specs, not on the real backend. The server counts the seconds
  from each offer to its accept (`swarm_task_offer_accept_seconds`), which will say whether two minutes is right.
- The servers' clocks agree to within a second. An expiry is compared on whichever server takes the call.
- GitHub applies two labels given in one call together, and a label write lands within 10 seconds. Not tried on
  GitHub tonight (nothing may be written there): the daemon's half tries it in the scratch repository first, as the
  build's rules ask.
- What offers do to "free to next task" and to conflicts is not in any model. It is judged on the scoreboard, the
  week after against the week before.
- `experiment.mts` was not run for this package: it changes who may take a task, not who is planned for it.

## Owed

Built, in two pull requests, the server's first:

- **The server's half** (`backend/src/superTabs/taskOffers.ts`): the record, its five routes, the push.
- **The daemon's half**: the client and the agent's side (`cli/src/superTabs/taskOffers.ts`: the checks above,
  answered as the server pushes that the agent's Swarm changed, at most once in 20 seconds for a Swarm, and once as the
  daemon starts); `take` on an accepted offer (`githubClaim.ts`); an accepted offer as the agent's next thing
  (`nextThing.ts`); `taskOffers` among the machine's capabilities (`machines.ts`); and the PM's side (`assign/crew.ts`
  `crewOf`, `githubAssign.ts`): it offers where the builder's own computer answers offers, reads the project's offers
  once a pass, reads a live offer's task as its agent's, rests a builder that declined or let one lapse, and gives by
  label to a builder on a CLI from before, until 14 December 2026.

Not done, and owed before the daemon's half is called proven:

1. **On GitHub**, in the scratch repository: two labels in one `POST /issues/N/labels`; what that call's answer lists
   when another label was put on a moment before; a `take` racing a label put by hand. Nothing could be written on
   GitHub while it was built. If GitHub does not act as this design expects, stop and report.
2. **The journey** on the real backend: an older daemon beside a newer one in one project, and a server without the
   routes.
3. **The date**: on or after 14 December 2026, `give`'s label path and `openWaiting` go, and a builder on an older
   daemon is given nothing and its PM is told once. Then the quota percentages leave the machine's report, with
   package 15's price.

Also not built, on purpose: nothing in Desktop shows an offer; no once-a-minute read of an agent's offers beside the
push (a lost push lets an offer lapse, and its builder rests ten minutes); a task everyone declined is not said on
GitHub.

A doubt for whoever builds it: the read marks (`readMarks.ts` `raise`, `lowerReadMark`) and three claims in
`store.ts` rest on the same Prisma `updateMany` with a filter that this package found to be a read then a write. That
is outside this package and goes to the maintainers as a proposal.
