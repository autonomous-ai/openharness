# Other-engine runtime and controls

This is package 5, step 2. It moves the fourteen engines' pane/config/profile readers, screens,
and question navigation to the existing `engine-others` process. The unreachable other-engine
model drivers are removed; their supported public behavior remains view-only. History/live extraction is
already present. Purge/export and setup/install/probe are separate work and remain outside this change.

## Design

- Ownership: core retains session bindings, accepted profile state, profile transactions, question
  selection, input ordering and the existing revocable control grants. The worker receives captured
  values and returns bounded observations or requests a bounded step through an existing grant. It
  never receives a pane locator, registry, input lease, arbitrary command runner or account identity.
- Protocol: extend the existing snapshot, runtime and control transports to route the fourteen engines
  to `engine-others`. Only other-engine requests add an explicit engine discriminator; Claude/Codex
  v1 messages retain their exact shape. Other-engine worker capability 3 enables these operations.
  Capability 1/2 masters and explicit inline mode use the same implementations via `services/inline.ts`
  until 2026-12-15. A failed v3 worker never triggers inline loading.
- Accepted state: live `ProfileEvidence`, pane/config observations and control confirmations share the
  existing `RuntimeSessions` view for each captured binding. Evidence synchronously changes its revision;
  queued or in-flight older reads cannot overwrite that revision. OpenClaw workspace evidence is retained
  on this same view. An explicit `observed: false` fact on pane/config replies preserves ignored screens
  and config warmups: they do not install state, advance revision, or invalidate pending captures. It is
  absent from existing Claude/Codex replies. No second profile cache or engine-specific authority table is added to core.
  The same View retains a separate profile identity containing every binding field except identityHold
  and evidenceRevision. Parent bundled SIGKILL behavior retains accepted display evidence while that
  exact engine, native conversation, process, transcript, route and profile home remain bound. On a full
  authority identity transition with the same profile identity, revision and authority both increase,
  the control clears, and only accepted state/selection/workspace survive. Captured old-row callers and
  queued/in-flight reads still require the full current identity. A hold/release cycle never revives old
  closures; a changed native binding discards the View. The display identity never authorizes a write.
- Navigation: the existing generic question grant broker serves the worker. Core authorizes one
  captured session and approved target/answer; each write checks grant lifetime, connection generation,
  binding and the ordered writer. The worker cannot choose another session or revive a cancelled grant.
  Other-engine question key navigation moves out of the generic controller. The deliberately disabled
  other-engine model drivers and their unused parser exports are removed. There are no new model-grant
  actions or capabilities; the existing caller still refuses these switches before input is acquired.
- Growth: no persisted data or new runtime dependency. Existing transports bound queued/in-flight work,
  request/reply bytes and deadlines. Worker profile readers retain only bounded active-session entries;
  eviction/disconnect drops derived targets and does not erase core's accepted state. The shared worker's
  aggregate admission applies across all fourteen engines, rather than multiplying limits fourteen times.
  Runtime calls: 2 active, 1 MiB request/reply, 512 evidence records, 5 s deadline; the existing core runtime
  queue retains at most 256 reservations per worker service across its engines. Screens: 8 active, 64 FIFO queued, 256 KiB capture,
  1 MiB reply, 1 s total deadline. Questions: 16 active steps, 128 writes per grant, 30 s step deadline,
  5 s host query deadline, 99 rows and 32 KiB approved text. Worker profile-reader targets retain at most
  512 session entries across all fourteen engines, evicted using each reader's existing forget operation.
  Cursor's synthetic footer targets also have a 128-entry / 64 KiB per-session cap (32 MiB across the
  worker's 512 sessions); an evicted target is reconstructed from the next observed footer. The bound
  does not enable model catalogs or controls, and unchanged golden observations verify reconstruction.
  These limits are independent of pre-existing history (16 aggregate reads) and live stream admission;
  their existing 128 MiB outbox and supervisor memory limits remain in force.
- Concurrency: binding/revision checks fence asynchronous observations. Control grants already fence
  connection generation, deadlines and active operation; admission remains held until revoked work can no
  longer issue writes. Stop does not await an unavailable worker. Failure never changes a newer session.
  The shared model/question control binding also captures registry identity holds and evidence revision.
  A hold, revised evidence, or hold/release cycle revokes delayed host writes; bookkeeping observations
  such as touchedAt do not. This extends the existing captured scalar identity, without new authority state.
- Read cost and scale: use existing snapshot requests and incremental live evidence; no polling of whole
  state or new core timers. Existing profile catalog TTLs remain worker-owned. At 10x load, bounded
  admission reports named busy/unavailable outcomes before queue or session caches grow without bound.
- Compatibility: public request types, runtime-v1 profile IDs, client behavior and stored state are unchanged.
  The baseline currently exposes no native other-engine model catalog/control through `runtimeFor`; this
  will be proven through caller-visible tests, and extraction will not enable previously unavailable
  behavior. Existing golden fixtures remain unchanged. Backend-first rollout is N/A because this is the
  local private worker protocol, capability-gated beside the old version; last-30-day clients still use
  the unchanged public protocol. Rollback reverts this extraction; no data migration is needed.
- Audience and identity: only authenticated local core service calls may invoke these private methods.
  Client-connected or non-owner requests fail. Worker reads use the registered session's captured paths
  and the same login as the daemon; the machine owner's login is never substituted for delegated work.
- Failure: malformed/oversized/stale replies produce fixed named codes without pane text, paths, tokens or
  parser exception content. Unavailable profile/screen reads provide no evidence. Model/question results
  distinguish refusal from potentially dispatched input using existing failure state. Killed/frozen/restarted
  worker tests prove terminal input and Stop remain available and late replies cannot regain authority.
  An unavailable terminal capture cannot prove that a question was submitted, even after a possibly
  dispatched write. Existing unsupported lowercase terminal hints retain their refusal behavior; this
  extraction does not expand the generic terminal writer's supported keys.
- Platforms: runtime behavior affects macOS, Linux and Windows. No new spawning mechanism is introduced;
  existing catalog subprocess readers keep their bounded launch behavior in the worker. Local validation
  uses Node 24.22.2 on macOS, temporary homes and private tmux fixtures. Linux/Windows execution must be
  reported separately and must not be claimed from macOS tests.

## Touchpoints and verification

Existing transport/protocol modules: `core/engines/{snapshotTransport,runtimeTransport,runtimeSessions,
runtimeProfiles,controlTransport,modelControls,questionControls}.ts`, `engines/worker/{runtimeProtocol,
runtimeRequests,screenRequests,questionControlRequests}.ts`. Worker composition: `engines/others/otherEnginesProcess.ts` and worker-owned
runtime/control adapters. Composition and compatibility: `core/main.ts`, `services/inline.ts`,
`harnessd/services.ts`. Core consumers: `lib/{runtimeProfileState,runtimeControl,questionController}.ts`.

Before implementation, add red behavioral tests through real ports for other-engine routing, private
request rejection, profile evidence versus stale pane/config replies, worker failure/restart, and
model/question grant revocation. Keep all fourteen transcript and screen goldens unchanged. Run the
scoped tests/typecheck and architecture/lean closure checks first. Record actual default and warmed
closures; purge/export still reaches `engines/inProcess.ts`, so this step does not claim that door is gone.
After final source is committed, run affected official 100%-per-file gates using the checked-in local
validation runner and record their real receipts. Root reserves machine capacity before broad checks.

Profile before optimizing. Root reserves a quiet machine window for matched before/after workload
latency, CPU and memory measurements on the same Node version, private home and fixture. Keep a failing
measurement visible; do not replace it with an unrelated faster workload. Root owns independent review,
publication, integration and merge.

## Profile-backed getter correction

The fixed six-run ten-agent comparison measured profile-phase core CPU at 0.77/0.77/0.68 s on the
parent and 0.83/0.83/0.84 s on the candidate. This regression is the optimization's red evidence.
Exact-phase diagnostic sampling attributes new work to repeated binding serialization in the
selected-model and workspace getters: each compares the live registry object to itself, then
`byId`/`valid` serializes that same current binding again to check the accepted View.

Within one synchronous getter call, compare the caller object with the freshly resolved registry
object first. The same object cannot have a different binding from itself during that comparison.
A copied caller still requires the full existing binding comparison. In both cases `byId`/`valid`
remains unchanged and independently compares the current full identity against the saved View on
every call. No identity is retained between calls, no binding field is removed, and the display
identity never gains authority. Native/route mutations on the same object and old copied callers
remain covered, as do the existing hold/evidence-revision, ABA and delayed-control tests.

Growth, storage, migration, audience, platform and failure contracts are unchanged; this adds no
cache, timer, process, protocol or dependency. The getter guard tests are preservation coverage;
an unsafe shortcut is a mutation check, not a pre-fix production failure. After scoped checks and
bundled acceptance, repeat the same fixed comparison under a newly reserved quiet interval.

The corrected comparison still measured a profile CPU regression (median 0.75 to 0.81 s) and two
idle readings above 1%. Further phase profiles attribute 19 ms to the remaining nested binding
serialization. Count-only diagnostics found equal native captures: 220 in 22 clients at idle and
140 in 14 clients during the profile phase. Capability negotiation does not repeat in either phase.
One additional existing inventory tick falls inside the candidate's profile window; that timing
difference is retained in the evidence, not treated as duplicated capture work.

Replace the View's serialized identity with one immutable record of the same scalar fields and the
same processIdentityKey. Keep freshly serialized runtime routes for every comparison, preserving
all route fields, property order, extra properties and in-place mutations. Optional scalar null and
undefined remain equivalent where the original JSON array made them so; evidenceRevision retains
its separate absent/present meaning. The held flag retains its existing truthiness semantics.
Remove the duplicate profile identity: display retention compares this one record while ignoring
only the held flag and evidence revision. Full identity transitions still replace the record and
increment revision and authority before waking callers. Pending reads retain the old immutable
record and existing counters. There is no mutable registry alias, result cache or new authority map.

Parity tests precede the representation change and cover every field, copied callers, process start
semantics and exact route JSON behavior. Existing hold/ABA and delayed-control guards remain required.
All other Design contracts above remain unchanged. Failed cost comparisons and diagnostic counts
remain visible; a new fixed comparison is scheduled only after validation and review.

## Validation and remaining cost

The final measured source is `50546fe63e35e33bc05d52bb35afd4161d508188`; its CLI bundle SHA256 is
`930ad93a278b8d2d660e77963606b6c6790a9357483f218d79658dafc85151cd`. The parent is `5cbb378db0`,
bundle SHA256 `2edd751c1c4ca618a0fc4421ef9ce01cdfb8da2f87e336026a56c3b5e833adf8`. Both ran the same
unchanged `cli/e2e/otherRuntimeControls.e2e.ts` workload on Node 24.22.2/macOS: ten private Cursor
agents, 30 s idle, twenty actual Low/High footer observations in two batches, ten approved Tab
answers confirmed by exact terminal bytes, and the existing unsupported-model refusal.

All six fixed runs passed, in order candidate1,parent1 / parent2,candidate2 / candidate3,parent3.
The profile-phase CPU deltas remain positive in every pair:

| Pair | Parent core CPU | Candidate core CPU | Delta |
| --- | ---: | ---: | ---: |
| 1 | 0.74 s | 0.77 s | +0.03 s |
| 2 | 0.74 s | 0.81 s | +0.07 s |
| 3 | 0.75 s | 0.77 s | +0.02 s |

Median profile CPU is 0.74 to 0.77 s (+4.1%). Idle CPU readings are 1.100/1.033/1.100% for the
parent and 1.000/1.033/1.033% for the candidate: every parent run and two candidate runs exceed the
1% limit; the first candidate value rounds to the limit. Median answer p95 is 1234.867 to 1232.124 ms.
Native poll alignment affects observation latency and the number of existing inventory ticks inside
a profile window; the operation-count diagnostic is retained separately. These facts do not establish
performance acceptance or erase the positive CPU deltas. Earlier failed comparisons are also retained.

At the measured source, 182 focused tests passed with runtimeSessions at 100% per-file coverage;
typecheck, all 16 frozen runtime golden cases (482 unchanged hashes), and all eight unchanged bundled
acceptance cases passed. Acceptance includes absent/stalled core reader chunks, killed/frozen workers,
terminal/Stop isolation with the same frozen PID, lowercase-hint refusal, and inline/protocol1/2
compatibility. Linux and Windows execution is not claimed. Current-main integration, required
integrated-head gates/CI, and explicit disposition of the remaining cost are still outstanding; this
evidence does not declare the extraction step complete.


## Integrated CI fixture correction, 16 November

The integrated core and harnessd coverage gates passed (4,630 core cases and 370 harnessd cases,
one existing skip, both 100% per file), as did ten bundled control/repair acceptance cases.
Linux unit CI then exposed two stale test contracts: a failed screen capture was still expected to
mean the question disappeared, and the worker composition assertion omitted its new connection hook.
Both failures reproduced locally before correcting the fixtures (71 passed, two failed). The revised
73 cases pass: unavailable capture types nothing, reports ANSWER_FAILED, and the same question can
be answered after a readable capture. The authenticated worker assertion retains all fields and
includes both connection hooks. Production behavior and golden files are unchanged by this correction.
Final-head receipts and CI remain required; the measured CPU cost above remains unaccepted.
