# Machine background writes Implementation Plan

> Written and carried out by the task's Engineer, test first, by these project instructions (no subagent-driven
> development, no execution handoff).

**Goal:** Ken's prod scan of 11-04 found `Machine.update` by `machineId`, in background work, slow 53 times in 32
minutes (19 s total, max 723 ms). Background writers of a Machine row skip writes that change nothing and merge the
writes one connect makes into one.

**Architecture:** The background `Machine.update` calls are the adapter socket's (`backend/src/lib/adapterWs.ts`): the
upgrade and its timers run outside any request, so `lib/queryStats.ts` names them `background`. One reconnect makes up
to four updates of the same row: the team flip at the upgrade (rare), the connection facts (hostname, clientVersion,
computerId, countryCode, sessionKind, a seeded name) on every connect, the connect's `lastSeenAt` stamp at the same
moment, and the close stamp; a connected machine adds one stamp every 5 minutes. After this change a connect writes
one update holding only the facts that differ from the row read at the upgrade, plus the stamp only when the row's
stamp is due (5 minutes old or another UTC day). A new socket floors its heartbeats on the row's stamp, not on its own
start. The close stamp stays: it is the exact "offline since". The filter stays the unique `machineId` index.

**Tech Stack:** TypeScript, Fastify, `ws`, Prisma on MongoDB, Vitest.

**Spec:** the task brief (#2676) and Ken's numbers in it. No production access.

## Global Constraints

- Backend only. No env switch: ships on. No index is created; the PR says what `{planId, authMode}` matches.
- `machines.lastSeenAt` keeps its contract: lags real liveness by at most `MACHINE_PRESENCE_WRITE_MS`; close is exact.
- A failed write never advances the socket's floor, so the next heartbeat retries.
- A former team row is still set to `computer` before the socket attaches.

## Review Focus

- The connect write's diff against the upgrade's row: a fact that changed must still be written.
- Stamp floor seeded from the row: no window longer than the interval without a stamp while connected.
- Write counts per connect, heartbeat and close (test `adapterMachineWrites.test.ts`).

## Tasks

### Task 1: dailyTracking helpers

**Files:** `backend/src/lib/dailyTracking.ts`, `backend/src/lib/dailyTracking.test.ts`

**Interfaces:**
- `machineConnectChanges(row, next): MachineConnectChanges` — the fields of `next` that differ from `row`.
- `presenceStateFromRow(lastSeenAt): PresenceWriteState` — the row's stamp as a socket's write state.
- `touchMachineOnlineDay(userId, machineId, now, { isNewConnection, countryCode?, changes?, stamp? })` — one update of
  `changes` plus `lastSeenAt` unless `stamp` is false; no update when both are empty; the connect total as before.

- [ ] Failing tests: unchanged facts give no changes; a changed fact is kept; the row's stamp seeds the floor; no
      update when nothing changed and no stamp; changes and stamp go in one update.
- [ ] Implement; run `npm test -- src/lib/dailyTracking.test.ts`.

### Task 2: one write per connect in the adapter socket

**Files:** `backend/src/lib/adapterWs.ts`, `backend/src/lib/adapterMachineWrites.test.ts` (new),
`backend/src/lib/teamSessionSockets.test.ts`

- [ ] Failing tests (real dailyTracking, mocked Prisma), counting `machine.update` calls:
  - a reconnect whose facts are unchanged and whose row was stamped a minute ago writes nothing on connect;
  - a connect after 5 minutes away writes one update with the stamp; a changed version rides in it;
  - heartbeats on that socket write only when the row's stamp is 5 minutes old; close stamps once;
  - a former team row is flipped before attach and not written again on connect.
- [ ] Implement: pass the upgrade's row to `attachAdapter`, compute changes, one `touchMachinePresence('connect',
      changes)`; seed the floor from the row.
- [ ] Run `npm test -- src/lib/adapterMachineWrites.test.ts src/lib/teamSessionSockets.test.ts
      src/lib/adapterTuiPresence.test.ts src/lib/adapterShortTurns.test.ts src/lib/adapterRoutes.test.ts`, then the
      backend unit suite (`npm test`).
