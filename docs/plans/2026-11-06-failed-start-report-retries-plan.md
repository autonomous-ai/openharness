# Failed-start report retries implementation plan

> Native implementation, task by task, test first; independent review of the complete pull request.

**Goal:** Stop repeating a failed-start report the server refuses as missing, while real failures reach the server and transient reporting failures retry with capped backoff.

**Architecture:** Keep one report state per currently listed start inside ContributedMachines. The existing scoped host request intercepts every agent.startFailed path. A queued report is retried directly, without preparing or launching again. NOT_FOUND and accepted reports are terminal until the feed drops that start; all other failures retry after 15, 30, 60, 120, 240 then 300 seconds, capped at 300 seconds.

**Tech Stack:** TypeScript and Vitest; existing host feed, backend request timeout and monotonic injected clock; no dependency or backend/schema change.

**Spec:** Task #3845, Ken's production scan and River's brief: missing-start report sent once, other failures back off with a cap; real failure still reported; no secret in logs.

## Global Constraints

- Swarm code stays outside cli/src/core; stop only processes started here, by id.
- No real sign-in, daemon, tmux or home-folder writes in tests; use existing fake Core and injected backend.
- No error bodies or report text in new diagnostic logs; fixed messages only.
- Local affected tests/importers and CLI typecheck; automatic PR CI supplies the full unit suite.
- PR body starts `Requested by 0xKen15 through Harness.`

## Design

- **Growth/lifecycle:** One in-memory entry per feed-listed start, removed when it disappears or the host has no contributions. No persistent data, collection or index. Reports retain only existing command input, operation id and retry timing.
- **Concurrency:** Existing single-flight tick serializes report attempts; preserve the original operation id on every retry.
- **Read cost/scale:** No extra reads/timers; reuse the existing host pass and bounded two-start round. A pending report skips preparation/native launch. At ten times pending starts memory grows linearly with the existing host feed; production warning count and local fixed retry/recovery logs expose failures.
- **Compatibility/migration/rollback:** No wire change; existing NOT_FOUND is terminal for agent.startFailed only. Restart can resend an unacknowledged report with its original server receipt, as today. Rollback only restores old retry cadence.
- **Audience/identity:** Existing machine-scoped endpoint and credentials unchanged. No new rights. Logs contain neither raw error text nor report bodies.
- **Failure/platforms:** Report failures stay visible through a fixed pending/recovery diagnostic; transport and non-NOT_FOUND refusals retry indefinitely at a capped delay. TypeScript host behavior on macOS/Linux/Windows; no process creation or UI change.

## Review Focus

1. NOT_FOUND on another command must keep its existing behavior; terminate only failed-start reporting.
2. Unknown and transient refusals must retain a real failure's original command and operation id.
3. A completed failure report must never retry an undispatched launch on a stale feed; an already-dispatched receipt retains its existing reconciliation/abandoned cleanup.
4. A missing start must not block a different pending start or pollute logs with server-provided text.
5. Dropped contributions/start rows must release report state; cancellation/abandoned native cleanup stays independent.

## Task 1: Bound failed-start reporting

**Files:** Modify `cli/src/superTabs/machines.ts`; tests in `cli/src/superTabs/machines.spec.ts`. Importer checks: host.spec.ts, cloneTrust.spec.ts; adjacent start.spec.ts.

**Interfaces:** Existing ScopedRequest and ContributedMachines.tick remain unchanged. Private report state stores original `{operationId,command}`, endpoint, attempts and nextAt/terminal state. Existing backend rejects with SuperTabHostError; do not change backend semantics.

- [ ] Commit failing tests: NOT_FOUND sends once over many passes with one fixed log; transport/other refusal attempts at 15/30/60/120/240/300-second intervals and repeats at cap; success reaches server once; retries preserve operation id, do not relaunch, and do not log fixture secret text; a second start still runs.
- [ ] Run `cd cli && npm test -- src/superTabs/machines.spec.ts -t 'failed-start report'`; observe behavior failures before production code.
- [ ] Intercept only agent.startFailed in the scoped host sender, retain/retry its report directly on later passes, terminally drop NOT_FOUND/accepted reports, prune state alongside feed rows, and use fixed diagnostics. Commit implementation.
- [ ] Run machines/start/host/cloneTrust affected tests and typecheck; record red/green and same-workload request reduction (including retries at cap), update plan and push.
- [ ] Add evidence comment, mark ready, record exact head through work.status; keep stable during review/CI. Record done only after required reviews/tests pass.
