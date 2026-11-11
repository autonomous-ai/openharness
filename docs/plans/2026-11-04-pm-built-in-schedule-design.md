# Every project's PM runs a built-in schedule, woken by the Swarm

Status: design, 2026-11-04. Requested by Ken.

## Why

Only two of the six projects give their PM a schedule: openharness (River's "PM schedule" section) and lampos (Leo's
rules). In physical-router, garage-pod, computer and spaceship the PM acts only when a notice or a person reaches it, so a
task nobody owns, or one waiting on a person nobody asked, sits until someone looks. Where a schedule exists, the PM keeps
it on its own timer: a timer its engine may not have (a Codex PM), and one lost on every session restart until the PM
remembers to recreate it.

Ken, 2026-11-04:

- The PM jobs every project needs are loaded by default for every project's PM, appended to the project's instructions,
  not copied into each document.
- A line in the project's own instructions wins over the default.
- The Swarm wakes the PM for them; the PM sets no timer of its own for them.
- Jobs due at the same time go in one message.
- The PM must know these jobs exist, so it does not do the same work twice.
- openharness drops the three lines of its own schedule that the default now covers.

## Goals

- Every project's PM, existing and new, gets the same jobs with no change to its document.
- The PM is woken for them on time without a timer of its own, across restarts and engines.
- The PM knows which jobs are the Swarm's, and never runs one twice.
- A project's own line about the same job wins.

## Non-goals

- A per-project schedule editor, or parsing a project's instructions to find its times. Nothing parses the document
  (instructionsTemplate.ts); the PM reads it and judges what overlaps.
- Moving project-specific jobs (openharness's batch pull request, triage, releases, reports to Dee; Leo's status line)
  into the default.
- An on/off switch per project.

## Anti-goals

- A PM woken every 30 minutes with nothing to do. Every wake is a turn of a long-context session.
- Two messages in one poll where one would do.
- The default copied into a project's document by a PM that saves what it read.
- A job the Swarm already does on its own (below) repeated by the PM.

## What the Swarm already does, so the default leaves it out

| Job in River's schedule | Already done by the Swarm |
|---|---|
| A task whose agent is lost goes to a new agent | `work-lost` notice to the PM (liveness.ts), in the notice digest |
| A task with no progress for 30 minutes | `work-stalled` notice to the PM (liveness.ts sweepForLead) |
| Agents with no work are stopped | `idle` notice after 15 minutes, once per idle spell (tidy.ts idleNotices) |
| Finished groups whose pull requests are merged or closed are archived | Auto-archive (archive.ts), unless the owner turned tidying off |
| Morning digest, status card | `digest-request` at 08:00, `update-request` when work changes |

The default keeps the rules for answering these notices, since how to answer them is part of the job, but schedules no
job for them.

## The default

### The jobs

One job, every 30 minutes: **the open-task sweep.** Every open task of the project, unassigned and "To do" ones included,
ends the sweep with one of:

- an owner working on it;
- a question to a person, by name, with a default and a time;
- a close, with its reason.

A task waiting on a person gets that person asked by name, with a default and a time. A task nobody will work on is
closed. The PM asks no agent whether it is stalled: `mine` and the task's thread show it.

Then every finished group the Swarm left open is archived: one with no pull request linked, which the auto-archive
(tidy.ts reviewClosable, archive.ts) never takes (Ken, 2026-11-04).

The default also states the rules for the notices the Swarm sends, so every PM answers them the same way:

- `work-lost`: the task goes to a new agent with its pushed branch.
- `work-stalled`: the PM reads the task's thread first, and sends it back to its agent only when the thread shows it
  waits on nothing (a review, CI, a batch, a person).
- `idle`: the PM stops the agent unless work is coming for it.

No hourly cleanup job (Ken, 2026-11-04). On prod in the 24 hours to 2026-11-04 the Swarm archived 113 finished
groups itself and sent 121 idle notices; 15 finished groups were left unarchived, from 2026-10-27 to 11-04
(about 2 a day), each with no pull request linked to its group: the auto-archive waits for a linked pull request merged
or closed. They were archived by hand once; the sweep now archives new ones. The 30-minute sweep catches a task whose pull request merged but
which was never set done.

### Where the PM reads it

The instructions read (store.ts, the project instructions read) returns a new field, `builtIn`, beside `text`: the
default's text, from one constant in the backend (`pmSchedule.ts`). It is read-only, belongs to no revision, and only the
coordinator's read carries it (a Buddy's read and a worker's read omit it).

The CLI's instructions skill (cli/src/lib/swarmInstructionsSkill.ts instructionsSkillText) appends it after the document,
for the coordinator only, under its own heading:

```
## Built-in PM schedule (from the Swarm)

The Swarm wakes you for these jobs with a message that names them. Set no timer of your own for them, and delete one you
set before. A line in this project's instructions above about the same job wins: follow it, and skip that job when the
Swarm's message names it.
...the jobs and notice rules...
```

Because `builtIn` is part of what the skill holds, a change to the default rewrites the skill and tells the PM once, as a
new revision does today (refreshProjectSkills). The document's `text`, `hash` and `revision` are unchanged, so a PM that
saves what it read never copies the default into the document.

How a change reaches a running PM, and the launch:

- **The roster says when it changed.** The host rereads instructions only when the roster's `revision` or `hash` moves
  (cli/src/superTabs/host.ts refreshInstructions; backend/src/superTabs/read/hostRows.ts). The coordinator's row gains
  `builtInHash` (a hash of `builtIn`), and the host rereads when it moves too.
- **The host caches per role.** `instructionsKey` is shared by every agent of a tab and project, so a worker's read
  (no `builtIn`) could be reused for the coordinator. The key gains the coordinator's agent id, as it does a Buddy's.
- **The launch read prints it.** A new PM session is told to run `harness super-tab instructions`. For the coordinator
  that command prints `builtIn` after the document, under the same heading and a line saying it is not part of the
  document and is never saved. The launch record then counts the section as read for that `builtInHash`, so a launch
  owes no extra notice, and a later change of the default owes one.
- **The save refuses a copied section.** `instructions.save` refuses a text holding the heading line
  `## Built-in PM schedule (from the Swarm)`, saying to remove that section: the separate field keeps a read from
  copying it, and this keeps a PM that copied it from the skill file from storing it. Nothing is stripped silently.

### How the Swarm wakes the PM

The PM's own poll is the clock, as for the morning digest and the notice digest (store.ts fullDeliveries): no server
timer.

- **Slots.** A slot is a 30-minute window in UTC: slot `n` starts at `n * 30 min`. On the coordinator's poll, the
  schedule is due when the current slot is past the project's `schedule.lastSlot`. A PM offline for several slots gets
  one wake for the current slot, never one per missed slot.
- **The message.** One message to the coordinator, in the project's Lead conversation, `source.kind` `schedule-request`
  with `slot`. It names the time and each job due, and says it comes from the Swarm's built-in schedule:

  ```
  Built-in schedule, 10:00 (Asia/Ho_Chi_Minh). This is a scheduled request from the Swarm, not a new task.
  - Open-task sweep: every open task ends with an owner, a question to a person with a default and a time, or a close
    with its reason.
  Skip a job your project's instructions schedule on their own clock.
  ```

  Its id is `stableId('schedule', tabId, projectId, String(slot))`, so a retried poll writes it once. The time shown is
  in the project's digest time zone (digest.ts), Vietnam time when it has none.
- **One message per poll.** When the same poll writes an update request, the schedule's lines are appended to it, as the
  notice digest is today. When it writes a notice digest and no update request, the schedule's lines go into the
  digest's message. Only when nothing else is written does the schedule get a message of its own. The morning digest
  stays its own message: it asks the PM to post to people, a different act.
- **Nothing to do, no wake.** The sweep is for tasks no agent is moving; a task with an agent working on it is covered by
  the stalled and lost notices. So there is no message, and nothing is recorded, unless the project has an open task
  (a top-level task, not a step: a step belongs to its task's Engineer) that is unassigned or "To do", has lost its agent,
  or is waiting on a person, blocked or needing a human (liveness.ts task state), and no finished group quiet for
  ARCHIVE_QUIET_MS with no pull request linked. *Builder's call (Claude):* this keeps a
  busy project from 48 wakes a day while every task moves; a task parked on a person still wakes the sweep each slot,
  which is what makes the PM ask or close it. A slot with nothing to do writes nothing: `schedule` lives in the Swarm's
  head, and a write there moves every reader's copy each 30 minutes while nothing happened (#2946 review). The slot stays
  due, and each later poll checks again in memory over the loaded state; something to sweep later in the slot wakes the
  PM once. Readers' head leaves `schedule` out, as it leaves `progress`.
- **Only loaded groups.** The check sees the groups the poll loaded: a finished group with no pull request already asleep
  (sweeps.ts sleepQuietGroups, after a day of quiet) does not wake the PM. The PM's own sweep still finds it.
- **One unread wake at a time.** No new wake is written while the last `schedule-request` to the coordinator is still
  open (queued, claimed or uncertain), as the update request does (projectUpdates.ts). The slot is still recorded as
  handled, so a PM deep in a long turn finds one wake, not one per slot, when it comes back. A paused Swarm records nothing and sends nothing; its schedule is due again when
  it resumes, as the morning digest is.
- **Recorded in the same write.** `schedule.lastSlot` is set in the poll's single save, so two racing polls write the
  wake once: the second finds the slot handled, or the message id already stored.

### The project's own lines win

The Swarm does not know a project's times. The PM does: its document is above the default in the same skill, and the
wake message says to skip a job the project schedules itself. A project that wants a different sweep (lampos, say) writes
its own line; the PM then answers the Swarm's wake by skipping that job.

## Rollout

1. Backend and CLI ship together in one batch: the `builtIn` field, the wake, the skill section.
2. After the backend release, check on prod that River receives one `schedule-request` per slot, merged into an update
   request or a digest when one goes in the same poll.
3. Only then, with Ken's go, Claude saves openharness's instructions through the instructions API (the document lives on
   prod, not in the repo); this step is part of the plan. Save them without the three duplicate lines, so River is never without a sweep:
   - "Every 30 minutes, at :07 and :37" keeps only the batch pull request (Workflow 5); the progress sync goes.
   - "Every 30 minutes, at :22 and :52" keeps the worktree cleanup and the team pull request sweep; the open-task sweep
     goes.
   - "Every hour" (archive and stop) goes.
   The instructions-change notice makes River reread, and the skill's built-in section tells it to delete its own
   timers for those jobs.
4. Lampos keeps Leo's rules as they are; they win where they overlap.

## Design (docs/feature-design-rules.md)

- **Growth:** one number per project (`schedule.lastSlot`) in the Swarm's state. The messages are ordinary Lead-chat
  messages, at most 48 a day per active project and none for an idle one, kept and compacted as other notices are
  (deliveryCompaction.ts).
- **Concurrency:** the poll's existing Swarm transaction (fullDeliveries); the message's stable id makes a retry or a race
  write it once.
- **Read cost:** nothing new on a worker's poll. The coordinator's poll reads no more than today: the open-task and
  running-agent check uses the loaded state.
- **Scale:** 10x projects is 10x of a message every 30 minutes, written on polls that already run. The first metric to
  warn is the PM's turns per hour, logged with each wake (`[swarm-deliveries] schedule request`).
- **Compatibility:** an old CLI ignores `builtIn`; its PM still gets the wake, which carries the jobs and the "set no
  timer" line on its own. An old backend sends no `builtIn` and no wake; a new CLI writes no section then.
- **Migration and rollback:** none to migrate; a project with no `schedule` is due at its first poll. A rollback stops
  the wakes and the section; `schedule` is left unread. The openharness instructions change (rollout step 3) is a normal
  revision and can be reverted the same way.
- **Audience:** the server writes the wake to the coordinator alone: `schedule-request` gets a `recipients` entry in
  model.ts `NOTICE_READERS`, as `digest-request` has, or it would read as `people`. It serves `builtIn` only on the
  coordinator's read.
- **Identity:** the wake's author is the coordinator's own agent, as for the digest request; no machine owner's login.
- **Failure:** a poll that fails writes nothing and the slot stays due for the next poll. A PM that never polls (host
  down) gets no wake; the existing machine-offline notices tell people, and the first poll back wakes it once.
- **Platforms:** server and CLI only. People never see the wake: like the digest request it is the coordinator's alone,
  and Desktop, web and phone already hide rows whose readers are `recipients`.

## Tests

- The schedule is due once per slot; a second poll in the same slot writes nothing; a poll after three missed slots
  writes one wake.
- No wake and nothing written (the head's version unchanged) when nothing is due; none and nothing recorded for a paused
  Swarm. Readers' head carries no `schedule`.
- One message per poll: merged into an update request, or into a notice digest, when one goes in the same poll.
- Only the coordinator's instructions read carries `builtIn`; the skill appends it for the coordinator only, and a
  changed `builtIn` rewrites the skill and owes one notice.
- Saving instructions after a read leaves `builtIn` out of the stored text; a save holding the built-in heading is
  refused with its message.
- No wake for a project whose open tasks all have an agent working; a wake when one is unassigned or waiting on a person.
- No second wake while the first is open; the slot still moves.
- A changed `builtIn` moves the coordinator's roster `builtInHash`, and the host rereads; the coordinator's and a
  worker's reads are cached apart.
- The launch read prints the section for the coordinator, and the launch owes no extra notice.

## Left to the builder

- The exact wording of `builtIn` and of the wake, within what is above.
- Where the "nothing to do" check lives and its exact test of a running agent.
- File names beyond `pmSchedule.ts`.
