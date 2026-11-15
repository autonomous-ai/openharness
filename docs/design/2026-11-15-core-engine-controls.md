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
