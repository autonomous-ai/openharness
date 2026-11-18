# Cloud card transitions belong to the Cloud component

## Design

The Cloud service already renders the last answer. Move its transition policy and
last-notified-answer map out of `core/agents/cloud.ts` too. The existing private
Cloud publication carries the complete harness list and zero or one prepared card
per harness in the same message. Core validates that every card belongs to a
published Cloud harness before forwarding it; terminal/session ownership and
question answer authority remain unchanged. No new process, broker, listener or
core-side feature cache is introduced.

The component suppresses old answers on its first publication, emits working
cards for busy harnesses, and preserves the existing working/done/error/summary
transitions thereafter. A reconnect republishes working cards so a replacement
core can restore existing observers. A surviving core can receive the same
working card again; these cards have no completion notification and overwrite the
same tile. Completion summaries are never replayed merely by reconnecting.

Growth: the component retains one busy bit and notified-answer string per Cloud
harness, deleting both when that harness disappears. Core loses its separate
notified-answer map. Existing Cloud list growth is unchanged; this increment does
not establish a bound for the persistent Cloud catalogue. Each publication has at
most one card per row and remains subject to the existing private IPC frame bound.

Concurrency: publication and card calculation are synchronous in the Cloud
component, and list/card admission and emission are synchronous in core. There is
no await between selecting a published owner and emitting its card. Existing
per-harness service queues and question-before-list ordering remain in force.

Read cost: no filesystem or network read is added. Only transitions produce cards in the component; no extra timer or polling loop is added. Measure the same fixed
publication workload before/after at current and 10x row counts, including IPC
bytes and core/worker CPU separately. Catalogue growth remains a separate limit.

Compatibility: this is private worker protocol under the already-unreleased
contract 3 cohort. Contract 2 cohorts run their original complete implementation;
the supervisor reaps workers before changing cohorts. Public app frames, stored
Cloud data and the last 30 days of client contracts are unchanged. The service
still computes cards for legacy stored rows before publication. Removing core's
pre-13-November missing-card renderer does not change whole-build rollback.

Migration/rollback: no stored format changes or migration. Roll back the complete
cohort; never mix private worker implementations. Audience: only the authenticated
Cloud service can publish, and a card can name only a Cloud row in that publication.
Identity: no login or launch authority moves. Failure: malformed card batches are
refused with a fixed log code, without content; an unavailable Cloud process costs
its cards, not terminal agents. Platforms: portable TypeScript on macOS/Linux;
Windows execution is deferred by the owner.

## Validation selected before implementation

First reproduce the missing component-owned transitions and core synthesis on
the current code. Cover every prior transition, unchanged rows, stopped/deleted
rows, reconnect and initial suppression; reject mismatched, duplicate, oversized
or malformed card batches before emitting any part. Run affected Cloud service,
process adapter, query and core suites with 100% changed-core/service coverage,
architecture and types. Run the existing packaged Cloud flow once on the combined
build; use its fake adapters and private daemon state. Independent review and
matched publication costs remain required before acceptance.

Question construction, Cloud agent-list presentation and other feature routes
remain explicit residuals; moving transitions alone does not finish all extraction.

## Source checkpoint

The original code fails both behavioral REDs: the real Cloud service supplies no
prepared card, and core synthesizes cards when no component card was supplied
(`/tmp/core-cloud-cards-red-20261118.log`, two failures). The first combined run
exposed two private publication-shape changes from normalizing the transmitted
rows; those original row bytes and cached rendered-card identity are restored,
while transition calculation uses the same normalized owner projection as core.
The existing query test now asserts the additional private card argument.

All 77 selected cases pass. The first scoped coverage collection exits 1 because
it omits the existing Messages link caller of the shared refusal logger; all three
other selected files reach 100%. The final selected collection includes that
caller. Types pass. Packaged checks, cost measurement and independent review are
still outstanding; this source checkpoint is not release acceptance.

The final fixed-source receipt `20261118T051021.783039Z-35208` exits 0: 130 cases
across nine suites, architecture included, and types. All four selected runtime
files have 100% statements, branches, functions and lines (334/332/149/255).

## Independent review hold

This candidate is not integrated. Independent review reproduced a lost completion
when the service link drops, its provider finishes, and the same core receives the
reconnected idle publication. The previous implementation emits the completion;
this candidate clears component history and emits none. The actual red receipt is
`/tmp/core-cloud-cards-independent-delivery-red.log` (baseline control passes,
candidate fails). A simple whole-row replay fence is insufficient: a rename after
a lost acknowledgment changes the row without making its completion new. A
replacement component also loses memory-only transition history. Reliable
publication must be designed and checked before this extraction can ship.

The existing packaged Devin flow is prepared to observe negotiated session cards,
verify one completion, kill only its verified Cloud child, and check that the core
survives without repeating that completion. No packaged execution has occurred.
Fixture types pass in `20261118T053949.693304Z-81640`; the earlier type attempt
failed on optional frame payloads, an existing private fixture field, and an
incorrect DOM library selection. Those fixture issues are corrected; that failed
receipt remains recorded. These prepared tests do not resolve the delivery hold.

## Design: final connection authority

Cloud queries currently pass the service link's connection check before main's
asynchronous dispatch. A replacement can revoke that connection during an
earlier handler's await. Pass the existing ServiceQueryAuthority to the Cloud
query handler and check it immediately before any effect. A missing authority,
or one that is stale or cannot prove current ownership, receives SERVICE_UNAVAILABLE.
The inline Cloud doors remain direct calls and retain their existing authority.

This adds no state, cache, stored data, wire field, protocol version or public
client change. The existing service link still owns revocation and logs its
connection changes. Concurrency is checked at the final synchronous effect;
growth, migration and identity are unchanged. Read cost is one current-connection
predicate per Cloud query. Platforms are portable TypeScript; Windows execution
remains deferred. The same cause is tested through real service-link replacement
for publication, question open and question close, with a current-connection
control. This independent authority correction does not resolve reliable card
publication and must remain a separate checkpoint.

The original six authority cases fail before the guard, and the three explicit
missing-authority cases fail before removing the implicit bypass. The final
receipt `20261118T060711.647739Z-11914` passes types and 114 tests across six
suites, including real service-link replacement, current controls and the
architecture check. `experimentQueries.ts` reaches 100% statements, branches,
functions and lines (77/93/12/58). The earlier optional-authority version also
passed its narrower gate; that receipt does not cover the final fail-closed form.

# Design: reliable component publication (approved 2026-11-18)

## Constraint proved by review

The current core has two pieces of accepted history: the published Cloud owner rows and the last notified answer. Moving only the latter into volatile component memory loses a completion on link loss or component restart. A whole-row changed check cannot distinguish a completed answer already emitted from the same answer renamed later. Replaying every completion also changes the old replacement-core rule: initial history must remain quiet.

The existing service query protocol supplies neither a reconnect-stable publication receipt nor a query deadline. No existing generic API can be claimed to provide these semantics.

## Proposed authority boundary

Keep no new receipt, revision, dedup map or outbox in core. The core continues to hold only the existing accepted Cloud owner rows. Add an explicit readback of their canonical fingerprint to the existing private Cloud door; it returns no user content. `publish` returns admitted/refused instead of the current false success `{}`. Card admission remains atomic before row mutation, and each changed row's frame/card is emitted together before removed rows, preserving the original order.

The Cloud component owns its transition checkpoint and a bounded write-ahead publication journal. There is only one publication sent without an acknowledgment. Before sending it, persist its predecessor fingerprint, row delta and next transition checkpoint with the existing provider state. The next public image is reconstructed from the saved accepted image plus that one delta. On an acknowledgment, advance memory; no immediate extra disk write is needed because the saved in-flight record can prove the same result after a crash. The following provider-state save folds that acknowledgment into the next checkpoint.

On reconnect or component restart, read back the core's existing image fingerprint:

* It matches the saved predecessor: the in-flight publication was not accepted. Reconstruct the current desired image from provider state and compute the missed transition from the predecessor checkpoint.
* It matches the saved in-flight image: adopt the in-flight transition checkpoint without emitting its card again, then compute the current desired image. A rename after a lost acknowledgment therefore cannot repeat a completion.
* It is the empty image: this is initial state or a replacement core. Start the component checkpoint empty and publish current busy cards only; old completions stay quiet, as before.
* It matches neither: refuse with a fixed named error; do not guess at delivered history or replay summaries. This case requires explicit recovery/design handling before implementation can be called complete.

A conditional core write may be unnecessary after final-effect fencing: serviceLinks accepts exactly one current connection for a service, rejects old-connection frames, and Cloud publication is synchronous in the core. However, current main.answer awaits other handlers before answerExperimentQuery, and that function receives no final ServiceQueryAuthority check. The old-connection admission check alone is insufficient. The Cloud read/publish/ask/unask effect must check authority.current immediately before acting, after those awaits. The component must also capture/revoke the actual connection generation; readback and the next publication use that same connection. Tests must hold an old query through connection replacement and prove no old effect. If a residual read/write interleave is possible after these fences, an expected-fingerprint guard is required in the existing publication door; it still derives from the current rows and retains no new core state.

## Boundedness and source ordering

Normal connected output cannot be coalesced arbitrarily: a withheld acknowledgment can span multiple working/done transitions. The component needs a bounded ordered queue of row deltas, not 64 whole catalogues. An upper bound of 64 queued output actions and 6 MiB total serialized queued data fits within the current authenticated service transport ceiling (6 MiB + 4 KiB). One accepted catalogue and one active wire image are additional constant-size copies, each subject to the existing transport ceiling; existing provider catalogue growth remains a separate residual.

Question ask/close actions must share the output order so a delayed publication does not let a later question overtake an earlier row. On reconnect, queued unsent intermediate history is replaced by the current provider snapshot and current questions, as the old implementation republishes current state after a lost link. During a healthy connection every queued transition is retained in order.

Admission must reserve the bounded output capacity before a provider operation or state mutation that cannot be undone. Otherwise a full queue after the provider accepted a command could orphan it. This adds component backpressure and an explicit busy result; it cannot be disguised as a behavior-neutral implementation detail. A suspended output owner keeps its reservation until acknowledged or reconciled, with a bounded request deadline and named unavailable state. After one failed or timed-out output call, hold further sends until a physical reconnection. Retrying the user request does not retry uncertain output. If the connection stays unavailable, the existing explicit `harness start --restart` action provides a new connection and empty core authority.

Optimistic `deliver` working state is currently published but not saved before the provider accepts the words. Persisting it as provider state would change crash semantics. Its publication record must be separate from the provider snapshot; after a component crash, an unapplied optimistic record is discarded, while an already-applied one informs the checkpoint before the actual saved state is republished.

## Data checklist

Growth: one accepted presentation image, one in-flight delta, at most 64 queued actions / 6 MiB; removed owners leave the transition map. No new core state. Existing unbounded Cloud provider catalogue is not solved here.
Concurrency: one component output publisher, one physical connection generation, atomic synchronous core admission. Provider work stays outside core; reservations/backpressure must not create unbounded waiting closures.
Read cost: fingerprint the existing core map only during recovery, not every normal publication. All transition calculation and journal I/O are component work. Measure normal and recovery CPU, RSS, wire bytes and latency separately.
Compatibility: private unreleased contract 3 only; complete older cohorts retain their implementation. Public app cards and stored provider rows keep their format; optional publisher metadata is ignored by old readers. Whole-cohort rollback remains required.
Migration: old state with no publication journal is initial only after a new core starts; a nonempty surviving core with no matching journal cannot be silently trusted. Rollback omits the new metadata, so a subsequent forward upgrade must use a fresh core.
Audience and identity: only the authenticated Cloud service can read/publish its owner map; no login or launch authority moves. No paths, content or identifiers enter diagnostics.
Failure: malformed admission returns failure; lost acknowledgments are reconciled, never assumed; writes failing before send produce no accepted core change. A corrupt/missing journal with nonempty core authority is a visible hold until recovery is explicitly defined.
Platforms: portable TypeScript, macOS first; Windows execution deferred by the owner.

## Required RED and acceptance cases

Retained core / component restart / replacement core; drop before send / apply then lose acknowledgment / rename after lost acknowledgment; crash after state+intent write and before send / after apply and before acknowledgment; optimistic working before provider refusal; multiple owners and same-owner working/done cycles while acknowledgment is delayed; exact row/card/deletion/question order; malformed batch false acknowledgment; queue byte/count saturation before provider effects; stale connection and same-image ABA; actual file/queue/timeout cleanup. Existing packaged flow and matched cost follow only after the design is accepted.


The component-owned bounded journal and ordered admission/backpressure were approved before runtime changes. Explicit operator recovery is required; the implementation must not silently reset uncertain history.

## Implemented recovery shape

The component journal stores accepted and pending presentation checkpoints. Each contains a fingerprint of the
normalized ordered owner image and, per owner, its row fingerprint, busy flag and last-notified text. A checksum covers those checkpoint fields so a damaged but still syntactically valid checkpoint is refused. It does
not duplicate full provider catalogs on disk. A same-image publication must have exactly the same transition
checkpoint because unchanged rows advance nothing. Recovery matches the accepted image before the pending
image; either match has identical state in the same-image case. A verified empty core starts quietly from saved
provider rows, whether the prior pending image was also empty or the daemon was explicitly restarted.

The existing saved `harnesses` array remains unchanged in format; optional `publication` metadata is additive.
Before sending a publication the component atomically renames a new copy of that file containing its pending
checkpoint. A pure optimistic working publication reuses the last durable provider snapshot. Other harnesses'
saves also preserve an in-flight optimistic harness's previous provider state until its provider accepts input.
Healthy output is a single ordered queue shared by rows and questions. Row actions hold deltas; initial recovery
seeds the one active wire image rather than enqueuing a full catalog. The component bounds output to 64 actions
and 6 MiB, reserves six actions and 448 KiB before a provider operation, and reserves image growth too. There is
no admission waiter list. A ten-second output deadline holds further sends until a physical reconnection.
The process callback revokes the component generation on disconnect, and core checks the existing current
service authority immediately before each effect. Every reply is checked again against the component generation.

A nonempty retained core with missing, corrupt or unmatched journal metadata is
`CLOUD_PUBLICATION_RECOVERY_REQUIRED`, exposed by the existing `cloud_agents` status and a content-free log.
Restarting only Cloud does not clear it. The operator recovery is the existing explicit `harness start --restart` command: a verified empty core then reconstructs presentation quietly from intact saved provider
sessions. The component never restarts core automatically, deletes provider sessions, or guesses which completion
was delivered. A corrupt provider state file remains unavailable; presentation recovery does not erase it.

Normalized owner rows are bounded before entering the ordered queue. Public application frames retain the same
core normalization and card format. This private cohort now carries that normalized projection on its local
publication door; render-cache card objects are retained where their normalized value is unchanged. Whole-cohort
rollback remains required, including provider-file metadata being ignored by older readers.


Private owner batches are admitted whole: a non-list, malformed row or duplicate normalized owner ID is
`CLOUD_PUBLICATION_INVALID` before any accepted row or client output changes. The component enforces the same
rule before preparing a snapshot, so normalization never silently withdraws an invalid provider row. Normalizing
valid fields retains the existing public frames. This is a boundary validation change, with no new core state.
