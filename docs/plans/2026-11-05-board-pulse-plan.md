# Board pulse: unanswered asks and who's working (task #3384)

> Implemented by its Engineer test first, by superpowers:test-driven-development, plan task by plan task, as the project's
> instructions say (Engineer role). No subagent-driven-development and no execution handoff.

**Goal:** A strip on top of the board (Desktop, web, the phone's task list) shows what waits for the PM and who works:
`Waiting for River: 2 asks · oldest 14m (Huy) │ Working 6 of 10 │ Next up 7 │ Lost 0 │ Held 3`. Each count opens its
list. It turns red when an ask waits over 15 min, Working is 0 while work waits for 10 min, a lost task has had no agent
for 10 min, or a hold has no reason.

**Architecture:** The server keeps what the PM owes on each conversation (`owed`, a short list of a person's messages to the
PM not yet settled) and settles it on the PM's reply in its place, its verdict reaction, or a task opened from it. It
marks on the project when Working fell to 0 while work waits (`idleSince`). A new `pulse.ts` computes each project's pulse
from stored state at read time and the read sends it in `derived.pulse` (cross-part, so never in a part). The CLI's status
read lays it on each project. Desktop/web and the phone draw it from the same numbers; the server gives each rule's
`redAt` time and the limits, so no app holds a threshold.

**Tech Stack:** backend TypeScript (vitest), Flutter Desktop/web (`desktop/lib/super_tabs`), Flutter phone
(`mobile/lib/swarm`), CLI status read (`cli/src/superTabs/reassemble.ts`, two lines).

**Spec:** task #3384's brief (River, 2026-11-05) and River's ruling on Held (same day): Held = an open task whose agent
set blocked or needs a human, its result as reason (empty = no reason), plus an unassigned task set "not before" a later
day, its reason the date. One function (`holdOf`) decides it, so the coming hold-reason task switches it there.

## Global Constraints

- Swarm code stays out of `cli/src/core`. Never run a test that signs the Mac out of the real CLI; Desktop tests use a memory
  store and a fake sign-in.
- Act and notify: nothing here refuses anything. A settle that finds nothing does nothing.
- Read only what changed: `owed` rides on the group part each message already writes; the pulse is derived per read from
  the loaded state, like `derived.machines`.
- Harness design language for both strips; light and dark screenshots in the PR.

## Design

- growth: `owed` holds at most 50 asks per conversation (newest kept); a settle removes its ask. `idleSince` is one number
  per project, removed when the condition ends.
- concurrency: both are written in the command's own group/head part write, under its version guard (parts/commit.ts).
- read cost: one pass over the loaded groups and agents per visible project per read, as `derived.machines` does; no extra
  database read.
- scale: 10x groups is 10x that pass; the read latency metric (`[swarm-read]` timings) warns first.
- compatibility: older apps ignore `derived.pulse`; a new app on an older server sees no pulse and draws no strip.
- migration + rollback: no migration. Asks before the release are not owed (nothing recorded them); rollback leaves an
  unread `owed` field on groups, stripped from reads.
- audience: asks are recorded only in conversations without an audience (never a private or Buddy chat), so the pulse names
  no one a project reader could not already see. `owed` is stripped from group views.
- identity: asks are keyed by the person's member id, never a machine owner's login.
- failure: a pulse that cannot be computed for a project is left out of `derived.pulse` and logged; the board draws no
  strip rather than a wrong one.
- platforms: Desktop macOS/Windows/web and the phone draw the same numbers; no process is started.

## Review Focus

- Settling: only the project's PM settles; a reply settles its message or its whole thread, an answer right below settles
  that message, a verdict reaction (check, thumbs_up, rocket, tada; never eyes) settles its message, a task opened from a
  request settles the request.
- Counts match the board's columns (Next up, Working, Lost, Held) and the red rules use the server's `redAt`.

## Contract (`derived.pulse[projectId]`)

```json
{ "pmId": "agent id or null",
  "asks": { "count": 2, "oldestAt": 1793880000000, "personId": "member id or null",
            "list": [{ "conversationId": "…", "messageId": "…", "personId": "…", "at": 1793880000000 }] },
  "working": { "count": 6, "crew": 10, "agentIds": ["…"] },
  "nextUp": { "count": 7, "conversationIds": ["…"] },
  "lost": { "count": 0, "since": null, "conversationIds": [] },
  "held": { "count": 3, "withoutReason": 1, "list": [{ "conversationId": "…", "reason": "text or null" }] },
  "idleSince": null,
  "redAt": { "asks": 1793880900000, "idle": null, "lost": null, "held": null },
  "limits": { "askMinutes": 15, "idleMinutes": 10, "lostMinutes": 10 } }
```

A segment is red when its `redAt` is not null and not after now; the strip is red when any is.

## Tasks

### Task 1: owed asks recorded and settled

**Files:** `backend/src/superTabs/pulse.ts` (new), `pulse.test.ts` (new), `commands.ts` (message.send, message.react,
conversation.create), `model.ts` (`Conversation.owed`), `read/views.ts` (strip `owed`).

**Interfaces:** `owe(state, group, ask)`, `settleReply(state, group, agentId, {answers, thread})`,
`settleReaction(state, group, agentId, messageId, emoji)`, `settleRequest(state, group, messageId)`.

- [ ] Failing tests: a person's message to the PM is owed; a message to another agent, a private chat's, an agent's are not;
  the PM's reply in the thread, its answer right below, a verdict reaction and a task opened from the request each settle
  it; eyes, another agent's reply and a person's reply do not; the list keeps 50.
- [ ] Code that passes them.

### Task 2: the pulse

**Files:** `pulse.ts`, `pulse.test.ts`, `projects.ts` (`idleSince`), `store.ts` (mark on save), `read/views.ts` +
`read/contract.ts` (`derived.pulse`), `cli/src/superTabs/reassemble.ts` (+ spec).

- [ ] Failing tests: each count (asks with oldest and who, working of crew, next up, lost, held with and without reason)
  and each red rule (ask over 15 min, Working 0 while work waits 10 min, lost 10 min, hold without reason), `idleSince`
  set and cleared, `derived.pulse` on the read, the CLI status lays it on the project.
- [ ] Code that passes them.

### Task 3: Desktop/web strip

**Files:** `desktop/lib/super_tabs/pulse.dart` (model + strip), `tasks_view.dart` (on top of the board), tests.

- [ ] Failing widget tests: the strip's text, each segment red by `redAt`, tapping a count opens its list, no strip without
  a pulse; light and dark golden screenshots.
- [ ] Code that passes them.

### Task 4: phone strip

**Files:** `mobile/lib/swarm/swarm_pulse.dart` (new), `swarm_project_tasks.dart`, tests.

- [ ] Failing widget tests as Task 3, on the task list; light and dark screenshots.
- [ ] Code that passes them.
