# A start whose host reports are refused fails at once: implementation plan

> Way of working: this project's instructions (Engineer role). The Engineer implements it task by task, each failing
> test committed before its code, and one Review step on the pull request. Steps use checkbox (`- [ ]`) syntax.

**Goal:** when the server refuses a host's report for a start on that host's machine, the start fails at once, and the
refusal's reason is on the start for those who may read it. Today it waits silently until the 3-minute timeout
("<machine> did not start it within 3 minutes"), and the reason exists only in that machine's daemon log.

**Architecture:** the host already tells the server, in its machine reading, which starts it is preparing
(`preparingStartIds`), and the liveness sweep acts on that. A new reading field does the same for refusals:
`refusedStarts: [{ startId, reason }]`. The CLI host loop records each start whose host-route call the backend refused
with a 403, and sends it in its next reading. The backend keeps only this machine's own undecided starts, as it does for
preparing ones, and the sweep (liveness.ts `failStalledStarts`) fails each one named there at once. No access check
changes: only a reading the store already accepts for this machine's pool (its contributor, its generation) can name a
start, and only a start on that machine that has neither started nor failed. That is what the host could already do with
`agent.startFailed` while its reports pass, and what the timeout does anyway three minutes later.

**Tech Stack:** TypeScript; backend Fastify + Prisma on MongoDB (Vitest integration on MongoMemoryReplSet); CLI host
(Vitest specs).

**Spec:** task #2441 brief, as River narrowed it (2026-11-03 10:4x UTC): "a host report refused after dispatch fails the
start at once and shows the refusal's reason in the app. Keep the access check unchanged." The access check's own cause
waits for the affected Mac's daemon log and becomes its own fix.

## Global Constraints

- PR body first line: "Requested by diego@autonomous.ai through Harness."
- No access check changes (`poolHostActor`, `contribution`, `hostFor` untouched).
- Swarm code stays out of `cli/src/core`.
- Members who are neither the start's maker, its coordinator nor its machine's owner read `publicReason`, never the raw
  refusal (startFailure.ts); no reader ever reads a machine's `refusedStarts`.
- An older backend refuses the new field: the CLI sends that Swarm's reading without it, as for every field before it.

## Design

- Growth: nothing new is stored beyond the latest reading: at most 100 entries, reason at most 300 characters, replaced by
  each reading, and filtered to this machine's undecided starts.
- Concurrency: the reading's existing write (one machine part per Swarm); the sweep runs in it, as for preparing starts.
- Read cost: no new reads. A changed refusal set makes that reading a full report (`readingOnly`), as a changed preparing
  set does; an unchanged one stays a fast reading.
- Scale 10x: bounded per reading; the sweep is already linear in the Swarm's starts.
- Compatibility: an older CLI never sends the field (its starts time out as before). A newer CLI to an older backend:
  the field is refused and dropped for FIELD_REFUSED_MS (cli machines.ts `sendAlone`).
- Migration + rollback: none; the field is optional. Rollback: release the previous backend, which refuses the field;
  the CLI then drops it.
- Audience: the server enforces it. Readers' copies of machine readings drop `refusedStarts` (model.ts visibility), and
  the start's raw error is read only by `readsRawReason`.
- Identity: a machine names only starts on itself, through its own pool's reading.
- Failure: this change is the failure becoming visible; a refusal the CLI cannot report (the reading itself refused)
  still ends at the timeout, as today.
- Platforms: backend; CLI on macOS, Linux and Windows (host loop only).

## Review Focus

1. A reading from another machine naming the start: ignored (Task 1 test).
2. A start that already started, or already failed: never failed again or rewritten (Task 1 test).
3. A refusal for a start before dispatch: fails it too, at once (Task 1 test).
4. A transient failure (timeout, 5xx, network): never reported as refused (Task 2 test).
5. A Buddy on its person's own machine outside the Swarm: its person reads the refusal (Task 1 test).

---

### Task 1: the backend fails a start its own machine reports refused

**Files:**
- Modify: `backend/src/superTabs/machines.ts` (schema field `refusedStarts`, `storedObservation`, `readingOnly`)
- Modify: `backend/src/superTabs/liveness.ts` (`failStalledStarts`)
- Modify: `backend/src/superTabs/startFailure.ts` (`REFUSED_INFIX`)
- Modify: `backend/src/superTabs/model.ts` (readers' copies drop `refusedStarts`)
- Test: `backend/integration/superTabLiveness.test.ts`, `backend/integration/superTabBuddies.test.ts`

**Interfaces:**
- Produces: `machineObservationSchema.refusedStarts?: Array<{ startId: string (1..160); reason: string (1..300) }>` (max 100,
  strict objects). Stored only for starts where `start.request.machineId === machineId && !start.harnessId && !start.error`.
- Produces: `export const REFUSED_INFIX = ' refused it: '`; the start's error is `${machineName}${REFUSED_INFIX}${reason}`.

- [ ] **Step 1: failing tests**
  - superTabLiveness: `fails a start its own machine reports refused, at once, with the refusal's reason`: launch,
    observe `test-host` with `refusedStarts: [{ startId, reason: 'This start does not belong to this machine contribution.' }]`
    → the Lead's start read has error `Worker Mac refused it: This start does not belong to this machine contribution.`;
    the Lead's inbox has the `start-timeout` notice `Could not start Builder on fixture-model: its machine could not
    prepare or launch it. …`; a later `agent.started` is refused `START_FAILED`.
  - superTabLiveness: `is not failed by another machine's report, never rewrites a decided start, and no reader reads the
    refusals`: `lead-host` names the start → no error; a started start named by `test-host` keeps no error; the owner's
    read has no `refusedStarts` on any machine.
  - superTabLiveness: `fails an undispatched start its machine reports refused`.
  - superTabBuddies: `a Buddy on its person's own machine outside the Swarm fails at once when its host's report is
    refused, and its person reads why`: buddy.create with setup on `peer-laptop`, dispatch, observe with
    `refusedStarts` → peer's read of the start has the raw error; the owner's read does not list the machine.
- [ ] **Step 2: run red:** `cd backend && npm run test:super-tabs -- integration/superTabLiveness.test.ts integration/superTabBuddies.test.ts -t refused`
  Expected: FAIL (the schema refuses `refusedStarts`).
- [ ] **Step 3: commit the red tests.**
- [ ] **Step 4: implement** as the Interfaces say; in `failStalledStarts`, before the timeout checks, a start with no
  `harnessId` and no `error` named in its own machine's fresh reading fails with the same notices the timeout writes
  (`noteStartFailed`, lead/Buddy/session/task notice).
- [ ] **Step 5: run green**, then `npm run typecheck`.
- [ ] **Step 6: commit.**

### Task 2: the CLI host reports the starts the backend refused

**Files:**
- Modify: `cli/src/superTabs/machines.ts` (host loop records refusals; reading field; `sendAlone` fallback)
- Test: `cli/src/superTabs/machines.spec.ts`

**Interfaces:**
- Consumes: Task 1's `refusedStarts` field.
- Produces: a host-route call for a start that throws, or answers, a backend 403 records `{ startId, reason: message }`
  (reason cut to 300 characters); the next reading of that Swarm carries it while the start is still pending there.

- [ ] **Step 1: failing tests** (machines.spec.ts):
  - `reports a dispatched start whose host report the backend refused, with the refusal, in its next reading`
  - `reports nothing for a timeout or a 5xx, and drops a start once it is no longer pending`
  - `sends the reading without refusedStarts to a backend that refuses the field`
- [ ] **Step 2: run red:** `cd cli && npx vitest run src/superTabs/machines.spec.ts -t refused`
- [ ] **Step 3: commit the red tests.**
- [ ] **Step 4: implement.**
- [ ] **Step 5: run green**, then `npm run typecheck` in cli.
- [ ] **Step 6: commit.**

### Task 3: before Ready

- [ ] Full Super Tab integration suite (`npm run test:super-tabs`), backend typecheck; CLI `test:orchestrator` coverage
  gate if it covers machines.ts.
- [ ] Red/green evidence as a PR comment; mark Ready; one Review step by Routing (access checks unchanged, River).
