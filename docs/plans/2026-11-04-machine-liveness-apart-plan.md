# Machine liveness apart from the machine part (backend): implementation plan

The Engineer implements this plan task by task, test first, on one branch, and opens one pull request. Nobody is asked to
choose an execution mode. Steps use checkboxes.

**Goal:** A client that asks stops receiving a whole machine part for each reading. It gets one small line saying when that
machine last reported, and the whole part only when the part's content changed. Today's clients see no change.

**Architecture:** A reading keeps writing the same row, and `changedAt` already stays put for it. A new `contentAt` column records
when a reading changed what isn't volatile. `GET changes?machines=light` sends a part that only moved by its volatile fields as a
line in `machineReadings`. `GET machine-readings` gives the whole readings on demand, for the route and the machine panel.

**Tech Stack:** TypeScript, Prisma on MongoDB, Fastify, Vitest, integration tests on `mongodb-memory-server`.

**Spec:** Ken's machine-cap plan (2026-11-04), prerequisite 3; task #2636's brief as the PM narrowed it to the backend.

## Global Constraints

- Hosts, Desktop, the phone and the route must show the same online or offline state as before.
- Today's clients get exactly what they get now, including a higher version on each reading: they drop a part unless its version is higher.
- PR body first line: `Requested by 0xken15@gmail.com through Harness.`
- Merges through the PM's batch.

## Why no separate storage

The first proposal kept the reading beside the part. It isn't needed. A row's `data` is only read whole, the server's decisions need
the reading, and 75% of a median part is its reading, so splitting the row would save little on the server and change every
load. What costs 397 MB an hour is sending the part to every poller, and that is decided at the feed.

## What counts as volatile

Measured on production over 40 s, of 128 parts moved: `resources` and `receivedAt` 128, `harnessUncommitted` 19, `quotas` and
`profiles` 13, `privacy` 11, `harnessProgress` 9, `harnessTokens` 5, `lent` and `lentDays` 4, `readiness` 2. None moved by time alone.

Volatile: all of those but `readiness`. Anything else in a reading (running and stopped sessions, tools, readiness, capabilities,
generation, session kind) is content, so it still goes as a whole part.

## Review Focus

- A reading that changes running sessions: a whole part, since agents' state depends on it.
- A Buddy, or a Buddy-only machine: no line, as for parts today.
- A machine whose content changed inside the cursor's overlap: a whole part, never only a line.
- A removal in the same window: a stub, never a line.
- A rolling deploy: an old pod writes a content change with no `contentAt`, so a light reader gets only a line until the next
  content change or load. No light client exists until the follow-ups ship, after this is live everywhere.

## Design

- **Growth:** one optional date on `SwarmMachine`, overwritten in place and removed with the row.
- **Concurrency:** the same version-guarded write as every reading.
- **Read cost:** the feed's rows are still read and held as today, so server reads don't fall here. The reply falls for light readers.
  The read cache's 19 MB a minute per pod stays, because the server's decisions need the reading.
- **Scale:** at 10x machines, full parts cost 100x and lines cost 100x at about 1/25 the size; `machine-readings` and first loads grow
  linearly. The metric that warns first is `GET changes` bytes in `db by shape`.
- **Compatibility:** a new optional query value and a new optional reply field. An older server rejects the unknown value, so
  clients need a fallback. Old clients keep the old cost until they update.
- **Migration + rollback:** no migration. An old row has no `contentAt`, and `changedAt` stands in. Rollback leaves an unused column.
- **Audience:** a line is built from the part the reader may already see, so it shows no more than the part did.
- **Identity:** N/A because a line names a machine and a time, as the part does.
- **Failure:** a reader with a stale line sees a machine offline, as with a late part. It says so the same way.
- **Platforms:** backend only. CLI, Desktop and the phone are the PM's follow-up tasks.

## Known limit

Bytes fall only as clients update. The cap change should wait for that, not only for this release. Nothing here lowers the server's
own reads of machines.

---

### Task 1: Content is told apart from a reading

**Files:** Modify `backend/prisma/schema.prisma`, `backend/src/superTabs/parts/{types,write,commit,load}.ts`, `backend/src/superTabs/cachePatch.ts`, `backend/src/superTabs/store.ts`.

**Interfaces:** Produces `Part.contentAt?: number`, `PartWrite.content?: true`, `machineContentChanged(before, after): boolean`.

### Task 2: The light reply and the on-demand read

**Files:** Modify `backend/src/superTabs/read/{changes,contract,service}.ts`, `backend/src/routes/superTabs.ts`. Test `backend/integration/superTabMachineLiveness.test.ts`, `backend/src/superTabs/read/changes.test.ts`.

**Interfaces:** Consumes `Part.contentAt`. Produces `changesFor(view, changed, actor, light?: { since })`, `MachineReading { key, version, receivedAt }`, `SwarmReads.machineReadings(user, tabId, asAgentId?)`.

- [ ] Write the failing tests for both tasks; watch them fail; commit.
- [ ] Implement both; watch them pass; commit.
- [ ] Post red/green and the bytes; mark the PR ready; add one review step.
