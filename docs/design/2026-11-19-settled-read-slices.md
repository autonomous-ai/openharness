# Bounded synchronous read slices

## Design (docs/feature-design-rules.md)

Reviewed base: `ae9ec8a816d2bb1b3383e804af09e5de8a83349c`. Status: Design, RED tests and exact two-file runtime patch reviewed by root;
approved focused RED/GREEN complete. This continues the existing Wi-Fi extraction cost correction.
Only `core/questionObservation.ts` and `services/wifiView.ts` runtime change.

### Evidence and callers

The frozen V11 matched comparison still fails performance acceptance: normal 1,600-row Wi-Fi
refresh is 53.513→162.777 ms median wall, 53.560→149.195 ms CPU. No new timing is authorized.
Root's two-arm CPU diagnostic is complete, independently verified and will not be rerun:
`/tmp/core-wifi-snapshot-cost-diagnostic-v11-attribution1-20261119/root-cpu-attribution.json`.
The candidate's 1,487.569 ms sampled occupancy includes 549.815 ms canonical-path/filesystem,
241.157 ms bounded JSON validation, 108.386 ms other transport/consumer and 319.035 ms idle.
These are overlapping-workload samples including waits, not new function CPU measurements.

Exact captured TSX code was read, not reconstructed: candidate script 216 (`source-3.js`, SHA
`fbad594e651f87f12fd2707e3f373177d9d56bb8a74bd5f032a08d9ebb17fb81`) shows a new
`setImmediate(advance)` after every settled frame; script 678 (`source-16.js`, SHA
`b23e133b7f91fa9706450eab2fb57f0e745f6c62abd570b85e5322137c2c9560`) calls JS
`realpathSync` for each registered workspace. Validation is deliberately untouched in this slice.

There are two real pump callers: `startQuestionSnapshot` for BackendSocket's owner-scoped question
observation, and `readSessions` for the declared registered/advertised reads. The latter is consumed
inline and through `answerSessionRead` by Wi-Fi and Devices. Every physical receiver still owns
its send credit and final connection predicate. `localWsServer` returns false on closed/budget/refused/throw paths, and true only after `ws.send`
returns; its callback carries write completion. BackendSocket and serviceLinks propagate that boolean.
The inline view settles only after checked projection and returns true. A contradictory alternate sink
must therefore fail closed instead of treating its early callback as stronger than its refusal.
The view's canonical-path reader is only in the
Wi-Fi component; core workspace-absence/create checks are separate and unchanged.

### Minimal changes

* Use `realpathSync.native(path)` in the component's `canonicalPath`. Null/empty still return null;
  errors still return the exact input path. Every row/read resolves afresh, including duplicate paths
  and changed symlinks. There is no path cache and no fallback to a second JS filesystem walk.
* Keep the immediate begin send and its deferred first continuation. The returned cancel handle
  and the session caller's abort listener therefore exist before any row is visited.
* Each continuation iterates at most 32 source rows or 2 ms of monotonic elapsed time, whichever
  comes first. Filtered rows count too. Check time between complete iterations; an individual
  provider/send remains synchronous and non-preemptible. These bounds are internal scheduling
  limits, not new wire/resource quotas or a promise that one expensive row takes under 2 ms.
* Send each record separately. `send` reports to the loop whether its callback settled successfully
  **during** that call. A sync success never invokes the loop recursively, and the next row is not
  read until the physical send function returns. Async settlement schedules the next continuation
  exactly as before; a held callback stops the loop and retains the sole in-flight physical credit.
* Keep the per-send first-callback guard, but defer its synchronous outcome until `send` returns.
  A false return or throw is transport refusal and overrides a synchronous success callback; no row
  advances and even an end callback cannot commit success before return. After an accepted return,
  repeated callbacks retain the first outcome. Failure ends the read once. Cancellation
  and `current()` are checked before each next/physical send; a reentrant revoke after success but
  before send returns prevents the next row. Closing logical membership does not release credit
  owned by a still-pending physical transport callback.
* Keep one original timeout through physical end settlement; no refresh/retry. The count/time
  boundaries yield through `setImmediate`, letting controls and timeout callbacks run between
  slices. No aggregate frames, schema change, larger limit, trust option, recursion or new state map.

### Design checklist

1. Growth: no persistent/new shared records. Existing iterator/deadline/continuation belong to one
   read; finish/cancel/timeout clear the timer, cancel pending continuation and return the iterator.
   Per-send closure survives only if its physical owner still holds its callback.
2. Concurrency: JS loop is single-owner and iterative. A refused return wins; after an accepted return the first callback owns settlement. One record
   outstanding, same current-owner checks. Begin stays deferred; async callback gets no eager replay.
3. Read cost: same exact frame count/bytes and complete outputs at all nine V11 scenarios, including
   4,097 rows and historical 7,164,627-byte source. No additional load or retained projection. Current
   physical-socket tests and all validation/unknown-input rejection stay selected.
4. Scale: 10× rows continue as finite slices under unchanged membership/byte/deadline bounds, or
   refuse explicitly. Full-refresh wall/CPU, frame bytes/count, maximum control delay and retention
   remain metrics. This removes identified work only; V11 performance HOLD remains until a separately
   approved fixed comparison accepts it. No new per-row production metric or identifying log.
5. Compatibility: no wire/public fields change; worker contract 6/header 2 stay. Question begin/row/end,
   filtering, public legacy adapter, session membership/current facts/parts-last order and end commit
   stay identical. Current physical sockets usually settle asynchronously; their cadence is unchanged.
6. Migration/rollback: no stored data migration or production restore applies. Reverting these two
   runtime changes returns previous scheduling/path implementation with identical records/protocol.
7. Audience: no new recipient/copy/log. BackendSocket's observation predicate and service read grants,
   current physical connection checks, inline machine/account predicate and component commit fences
   remain the authority. No path is put in logs.
8. Identity: no new process/action or credentials. Existing OS process resolves existing workspace
   paths; it grants no create/input authority. Missing machine/session binding still refuses the read.
9. Failure: same fixed unavailable/timeout errors and question close reasons; partial view never
   commits. Native realpath failure preserves previous unresolved-path output. New requests can retry;
   this pump never replays a send. Late callbacks after stop have no logical effect.
10. Platforms: Node native realpath is available on macOS/Linux/Windows. macOS tests use a disposable
    symlink workspace. Windows verification remains explicitly deferred by user; mobile excluded.

### Selected RED and validation plan

Before runtime edits, run newly prepared actual-caller controls against unchanged ae9 runtime:
question synchronous burst/count/time/filter boundaries; physical held sends; after-callback
revocation/cancellation; first-settlement contradictions; readSessions membership/facts changes and
abort within a slice; native realpath use plus symlink replacement/missing/null/empty preservation.
Count/time/realpath use and contradictory send refusal assertions must fail first. Controls may already pass and are labelled as such.

After review, select questionObservation/sessionRead/agentQueries, actual BackendSocket observation,
Wi-Fi view and authenticated process.pipe callers; cover both changed runtime files to 100%, run
architecture and CLI types. Bounded workers only after root's quiet release. No broad repeat, build,
native or timing now. Contract-6 packaged five-case acceptance remains pending independently.


### Focused source evidence

Test/Design commit `5ed3a41795` retains the unchanged ae9 runtime. Receipt
`.harness/validation/20261118T211839.954868Z-68724/receipt.json`: actual exit 1,
14 intended failures / 2 passing controls / 76 skipped. Failures expose the missing native reader,
one-row scheduling and ignored contradictory send refusal in actual question/session callers.
No fixture or environment failure was reclassified as a product RED.

Applied only the reviewed two-file runtime patch (proposal SHA
`f71bc789a2c0c2b12b917baa0590cf7544bc5d83a80a9675a1efb03755fac2e8`). The same 16-case
selection then passed actual exit 0 in 2.4 s, receipt
`.harness/validation/20261118T211859.455665Z-69135/receipt.json`. Its reused plan/check label
remains `settled-read-red`; the receipt's dirty source hash binds the GREEN runtime and the log
records 16 passed / 76 skipped. This label is not evidence of unchanged runtime.

The reviewed final plan is `/tmp/core-wifi-bounded-pump-final-plan-20261119.json`: twelve selected
caller/authority/architecture suites with one Vitest worker, 100% on the two changed runtime files,
and types. It runs from the next clean runtime/evidence checkpoint. Final results are reported
with its source-bound receipt, not inferred here. V11 performance HOLD and contract-6 native
five-case acceptance remain open; no new benchmark, native run or build is part of this gate.
