# Idle cleanup and closed Swarm agents: plan

> Written by the task's Engineer and implemented by it, plan task by plan task, test first (project instructions,
> Engineer). No Execution Handoff.

**Goal:** A Swarm agent is never given a task after the idle cleanup closed its session, and the cleanup never closes an
agent that holds an assignment, while genuinely idle agents still close after 30 minutes (task #2744).

**Architecture:** Two halves of one race. The backend refuses `work.assign` to an agent whose machine's fresh reading
proves its session stopped (`AGENT_CLOSED`), so the PM's assign can no longer land on a closed session; the existing
removal (`closedAgents.ts`, 30 s after the stopped reading) then takes the agent off the roster with no task and no
"lost" line. The CLI host keeps every harness that holds an assignment in the Super Tab retention file, and for a minute
after the host first received it, so the cleanup's re-read just before a close (already there) also sees work that
arrived after the agent's last group was archived.

**Tech Stack:** TypeScript; backend (Fastify, Prisma/Mongo state parts, vitest); CLI daemon services and Swarm host
(vitest).

**Spec:** the brief of task #2744. What the logs showed, 11-04 on the Mac Studio (`~/.harness/cli/data/harness.log`
and the task's chat): the cleanup closed Tern at 13:57:51 VN, and the PM assigned Tern at 13:57:57, six seconds *after*
the close. Tern's last group was archived, so it was no member the retention file kept. The machine's next reading (every
5 s) listed the session stopped, but `work.assign` does not read it, so the task went to a closed session and was lost;
an agent holding a lost task is kept on the roster until its Lead hands the task on (`removeClosedAgents`), which is why
it stayed listed until 14:10.

## Global Constraints

- Swarm code stays out of `cli/src/core`. The cleanup (`cli/src/services/agentCleanup.ts`) keeps reading retention
  through its `retained` port; nothing Swarm-specific goes into it.
- No new stored data in the backend: the refusal reads the machine's last observation, which is already stored.
- The retention file stays version 2 and is only extended (`assigned`, optional). An older CLI reading a newer file
  ignores the field; a newer CLI reading an older file sees no assignments, as before.
- Old clients: an older CLI's assign of a closed agent gets the same refusal with a message the PM can act on.
- Red-first: every risk the brief names gets a test that fails without its change.

## Review Focus

- The refusal must never hit a live session: a session resumed after a stop (renewed reservation without generation
  proof), a stale reading (machine silent), or a reading that lists it running.
- The `assigned` grace must not keep anything forever: an entry goes once its assignment row is gone and a minute has
  passed since it was first received.

## Design

- growth: `assigned` holds at most the machine's assignment rows plus those ended in the last minute; an entry goes on
  the next write after both are past.
- concurrency: the retention file is written whole and renamed by the host's poll, as today; the backend check runs
  inside the command's state transaction.
- read cost: the host passes the assignment rows it already read; no new request. The backend reads one machine record.
- scale: 10x agents per machine is 10x entries of ~60 bytes; the 4 MB file cap is far away.
- compatibility: covered above (file extended, refusal is a new error code on an existing command).
- migration + rollback: none; rolling back leaves an `assigned` field older CLIs ignore.
- audience: unchanged; the retention file is 0600 in the daemon's data folder.
- identity: N/A because nothing here signs in or acts as anyone.
- failure: the refusal says why and what to do ("start a new agent"); a retention write failure is logged and pauses
  cleanup, as today.
- platforms: macOS, Linux and Windows CLI (same code); backend.

## Task 1: Backend refuses assigning a closed session

**Files:** `backend/src/superTabs/closedAgents.ts` (`sessionStopped`), `backend/src/superTabs/commands.ts`
(`work.assign`), `backend/src/superTabs/closedAgents.test.ts`, `backend/src/superTabs/commands.test.ts`.

**Interfaces:** `sessionStopped(state, target, now): boolean` — the agent's machine's last reading is fresh
(`MACHINE_FRESH_MS`), lists its harness stopped and not running, with the same reservation proof `closedAgents` uses.

- [ ] Test: an agent whose fresh reading lists it stopped is refused with `AGENT_CLOSED` and nothing changes (no
  assignment, no member added); one on a stale reading, one listed running, and a renewed reservation without proof are
  assigned as before. Watch it fail.
- [ ] Code: `sessionStopped` and the check in `work.assign` before any change. Watch it pass.
- [ ] Test: a closed agent the assign was refused for leaves the roster on the next report with no lost line (existing
  removal, now reachable). Run `closedAgents.test.ts` and the `work.assign` tests.

## Task 2: CLI retention keeps harnesses that hold an assignment

**Files:** `cli/src/superTabs/retention.ts` (`retainContributions`, `retainedHarnesses`), `cli/src/superTabs/host.ts`
(poll passes its assignment rows), `cli/src/superTabs/retention.spec.ts`, `cli/src/services/agentCleanup.spec.ts`.

**Interfaces:** `retainContributions(dataDir, machineId, rows, now, assignments = [])`; the file's optional
`assigned: Record<harnessId, firstReceivedAtMs>`; `ASSIGNED_GRACE_MS = 60_000`.

- [ ] Test (retention): a harness whose roster row is inactive (only archived groups) but which holds an assignment row
  is retained; after the row is gone it stays retained until a minute after it was first received, then is released;
  an unchanged assignment set does not rewrite the file. Watch it fail.
- [ ] Test (cleanup): an assignment arriving inside the close window (between the look's read and the close) keeps the
  agent; a long-idle agent with no task is still closed. Watch the first fail.
- [ ] Code: record and read `assigned`; the host's poll passes `assignments`. Watch them pass.
- [ ] Run `retention.spec.ts`, `agentCleanup.spec.ts`, `host.spec.ts`, and `npm run test:core` (services gate).
