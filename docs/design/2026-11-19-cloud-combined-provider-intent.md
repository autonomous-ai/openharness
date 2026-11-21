# Synchronous provider save plus publication intent

Implemented after review, with actual-caller RED then source/fault checks. No new timing was run. The prior
write-crash-map-v2 remains authoritative for unchanged paths. The separate allocation model has passed its
untimed constructor/compatibility controls; allocation arms and any product memory budget remain unapproved.

## Cause and narrow opportunity

`service.touched` and `rename` call `save()` then `publish()`. `save` captures the whole provider cohort (restoring
all optimistic overlays) and atomically writes it with the current publication state. When the output owner is
idle/connected and a changed publication starts immediately, the same synchronous call stack next writes that
same provider cohort with the new pending intent before its first await. That is a real duplicate full-file write.

The source profile attributes connected work to full state serialization/write, owner fingerprints and journal
checksums. The frozen cost selection still has 48 provider saves plus 64 intent writes =112 state-file writes.
There is no ACK write to remove. The proposed correction targets only adjacent synchronous saves whose intent
actually succeeds; it retains the full bounded journal and existing provider file/schema/atomic rename writer.

## Concrete minimal component-only change

A small `canStartPublication()` predicate in the existing publication owner reports the necessary synchronous
pump conditions: initialized, connected, not running/recovering/stopped/held/unavailable, and empty queue. This
is not a promise that a write will occur: unchanged rows, invalid rows, quotas or a failing writer can still prevent
it. Its guards should share the pump's existing readiness check rather than diverge.

Have existing `pump -> append -> publish` return a boolean meaning only **a pending intent was successfully
persisted synchronously during this call**. A local stack boolean is set immediately after the existing `persist`
returns, before invoking core.publish. It is returned as a primitive before the async pump can continue. No new
retained journal/cache/counter or protocol is needed; later async writes cannot change a previously returned
primitive. Ask/unask and other existing callers ignore that private return value.

Extract the current provider cohort capture into a pure local helper, preserving optimistic overlays exactly.
Replace only the two adjacent `save(); publish(reservation)` sites with this component-owned helper:

```
if (!publication.canStartPublication()) {
  save()                         // exact old provider durability, before queue mutation
  publish(reservation)
  return
}
const before = publication.state() // bounded fallback accepted/pending captured before any mutation
durable = captureProviderState()   // same existing snapshot, never optimistic provider state
let written = false
try {
  written = publish(reservation)  // can write combined provider+intent, before any core effect/await
} finally {
  if (!written) persist(before)   // same captured provider state, exact prior journal
}
```

`publish` remains synchronous and does not wait for an ACK. Its service wrapper reports false if stopped; early
unchanged/held returns also report false. Returning true requires the actual existing atomic writer's success,
not merely enqueueing, assigning pending, entering pump or calling a callback. Private journal reference still
advances only after the actual writer succeeds. No save is deferred to a queued send, microtask, timer or ACK.
The fallback intentionally uses the captured old state, not a newly assigned pending intent whose write failed.

Capturing `before` still computes one old journal checksum on this fast path. Keeping that bounded CPU cost is
preferable to changing recovery metadata or introducing another journal cache in this slice. This is a write
correction, not a claim to eliminate all connected serialization.

## Crucial slow-path ordering

Do NOT attempt publish first and then save whenever its boolean says false without the idle eligibility guard.
When another ACK or question occupies the pump, that would enqueue new work before its provider save; if that
save failed, a later ACK could publish a state whose provider save never completed. Current code saves before
enqueueing, and this order must remain on every queued/disconnected/unavailable/recovering path.

For the idle fast path, there is no intervening await or reentrant provider operation between eligibility and the
attempt. Snapshot shaping/normalization/admission/card preparation are synchronous. A failure before a successful
intent either throws before queue insertion or puts the existing pump into its named unavailable/held state.
Fallback save therefore completes in the same call stack before return/rethrow, and failed output cannot run
past it. This exact claim needs actual-caller fault and queue tests, not just a helper boolean unit test.

## Crash, failure and atomicity map

D is the old provider cohort, D' its newly observed genuine state; J is the captured current accepted/pending
journal; J' is the next pending intent. The current file format remains `{harnesses,publication}`.

| Point | Required behavior |
| --- | --- |
| Before capture or before any successful writer | Old atomic file remains authoritative, as at the existing provider-save boundary. Provider effect may already have occurred; no automatic replay or rollback is invented. |
| Fast-path pure shaping/admission fails before intent | Persist D'+J synchronously before returning/rethrowing the existing failure. This preserves provider completion even when presentation is invalid/over quota. No core publication occurs. |
| New intent temp write or rename fails | Pump sends nothing and enters its existing named unavailable state. Fallback writes D'+J, using the exact pre-attempt accepted/pending state, never the failed new pending image. |
| Intent failure plus fallback write failure | Prior complete file remains; caller fails and the output failure stays visible. No claim that D' is durable. Provider effect is neither replayed nor rolled back. Retain failure receipt; do not retry a provider action. |
| Combined D'+J' rename succeeds, before core send | Both provider and intent are durable in the same existing file. Crash recovery proves accepted-before-pending against the retained core, or quietly reconstructs from D' if core is empty. |
| Core throws/refuses/times out after successful combined write | Do not perform another provider write. D'+J' already survives. Preserve the existing hold/unavailable state and current-link recovery; no ACK write. |
| Core accepted J' image but ACK lost/component crashes | Exact pending match proves the transition. Lost-ACK+rename cannot duplicate done; accepted-before-pending and same/empty-image precedence are unchanged. |
| ACK succeeds | Memory advances as today, no disk write. Later ordinary save or intent carries the advanced state. |
| Another owner is optimistic during capture | Its prior genuine state from `optimistic` is copied into D'. Presentation may show optimistic working, but no stored provider state does. |
| Queue/earlier ACK/question occupies output | Original save(D'+J) runs BEFORE append. If save fails, no new queued action is admitted. Later intent persists that last captured cohort as before. |
| Disconnected/unavailable/held/recovering/stopped | Original save-first path. Existing publication refusal/no-op/queue/reconnect behavior follows; no new retry, restart or clearing accepted rows. |
| No changed presentation (same rename, provider-only remote metadata) | Idle attempt reports no persisted intent; fallback writes D'+J once. Metadata survives even without public output. |
| Exact old same-image nonempty reconnect | Existing proven-image shortcut and zero-write behavior remain unchanged; reconnect is not a saveAndPublish caller. |
| Missing/corrupt/unmatched journal or unknown provider state | Existing visible hold and explicit operator restart recovery stay unchanged. This correction never clears or invents journal proof. |

The existing writer is temp-file write plus atomic rename, not fsync; this design preserves process-crash claims
and adds no power-loss guarantee. Journal version/provider sessions/whole-cohort rollback remain unchanged.
Reservations, row/image bounds, 64-action/6-MiB output budget and 10-second publication deadline remain unchanged.
Question-before-row ordering and current physical-link fences remain untouched.

## Workload implications: do not promise 48 fewer writes

The final-v3 workload calls `cycle = deliver; complete` and waits for full settle only after each whole cycle.
The fake provider send/poll resolve immediately. Deliver's optimistic intent is still awaiting IPC ACK when its
provider save occurs. Deliver waits for the second working publication to be **sent**, then completion runs in
that continuation before its ACK is received. Consequently both provider saves inside each cycle remain on the
save-first queued path. Each of the16 renames runs after full settle and can take the combined fast path.

Source-derived expectation for this exact workload, to confirm with real-service RED/GREEN counts:

- 16 optimistic sends:16 intent writes, unchanged.
- 16 post-send provider states +16 completion states:32 provider saves +32 later intents, unchanged.
- 16 settled renames:16 combined writes instead of32.
- Connected total:96 writes instead of112, still64 publications and exactly the same80 app/112 commander frames,
  32 cards/16 done notices and16 rename request/result envelopes. No barrier is added to improve these numbers.
- Eight unchanged reconnects:0 writes; disconnected completion:1 provider save; missed recovery:1 intent;
  ten retention reconnects:0 writes, unchanged.

For the frozen fixtures, all settled rename cohorts and accepted images have equal-width strings and fixed counts.
Using recorded final provider bytes and exact existing journal shape, removing these16 standalone rename saves
predicts 2,898,371 ->2,550,707 state bytes at16owners and286,320,323 ->251,935,667 bytes at1600owners. These are
source-derived write-byte predictions, NOT observations or a latency/CPU acceptance result. The connected cost
will remain materially above original even if this succeeds; any further change needs its own causal proof.

Real provider operations that finish after the preceding output has fully settled can additionally combine
completion/post-send writes. That benefit is workload-dependent and must not be credited to the frozen immediate
provider workload without evidence.

## Required REDs and verification before runtime acceptance

Actual startCloudService plus real createCloudAgents dispatcher/rows, with synthetic private storage:

1. Idle changed rename and a settled provider completion perform one atomic state write, whose file contains
   both new provider state and valid pending metadata before the publish door is invoked.
2. Held prior publication ACK, held ask/unask, disconnected/unavailable states keep provider save BEFORE append;
   injected provider-save failure leaves no new action that later ACK can flush. Do not change public order.
3. Pending-intent write and rename faults leave core unchanged but persist the new provider state with exactly
   the pre-attempt accepted/pending journal; restart reconstructs the saved completion once. Both-write failure
   retains the old file and visible failure without replaying the provider effect.
4. Unchanged rename/provider-only metadata still saves once. Invalid/over-cap publication after genuine provider
   effect retains that provider state even when its output is held. No extra reservation or bound increase.
5. Optimistic-state crash controls, retained/core/component restart, accepted/pending/same/empty ambiguity,
   lost-ACK+rename, old physical ACK and real close-before-reply all remain passing.
6. One source functional counter control mirrors the frozen immediate-provider cycle/rename ordering, including
   held IPC-like ACK boundaries, and proves96 vs112 before any new cost fixture is prepared.

Scope is service.ts/publication.ts plus actual-caller tests and this Design only. Parent reviewed the full
138-line runtime diff after RED/implementation and found no blocking issue. Original/intermediate cost packets
remain intact; native validation and the connected acceptance hold remain open until matched evidence is reviewed.

## Design (docs/feature-design-rules.md)

Reviewed revision: synchronous idle-only provider/intent combination, 2026-11-19. Reviewer: parent agent.
All runtime work is restricted to the reviewed component helper; broader serialization/schema changes are excluded.

1. Growth: unchanged provider entries and bounded accepted/pending journal; no new record, cache, counter, file or
   queue. Existing create/update/finish/stop/restart/delete lifetimes apply. The local boolean and fallback snapshot
   leave scope synchronously. Core state does not change.
2. Concurrency: one synchronous writer and existing per-agent provider queue; output serializes by its existing
   pump. Eligibility and attempted combined write have no intervening await. Every slow path saves before append.
   Exact journal snapshot and optimistic-state overlay preserve the existing whole-cohort invariants.
3. Read cost: no public query, row or removal path changes. Existing full provider/journal read/write remains;
   actual-caller tests count writes and inspect saved bytes before publication. Frozen 16/1600-owner source cost
   packets are the baseline; no new measured performance result is claimed yet.
4. Scale: existing192KiB row,6,287,360-byte image,64-action/6MiB queue and reservation limits refuse growth. Ten
   times the1600-owner example can exceed those existing limits and stays refused; none is raised. State write
   count/bytes, core/component CPU and retained heap are the warning metrics in the matched cost fixture. The
   current regression prompted this review; acceptance remains held until correction evidence.
5. Compatibility: unchanged wire fields, public frame ordering and saved provider/journal schema. Existing readers
   are service startup (provider reconstruction), publication journalIn/connect (checksum and accepted/pending
   recovery), provider-state write wrapper, cloud_agents status, and whole-cohort prior-release rollback. All see
   the same complete atomic document, with one redundant intermediate document omitted on the idle fast path.
6. Migration/rollback: no data migration, new field or state. Existing version1 journal and provider session fields
   remain readable; rollback is the existing whole cohort. Production-data restore is N/A because no encoding or
   schema conversion occurs; synthetic exact-byte and restart controls prove the unchanged contract without
   accessing a real user's Cloud state.
7. Audience: no new audience or exposed data. Existing owner-only service requests, current service authority,
   bounded prepared replies and local saved-file permissions remain. Tests use synthetic private homes/data;
   no provider/question text or identifiers are added to runtime logs.
8. Identity: no provider invocation or credential path changes. Existing Cloud adapter calls keep their connection
   bridge identity; the correction only changes the synchronous storage of already authorized results and never
   retries a provider effect under another account.
9. Failure: failed intent still sends nothing and names unavailable/held state. Exact old-journal fallback preserves
   provider completion; failed fallback reports failure and retains the prior atomic file. Queue, quota, offline,
   current-link, restart and corrupt-state recovery are detailed above; no automatic retry/restart is introduced.
10. Platforms: TypeScript component behavior affects macOS/Linux/Windows. Source/fault tests run on this Mac with
    pinned Node24.22.2. Windows execution is explicitly deferred by the user; mobile is outside this task. Parent
    integration owns combined/native validation before shipping.

## Checkpoint evidence

- Base `c87fe6377bbdb878a21fec4a109518965581b062`; pinned Node24.22.2 and unchanged dependency tree.
- Actual-caller RED receipt `20261118T174743.689634Z-48018`: all three intended failures before runtime edits.
  Idle rename and settled completion each wrote twice instead of once; the held-ACK cycle plus settled rename
  wrote seven times instead of six. Existing unrelated cases were not run for that RED.
- Source gate `20261118T175403.606349Z-54893`:112 tests across service, publication queue/recovery, cards and
  responses passed; publication.ts100% statements/branches/functions/lines (256/170/37/155); CLI types passed.
  Controls inspect the atomic file before the actual core publish, both intent-write and atomic-rename failure
  fallbacks, exact prior journal, retained-core restart delivery, both-write failure, queued-save failure,
  disconnected/unavailable output, unchanged rename and invalid-presentation provider preservation.
- Final incremental receipt `20261118T175620.707614Z-57399`: the three added held ask/unask and provider-only
  metadata controls passed, plus final CLI types. Runtime was unchanged, so the112-case gate and coverage above
  are reused. Combined source evidence covers115 unique cases; no broad rerun solely to refresh a receipt.
- Existing queue tests retain bounds, exact row/card/question/deletion order, old-connection ACK rejection,
  accepted-before-pending, same/empty image ambiguity and malformed-batch controls. Existing real-service
  optimistic crash, lost-ACK+rename, question restart and close-before-reply controls pass in the selected gate.
- Parent independently reviewed the complete138-line two-file runtime diff. No core source, public wire,
  provider schema, journal version, write mechanism or durability boundary changed. Diff whitespace check passed.
- The six-write actual-caller control proves the per-cycle count that yields96 for the frozen16-cycle workload.
  The 112→96 whole-workload count and byte savings above still await the matched fixture; latency/core-component
  CPU/native acceptance remain open. No performance packet was overwritten and no new cost run was started.
