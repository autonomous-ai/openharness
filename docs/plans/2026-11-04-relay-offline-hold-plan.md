# Relay: no dial for a machine the list shows offline — Implementation Plan

> Written by the writing-plans skill as this project's instructions use it: the Engineer implements it task by task,
> each failing test committed before its code. No execution handoff.

**Goal:** The CLI relay never opens a backend socket for a machine the account's machine list shows offline; it
dials again once the list shows it online. A machine refused as offline with no list to go by is asked again after
30 s, 1, 2, 4, then every 5 minutes instead of every 30 s.

**Architecture:** The gateway's machine list (`accountHttp.ts`, the one `GET /api/machines` cache) tells the relay
pool which machines it last read as offline. `RemoteRelayPool.connect()` answers a select of such a machine with
`MACHINE_OFFLINE` from that record, without a socket, and while it holds selects asks the list again at most every
5 minutes (one read for every machine, served from the cache when anything else read it lately). A list that
says a held machine is online lifts its hold and its backoff, so the next select dials at once. The background
pools share the window pool's record, as they share its refusals.

**Tech Stack:** TypeScript, Node `ws`, vitest.

**Spec:** Task #2598's brief (Ken's database plan, Group B item 5, 2026-11-04); `cli/src/lib/remoteRelay.ts`'s
2026-10-28 backoff (#2027).

## Global Constraints

- Owns the CLI relay dialer and its backoff and their tests: `cli/src/lib/remoteRelay.ts`,
  `cli/src/gateway/accountHttp.ts`, `cli/src/gateway/start.ts` (wiring only). Nothing in `cli/src/core`.
- CLI specs with a scratchpad TMPDIR (`TMPDIR=$(mktemp -d)`); temp files only in `mktemp -d` folders.
- Never run a test that signs the Mac out of the real CLI.
- Measure refused opens per hour before and after from the backend logs (aggregates only): the `ws counters` line
  and the relay's `web-ws disconnected` lines with `client=relay`, same weekday hours.
- PR body first line: "Requested by 0xken15@gmail.com through Harness."
- Ships with the next CLI release, through the PM's batch.

## Design

- **Growth:** the record holds one id per machine on the account's list, replaced whole on every list read; a
  sign-out (list null) clears it.
- **Concurrency:** one gateway process, single-threaded; the pools share one in-memory record.
- **Read cost:** held selects cost no backend read; the list is re-read at most every 5 minutes per daemon while
  selects are held, and not at all when something else read it within that time.
- **Scale:** at 10× offline machines per user the dials stay 0 and list reads stay ≤12 an hour per daemon; the
  first warning is the `ws counters` relay connects per minute.
- **Compatibility:** no wire change. Old backends and old windows see the same `MACHINE_OFFLINE` (1013) they see
  today. Old CLIs keep their 30 s backoff until they update.
- **Migration + rollback:** none; in-memory only. Rollback is the previous CLI.
- **Audience:** the backend still refuses every select it gets; this only sends fewer.
- **Identity:** the daemon's own sign-in, as today.
- **Failure:** a held select is answered `MACHINE_OFFLINE`, which the app already shows and parks on. A list that
  could not be read keeps the last one; one older than 15 minutes holds nothing, and the ordinary backoff decides.
- **Platforms:** all; no platform code.

## Review Focus

- A machine that comes online while nothing reads the list: held at most 5 minutes (the next select re-reads it).
- A list from before a sign-in change: a null list (sign-out) lifts every hold.
- A machine the list does not name (a shared machine, a list from before it was added): never held by the list.
- An explicit redial (`forceReconnect`) of a listed-offline machine: held too; the backend would refuse it.
- A machine the list shows online that the backend still refuses: the longer offline backoff, not the list. Both read
  the same presence, so they disagree only for a moment.
- An explicit redial inside the backend's retry-after: waits it out even when the backoff step equals it (the old
  record lost that when the two were equal; Task 2 keeps the retry-after's end on its own).

---

### Task 1: The pool holds machines the list shows offline

**Files:**
- Modify: `cli/src/lib/remoteRelay.ts`
- Test: `cli/src/lib/remoteRelayListed.spec.ts` (new)

**Interfaces:**
- Produces: `RemoteRelayPool.listed(offline: string[] | null): void`; option
  `recheckList?: () => void` on `RemoteRelayPoolOptions`; shared record option `listedOffline?: ListedOffline`.

- [x] **Step 1: Write the failing tests** (`remoteRelayListed.spec.ts`, a fake backend that answers every select
  `MACHINE_OFFLINE` and counts sockets):
  - `listed([m])` then window, background and redial selects: each rejects `{ message: 'MACHINE_OFFLINE',
    closeCode: 1013 }`; 0 sockets, also 10 minutes later.
  - then `listed([])` (online): the next select dials (1 socket).
  - after a refusal backoff, `listed([])` lifts it: the next select dials at once.
  - `listed(null)`: nothing held; a list read 15 minutes ago holds nothing.
  - held selects call `recheckList` once, again only 5 minutes later.
  - a machine absent from the list is dialled as before.
- [x] **Step 2: Run and watch them fail:** `cd cli && TMPDIR=$(mktemp -d) npx vitest run src/lib/remoteRelayListed.spec.ts`
- [x] **Step 3: Implement** `listed()`, the hold in `connect()`, the shared record passed to background pools.
- [x] **Step 4: Run them and `src/lib/remoteRelay*.spec.ts`; all pass.**
- [x] **Step 5: Commit** test, then code.

### Task 2: A machine refused as offline backs off to 5 minutes

**Files:**
- Modify: `cli/src/lib/remoteRelay.ts` (`backOff`)
- Test: `cli/src/lib/remoteRelayRefusal.spec.ts`

- [x] **Step 1: Failing test:** `MACHINE_OFFLINE` with `retryAfterMs: 30_000` is dialled again after 30 s, 60 s,
  2, 4, 5, 5 minutes; other refusals keep 1, 2, 4 … 30 s.
- [x] **Step 2: Run, watch it fail.**
- [x] **Step 3: Implement:** for `MACHINE_OFFLINE`, backoff `min(OFFLINE_BACKOFF_MAX_MS = 5 min, 30 s × 2^(n-1))`.
- [x] **Step 4: Run the relay specs; pass.**
- [x] **Step 5: Commit** test, then code.

### Task 3: The gateway's machine list tells the pool

**Files:**
- Modify: `cli/src/gateway/accountHttp.ts` (dep `offline?(machineIds: string[] | null)`, return `recheck(maxAgeMs)`),
  `cli/src/gateway/start.ts` (wire `offline` → `relayPool.listed`, `recheckList` → `recheck`)
- Test: `cli/src/gateway/accountHttp.spec.ts`

- [x] **Step 1: Failing test:** a list read with one machine `stopped` and one `running` calls `offline([stopped])`;
  a sign-out calls `offline(null)`; `recheck(60_000)` within a minute of a read makes no request.
- [x] **Step 2: Run, watch it fail.**
- [x] **Step 3: Implement.**
- [x] **Step 4: Run `src/gateway` and relay specs, `npm run typecheck`.**
- [x] **Step 5: Commit** test, then code.

### Task 4: Evidence

- [ ] Before/after refused opens per hour from the backend logs (aggregates): before ~3,600 an hour (the brief, 2026-11-04);
  after read hourly from the production logs by an agent on Ken's Mac once the CLI release ships (River, 2026-11-04).
- [x] Red/green evidence comment on the PR.
