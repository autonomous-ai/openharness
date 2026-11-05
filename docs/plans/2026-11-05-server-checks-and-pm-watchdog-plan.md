# Server time checks and PM watchdog Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its passing code; one review and one security review on the pull request.

**Goal:** The stall, idle and lost-task follow-ups keep running when the PM is down, and a PM that stops answering is restarted in place by its own host. Strengthens "Tell the PM what you want, and your crew ships it": an ask never waits unseen because one agent hung (anh Dee's Swarm redesign, 11-05, step 1).

**Architecture:** The backend worker gets one more pass, every 30 s. For each Swarm with recent activity it loads the Swarm and runs the time checks the PM's poll ran before (`sweepForLead`: lost tasks, failed starts, stalled tasks) and the idle notices. The pass also records, per project, the oldest message a person sent the PM that it has not answered yet (`project.owed`), and writes only when that changes. The PM's poll no longer runs those checks. The PM's host row carries `owed` and how long it may wait (`restartAfterMs`, from the backend, so the number is server data). The host's lead keep-alive gets a second trigger: an owed ask past `restartAfterMs`, while the PM has been in one turn for that long or its screen has not changed for that long, restarts the PM in its own pane on the same session (`agent_restart`, as the relay recovery does). It never reopens or starts a second PM, and it restarts at most once per owed ask.

**Tech Stack:** TypeScript, Prisma/MongoDB, Vitest (backend unit + Super Tab integration), Vitest (CLI specs with a fake core).

**Spec:** Task #3385, Super Tab conversation 16ef5ccda66319b5a6d75102 (River for anh Dee, 2026-11-05).

## Global Constraints

- Act and notify; no new refusal anywhere.
- Lifecycle code is tested with a fake host and fake core. No test signs the Mac out of the real CLI.
- Swarm code stays out of `cli/src/core`.
- PR body starts `Requested by dee through Harness.`
- One review and one security review (it restarts agents).

## Design

- Growth: `project.owed` is one small record per project, replaced or removed, never appended. The pass keeps nothing else.
- Concurrency: each Swarm is checked in its own transaction, as the PM's poll did; a conflicting write retries, and the recorded task state makes a second run find nothing new. The worker is the singleton process and runs one pass at a time.
- Read cost: candidates come from the `[dormant, lastActivityAt]` group index (groups active in the last 7 days, at most 200 Swarms a pass). Each Swarm is one load, which the PM's poll did every 30 s before and no longer does. The owed ask is a few indexed reads on `[tabId, agentId, status, createdAt]`, one per open status.
- Scale: 10x Swarms means 10x loads per pass. The first warning is the pass's duration line, logged when a pass takes longer than its interval.
- Compatibility: an older host ignores `owed` and keeps the crash-only keep-alive. A new host on an older backend sees no `owed` and never restarts for it. An older backend's PM poll still runs the checks, so a mixed rollout only runs them twice, and the records dedupe that.
- Migration + rollback: none. Rolling back leaves `project.owed` unread, and the PM's poll runs the checks again.
- Audience: `owed` goes only in the PM's own host row, to its machine's host. It holds a message id and a time, never text.
- Identity: the pass writes as the project's PM, as the poll did. A restart goes through the machine's own daemon socket, for a session that host already runs.
- Failure: one Swarm's failure is logged and skips that Swarm. A failed restart is logged and not retried for the same ask; the crash keep-alive is unchanged.
- Platforms: backend; the CLI host on macOS, Linux and Windows (`agent_restart` relaunches in the same pane and opens no window).

## Review Focus

- The PM's poll loses exactly `sweepForLead` and `idleNotices`, nothing else (digest, schedule, update request and stale runs stay).
- The watchdog never runs while a reopen or an engine switch is in progress, and the keep-alive never reopens while a restart is running or settling: two PMs must be impossible.
- Once per owed ask: a PM that stays stuck after its restart is left to people, not restarted in a loop.

## Task 1: the backend runs the time checks without a PM poll

**Files:** `backend/src/superTabs/timeChecks.ts` (new), `backend/src/superTabs/store.ts`, `backend/src/worker.ts`, `backend/integration/superTabTimeChecks.test.ts` (new), integration fixtures that drove the checks through the PM's poll.

**Interfaces:** `SuperTabStore.runTimeChecks(tabId): Promise<number>` (messages written). `startTimeChecks(db, store, everyMs = SWEEP_EVERY_MS): () => void` and `timeCheckSwarms(db, now, limit)`.

- [x] Integration test: with no PM poll at all, a quiet task, an idle agent and a lost task each produce their notice from `runTimeChecks`, once; a second run writes nothing.
- [x] Integration test: the PM's poll alone no longer writes them.
- [x] Watch both fail.
- [x] Add `runTimeChecks`, the pass and its worker start; remove the two calls from the poll. Point the fixtures that relied on the poll at `runTimeChecks` first.
- [x] Run the changed integration files.

## Task 2: the backend records what the PM owes

**Files:** `backend/src/superTabs/timeChecks.ts`, `backend/src/superTabs/projects.ts`, `backend/src/superTabs/read/hostRows.ts`, `backend/integration/superTabTimeChecks.test.ts`.

**Interfaces:** `Project.owed?: { messageId: string; since: number }`. Host row `owed: { messageId, since, restartAfterMs } | null` on the PM's row.

- [x] Integration test: a person's message to the PM is recorded as owed; the PM's answer clears it; an agent's message never counts; the PM's host row carries it with `restartAfterMs`, another agent's row does not.
- [x] Watch it fail, then implement.

## Task 3: the host restarts a stuck PM once

**Files:** `cli/src/superTabs/host.ts`, `cli/src/superTabs/host.spec.ts`.

**Interfaces:** `SuperTabHostOptions.restartLead?(harnessId)`, default the daemon's `agent_restart`.

- [x] Spec: owed ask past its time and the PM in one turn that long: restarted once, in place; more polls, still once; `keepLeadAlive` never called while the restart runs or settles, even when the session briefly reads as gone.
- [x] Spec: a frozen screen counts the same; an idle PM, an ask not yet due, or a PM that ended a turn recently is never restarted.
- [x] Watch them fail, then implement.
- [x] Run the host spec and the CLI coverage gate for the Super Tab host.
