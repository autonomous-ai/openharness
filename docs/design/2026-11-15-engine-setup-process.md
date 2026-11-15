# Engine setup outside the daemon core

Status: design before implementation. Package 8, step 1 of the
[core audit](2026-11-12-core-audit.md); implements the owner's 2026-11-13 decision 2.

Engine installation, login-shell discovery, Desktop download checks and executable help/version probes currently
run in the core's process. Their subprocesses, caches, installation journals and filesystem enumeration belong to
an optional component. An unavailable component must hold only the launch that needs it; input and unrelated
launches keep working. Native launch identity, cancellation, restore/restart ownership and the last check before
dispatch remain the core's authority.

## Boundary

Add an on-demand supervised `engineSetup` process, separate from the edge host: a blocked filesystem or probe
must not stall unrelated edge services. It starts only when needed, with the existing host/want transport and
`askedSince: 0` convention of engine workers (older cores run inline and never ask). This introduces no setting,
dependency or protocol message. The service owns discovery/probe caches and limits,
the existing installation controllers and their helper processes. It uses the existing authenticated service
transport, request deadlines and supervisor. A worker crash, hang, malformed answer or connection replacement
returns the existing native-launch hold; it never loads an inline implementation as failure recovery.

The core retains the existing native-launch coordinator and immutable executable identity verification. Worker
answers contain bounded data, not closures or commands that the core executes. Capture returns the selected file's
identity and launch location variables. Subsequent probes bind to that identity; the core rejects stale answers and
rechecks the actual file before using a launch. Hook proofs, hook/plugin writes and folder trust remain for package 8
steps 2 and 3. The old launch and hook golden contracts remain authoritative.

The core uses a small typed adapter over `ServiceLinks.call`. There is no new core callback/lease registry,
component-owned cache, timer, journal, retry loop or request table. The service's private calls are not public socket
routes. Existing launch holds and their retry lifecycle continue to report missing setup work.

## Installation authorization

Previously the core prepared a durable installation claim, checked its current launch authority and dispatched the
installer. After extraction the worker prepares the claim and returns an opaque preparation identifier. Preparation
may record an inert reservation; it cannot start an installer or change an engine installation. The core checks its
existing authority immediately before sending commit. **That commit send is the installation authorization point.**

Cancellation before commit never installs, including cancellation during preparation or while its reply is delayed.
Cancellation after commit may allow the authorized installation to finish; it still prevents the agent launch.
The core's final launch authority and executable/hook proof checks are unchanged.

The worker binds commit to the immutable claim, engine, original request, connection generation and unexpired
preparation. It accepts one commit; duplicate or lost acknowledgements reconcile through the existing durable
installation journal rather than reinstall. A replaced worker cannot accept an old preparation. Pending authorization
is bounded and expires; disconnect resolves it as refused. Prepared claims that never receive commit remain inert
and can be settled by the existing cancellation recovery. The existing POSIX outside dispatch witness remains the
once-only authority, including when an installation finishes after its worker is gone.

Windows publishes an old-readable `failed` record with the original request key and an additive opaque `dispatch`
token before spawning its existing hidden helper. Until resolved, the new controller holds both that request and a
new request with a named recovery-needed state. The unresolved record keeps `state: failed` even while running; its additive PID/start fields let the new
controller show progress without letting an older controller replay the original request after the helper dies.
The helper writes those running fields and its final settled result under that same token; losing the parent cannot lose completion. A known spawn refusal or proven installer failure removes
the uncertainty token so the existing explicit retry behavior remains. Finding a binary is never completion.

The actual pre-extraction Windows controller is retained as a dated test fixture. It reads the new pre-dispatch
failed record and refuses the **same saved request** without installing again: `CreationAuthority.id` survives
recovery/rollback. An older binary separately asked for a **new request** still performs its legacy retry of a failed
record. Additive evidence cannot make old code enforce the new all-request hold. This limitation is explicit; no
core rollback machinery or promise of universal old-binary enforcement is introduced. Settled old records retain
their current interpretation. Tests cover both request keys through the actual older implementation, interrupted
publication/dispatch, and helper-owned results after parent replacement.

## Design

- **Growth:** Keep the POSIX 128-record journal and 256 KiB record cap. Do not delete or rewrite existing immutable
  claims. Windows keeps its bounded per-engine records/logs. Pending preparations are capped at eight, expire within
  the service request deadline and are cleared on disconnect. Discovery keeps its existing ten-second environment
  cache; help keeps 32 successful entries for one minute. Probe slots remain capped at eight and belong to actual
  child settlement. No cache or pending state lives in core.
- **Concurrency:** Preserve existing immutable claim, dispatch witness and result publication rules. Bind each
  preparation to one request and service connection generation; a repeated commit cannot cause a second dispatch.
  Different launch requests share discovery/probe results only under their existing immutable executable identity
  keys. Core launch authority is checked before commit and again through normal launch dispatch.
- **Read cost:** Read only the requested engine and its selected executable/installation obligation. No polling or
  whole-state snapshots are introduced. Journal enumeration retains its 128-record bound and yielding budget.
- **Scale:** At ten times concurrent launches, the service's pending/probe caps return named holds instead of growing
  core memory. Existing service timeout/disconnect logs and supervisor RSS/heartbeat state show failure first;
  caller-visible hold/error reports the affected launch. Measure matched launch/probe workloads and independent
  core request latency before/after; report actual results outside the final source commit.
- **Compatibility:** No backend or public client contract changes; clients from the last 30 days keep existing
  launch status/error behavior. A current master advertises `engineSetup` through its existing service list. A core
  running under a master predating this service keeps the implementation only behind the existing explicit
  `services/inline.ts` compatibility door, never as a response to worker failure. Remove that older-master exception
  after **2026-12-15**, once the 30-day compatibility window has passed. Existing explicit `HARNESSD_SERVICES=none`
  and no-master/HarnessOS debug composition remain named exceptions. An older core ignores the extra advertised
  service and uses its existing installation path; there is no new public protocol version.
- **Migration and rollback:** Reuse installation directory and existing claim/result schema. No account/session data
  migration. A worker restart reconstructs installation status from durable evidence; an uncertain dispatch is not
  replayed. Rollback uses the same old journal. Windows records remain readable by an older
  controller: the original saved request cannot replay; a separately requested new launch retains the older
  controller's legacy retry behavior, as detailed above.
- **Audience:** Only authenticated core-to-service private calls may prepare or commit; no route is published to
  clients. Inputs are checked and bounded at the worker. Returned paths/identity/environment are local capability
  data and never go into telemetry. Errors retain the existing caller-visible installation reason; new logs carry
  operation/failure names, not environment contents or paths.
- **Identity:** The worker runs under the same team/account identity that owns the daemon. It never adopts another
  account's credentials or the contributing machine owner's login. The source launch's selected homes and existing
  process environment behavior are preserved; no service-chosen arbitrary command runs in core.
- **Failure:** Disabled, killed, disconnected, timed-out, malformed and stale-worker answers hold the dependent
  launch. No fallback executes installation/probe implementation in default core. A late answer cannot restore
  cancelled launch ownership. Prepare expiration/cancellation cannot install; post-commit uncertainty is durable
  and visible, and duplicate commit never restarts installation. Existing installation timeout remains 20 minutes.
- **Platforms:** CLI daemon on macOS, Linux and Windows; no Desktop/UI/backend changes. Preserve Windows hidden
  process and npm-shim handling. Unit/fixture verification runs on this macOS machine with Node 24.22.2. Linux CI and
  signed Windows in-session verification are separate required evidence where available; do not claim them from
  simulated platform tests.

## Validation selected before implementation

1. Caller-visible red test: setup work must use the supervised service and a cancelled preparation must never
   commit. Reproduce before implementation. Cover cancellation after commit separately: install may complete,
   launch cannot start.
2. Worker protocol/identity/input bounds, preparation cap/expiration, duplicate and lost commit replies, stale
   worker/claim, unavailable/killed/hung workers, malformed replies and independent input/launch behavior.
3. Existing native launch, prepare, download marker, executable/version, POSIX/Windows installation and launch/hook
   golden suites; failures injected around durable claims and dispatch publication.
4. Architecture import-closure regression proving install/probe implementations are absent from default core;
   service runner/host wiring and lean bundle closure. Measure source and closure before/after.
5. Matched hot-path fixture benchmark before/after, isolated homes and daemon sockets only. Tests/compilers wait for
   the parent's validation lock; bounded workers, no live user daemon, home, login or tmux.
6. Parent review, then commit all runtime/design/test source before the actual checked-in local-checks runner.
   Official core/harnessd and affected checks run for that exact commit. Record gate output, platform limits and
   metrics in the external handoff so source SHA stays stable.

## Residual work

This task does not complete package 8: hook/plugin file writers, hook installation, folder trust and their related
proof/configuration implementations remain for the next original tasks. Launch contracts, source identity,
restart/restore cancellation and process ownership stay core responsibilities. A file moving folders alone is not
evidence of extraction: the default runtime import closure and failure behavior must demonstrate it.
