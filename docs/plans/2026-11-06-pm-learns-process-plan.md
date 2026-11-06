# Every PM learns the current process (task #3581)

> Implemented by its Engineer test first, by superpowers:test-driven-development, as the project's instructions say
> (Engineer role). No subagent-driven-development and no execution handoff.

**Goal:** lamp's PM (Faye) did not know the Swarm v2 process (anh Dee, 11-06). Every project's PM learns it from its own
tools, hears once when a release changes how PMs work and confirms it, and is told while its project has no crew.

**As built:** the no-crew line rides on the PM's wakes only, as the brief says ("at its next wake until it marks one"),
not on every inbox digest; the what-changed note is in both until confirmed. To fit the manual's 24 KB, the route and
start blocks say the same in fewer words, and the manual has 2 bytes left: the next addition needs a trim or a new cap.
After SecAlder's review, a PM's wakes and inbox list every note after the newest it confirmed (oldest first), not only the
newest, and confirming the newest clears them all; confirming an older note after a newer one never brings the newer back.

**Architecture:**
1. The manual (cli/src/lib/swarmTools.ts) gains a "Crew and lanes" section, carried by the coordinator's sheet
   (swarmToolSheets.ts) in one line: mark a standing crew once (`crew.add` with role and lane), give each task a lane
   (`work.lane`), start a new agent only to replace a broken one, answer each person's message once in its place
   (`answer`), confirm each what-changed note (`process.confirm`).
2. What changed for PMs is a list of notes in the backend (backend/src/superTabs/processNotes.ts), newest last. The newest
   note pins fingerprints of the PM sheet and of the built-in PM schedule (pmSchedule.ts PM_SCHEDULE_TEXT): a test fails in
   the CLI when the PM sheet changes, and in the backend when the schedule changes, until a note is added for it. A project
   whose PM has not confirmed the newest note is woken once for it (a `process` job in the schedule's wake), and every
   wake and inbox after lists it as owed until the PM sends `process.confirm`. The board's pulse names the note a project's
   PM has not confirmed.
3. A project with no agent marked crew: its PM's wake and inbox say so, until it marks one. That line never wakes the PM
   by itself.

**Tech Stack:** TypeScript, vitest (backend), the CLI's spec runner.

**Spec:** task #3581's brief (River, 11-06).

## Global Constraints

- The PM sheet stays within its 3 KB (swarmToolSheets.spec.ts); the manual keeps one row per block.
- A note wakes a PM once; the crew line rides on wakes already due, so an idle project is never woken every 30 minutes.
- Swarm code stays out of cli/src/core.

## Design

- growth: one small record per project (`processNote`: the note it was told and the one it confirmed); notes are code.
- concurrency: written in the PM poll's own write (recordWake) and in the `process.confirm` command, as the schedule is.
- read cost: none; the wake already reads the project and its agents.
- scale: one wake per project per note; at 10x projects the wake count per release grows linearly, the first warning.
- compatibility: an older CLI ignores the wake's extra lines' meaning but shows them; an older backend ignores the record.
- migration + rollback: none; a project with no record has confirmed nothing and is told the newest note once.
- audience: only the project's PM confirms its note; the pulse shows only a note id, which names no person.
- identity: the PM by its agent id, never a login.
- failure: an unknown note id is refused; nothing else is.
- platforms: server and CLI text only.

## Review Focus

- A PM is woken once per note, never every poll; confirming ends the owed line and the pulse entry.
- The fingerprint tests fail when PM text changes without a note.

## Tasks

### Task 1: the coordinator's sheet explains the crew

**Files:** cli/src/lib/swarmTools.ts, swarmToolSheets.ts, swarmToolSheets.spec.ts.

- [ ] Failing test: the PM sheet names crew.add with role and lane, work.lane, starting an agent only to replace a broken
  one, answering once in place, and process.confirm; it stays within 3 KB.
- [ ] Code.

### Task 2: a release's what-changed note reaches each PM once, owed until confirmed

**Files:** backend/src/superTabs/processNotes.ts (new), pmSchedule.ts, inbox.ts, pulse.ts, commands.ts, model/projects
types; cli/src/lib/swarmToolSheets.ts (the sheet's pinned note).

- [ ] Failing tests: a PM that has not confirmed the newest note gets one wake naming it, not a second; its wakes and
  inbox list it as owed until `process.confirm`; the pulse names it until then; the schedule's and the sheet's
  fingerprints match the newest note.
- [ ] Code.

### Task 3: a project without a crew says so in its PM's inbox

**Files:** pmSchedule.ts, inbox.ts.

- [ ] Failing test: with no crew, a due wake and the inbox say so; once an agent is marked crew they don't; the line
  alone wakes nobody.
- [ ] Code.
