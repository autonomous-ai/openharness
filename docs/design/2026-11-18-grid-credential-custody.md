# Grid credential custody

Proposed Design, 18 November 2026. Source inspected: `8cb7a1d8fda0bdc958297a4f72e42c0c280a76f3`.
This is package 6 step 3 of the [core plan](2026-11-15-core-plan.md), following
[agent-view custody](2026-11-16-core-secret-custody.md) and the storage dependency recorded in
[the connector Design](2026-11-16-connector-vault-boundary.md#grid-custody-dependency-and-atomic-authority-that-stays).
This alternatives draft is preserved as evidence. The coordinator selected and subsequently approved alternative
B in [the session storage Design](2026-11-18-session-storage-boundary.md); alternative A is not authorized here.

## The decision needed before implementation

Models should own durable Grid credentials, and a registered or stopped session should own a reference and
credential-free launch metadata. Core still selects the session, owns the launch, checks the models contribution,
and commits the current session/terminal binding. There is no change to vendor-login fallback: a missing or
unreadable credential refuses the Grid launch.

The reference cannot simply replace `gridLaunch.apiKey` today. A historical complete build reads only the
literal key in the old live/stopped row. `selfUpdate.restore` restores bundles and Node, without transforming
session data. Current master cohort admission proves execution payload/composition, not stored-data compatibility.
Removing the literal key before establishing a rollback conversion owner strands saved work under the very
whole-build rollback used to recover a failed update. A second key store while leaving those keys in the rows
does not complete custody extraction.

The proposed reference transaction below therefore has a hard prerequisite: a reviewed, positively enforced
data-conversion owner and ordering across every launch of a historical complete build, or an existing all-session
storage subprocess that can preserve the old disk image while removing its secret bytes from current core reads.
Neither exists at this source. This draft does not change the rollback floor, add a generic broker, make models
own session authority, or claim that moving a helper's source file moves its process.

## Current paths and readers

| Path | Current custody and required change |
| --- | --- |
| `services/models.ts` / `modelsProcess.ts` | Existing models process resolves targets, refreshes saved APIs, and builds each Grid launch. It can own the private immutable credential objects; no new feature process is needed for ordinary launch resolution. |
| `lib/apiConnections.ts`, `apiModels.ts` | Saved API authority is already models-owned `apis/connections.json`; each relaunch refreshes current credentials and refuses a removed API. Do not snapshot its key into a second permanent store. |
| `lib/gridLaunchWire.ts` | `GridLaunchOverride` requires the literal key; split inbound compatibility payload from persisted reference metadata. Bound and validate both at their existing request/reply seam. |
| `core/modelsLink.ts`, `core/agents/launch.ts` | Already verify the exact selected engine, retained launch facts and allowed environment/argv/files. A reference response must bind the requested immutable reference and metadata; core receives the one launch's environment, not a returned reusable override containing the key. |
| `core/agents/create.ts` | Publishes `gridLaunchRecord` after target/build preparation. Import an unsaved key durably before publishing a row or allowing the corresponding pane launch. Keep the existing final-current checks after every await. |
| `lib/launchOverrides.ts` | Restart/fork/retarget/restore rebuild from the saved override and persist refreshed values. Resolve the exact reference through models; only reference metadata returns in `gridLaunchRecord`. |
| `lib/registry.ts` | `loadState`, `persist`, `persistedContents`, recovery snapshots, fingerprints and row copies contain the full key today. Replacing only `RegisteredSession` does not remove those copies. |
| `lib/registryPersistence.ts` | Async filesystem helper in the core process, not an existing subprocess. `readPrivateRegistryFile` returns the whole plaintext string; `prepareRegistryImage` accepts the whole serialized string. Final rename/ownership admission remains core authority. |
| `lib/stoppedAgents.ts` | `get`, catalog cache, `save`, `patch` and `list` retain/copy the full row. Any extraction must include both active and stopped documents, reservations and same-agent resume. |
| `lib/restoreAgents.ts`, `resumeAgentService.ts` | Explicitly reject a Grid assignment without the credential-bearing launch; references must remain distinguishable from an unknown/discovered credential. No retry may select the owner's vendor login. |
| `core/agents/retarget.ts`, `launchAuthority.ts` | Selected-session/launch freshness fingerprints must include immutable reference and metadata rather than a mutable credential object. Retarget must not retire a source still used by a stopped snapshot or an in-flight authorized launch. |
| `core/api.ts:agentView`, `agentLife.ts`, conversation reads | Already omit `gridLaunch` from service metadata. Preserve that omission for references too; no new credential lookup capability goes to metadata readers. |
| `lib/selfUpdate.ts:restore`, `harnessd/supervisor.ts`, `master.ts`, `reexec.ts` | Select and launch historical complete code. There is currently no durable conversion barrier, data format proof or retained converter on all of these recovery paths. |

Search used: production references to `gridLaunch`, `GridLaunchRecord`, `parseGridLaunchOverride`,
`prepareRegistryImage`, `readPrivateRegistryFile`, `restoreUpdate`, and `rollback` in the paths above.
The [16 November custody review](2026-11-16-core-secret-custody.md#supported-old-source-evidence) inspected
`6856f736644ab28cbea6ef65e5c3599c2838e802` (16 October) and confirmed old live/stopped readers require
the literal key. Repeat the compatibility matrix at the eventual first published release; do not date a
30-day exception from this unshipped Design.

## Design: ordinary reference transaction after the prerequisite

### Authority and storage

Use a versioned private subdirectory owned by models, with one immutable object per unsaved imported credential.
An opaque random reference addresses it; neither its pathname nor its reference is derived from the secret.
Do not add keys to `apis/connections.json`: an unsaved Grid import is not a user-saved API and must not appear
in the picker. Its object contains the validated override plus the import operation identity, never session
binding authority. Saved APIs instead retain their existing connection id and chosen model/metadata, resolving
the current key through `ApiConnections` on each authorized launch. A removed saved API stays removed.

The saved-API store bounds keys to 8 KiB, but the raw Grid override and legacy Registry rows have no such limit.
An object size bound would therefore require a separate compatibility decision; this alternative cannot claim
that the existing schema already supplies one.
Core stores a versioned reference plus network/model facts needed for launch checks, frames and errors; it stores
no key or generated environment in registered/stopped records or creation receipts. A reference is not permission
to launch: the authenticated models port answers only a core-selected launch and core still binds the result to
the current selected session, request, engine and captured reference. No public reference-resolution operation.

The minimal port change replaces credential-bearing persistence in the existing `gridLaunch` operation; it does
not introduce an arbitrary storage or credential broker. Input distinguishes a fresh validated client override,
an immutable imported reference, and a saved API selection. Output contains checked launch contribution and
the reference metadata to commit. A fresh import must be durable before success is returned. The core's usual
launch contribution validator still checks engine allowlists and output bytes in process and inline modes.

### Creation, crash and cancellation

| Point | Durable fact | Recovery / retirement |
| --- | --- | --- |
| Client request received | Existing semantic creation receipt, without literal key | A non-saved credential import gets a stable import identity bound to this attempt; never serialize the key into the receipt. |
| Credential prepared | Exclusive private temporary object; no reference is usable | Deadline/cancel revokes publication; actual write/sync settlement retains the slot. Remove only this object's proven temporary identity. |
| Credential published and synced | Immutable credential object exists | Crash before row publication leaves an orphan candidate, not a live-session authorization. A replay with the same import identity is idempotent; conflicting bytes refuse without logging them. |
| Row/pane publication pending | Core still owns existing creation/launch authority and current checks | An import reply that arrives after cancellation cannot publish a row or start a pane. A reply timeout is not evidence that the credential write or pane launch did not settle. |
| Row publication confirmed | Live row names durable reference | The reference is retained for as long as any live, stopped, reserved-resume or unresolved-launch owner can still name it. No separate commit RPC is required to authorize launch. |
| Stop/resume | Stopped and live rows may briefly name the same reference | Copy the reference, never duplicate the secret. Resume reservation and existing durable admission decide ownership; models does not decide whether a stopped row may launch. |
| Retarget / move to vendor login | Core commits new reference or explicit no-Grid state | Old reference becomes a retirement candidate only after that commit and after any older launch work settles. A failed retarget retains the source. |
| Purge / cancel before launch | Durable core lifecycle removes its reference or establishes no launch | Delete only after positive reconciliation below; silence or age is not cancellation. |
| Recreate same agent/request id | Existing creation receipt and reference identity | Never replace immutable bytes under an old reference; a genuinely new credential uses a new reference. |

Import retries need a durable operation-to-object association or deterministic immutable object identity that
does not derive from key bytes. The operation identity must remain available across uncertain imports; a new
random id on every retry leaks orphan objects. A lost old-client request that has no retry id needs one server
attempt identity, and bounded orphan reconciliation after the attempt/connection actually terminates.

### Retirement and growth

Models must not delete solely because a timed query saw no live row: stopped work can be resumed indefinitely,
core may be restarting, and an older in-flight import can still publish. Core must not grow a models-specific
reference index or garbage-collection authority. Reuse existing bounded lifecycle observations for prompts to
reconcile, but those notifications alone are not a complete authoritative inventory of stopped/reserved/pending
records. The current `follow_agents` API intentionally exposes none of these credential references.

Consequently safe positive retirement needs the same reviewed storage boundary as migration: models' storage
owner enumerates references in exact durable live/stopped/launch-reservation images while holding the common
publication exclusion, and proves no accepted import/publication remains in flight. It never rewrites session
ownership. Reconcile at startup/reconnect and actual retirement events, not on every query or an idle poll.
Enumerate at most 64 files or 1 MiB per pass with continuation, retain one reconciliation, and refuse new imports
at a measured capacity before unbounded growth. The exact lock and limit cannot be declared implemented from
the present interfaces: stopped writes do not take the Registry lock and there is no shared exclusion for them.
Bounded queue/timeouts are not a replacement for this missing exclusion.

### Offline and failure isolation

Unsaved imports resolve entirely from the local private object; restart/resume does not mint a key, contact Grid,
or depend on the owner's current subscription. Saved APIs keep today's local refresh/removal semantics.
Models unavailable means this Grid launch is held/unavailable, while already-running agents and non-Grid
create/stop/restore remain usable. Models restarts read objects by id and rebuild only bounded bookkeeping.
Malformed/missing objects return a fixed credential-unavailable state; no path, value or payload enters logs.
Retirement failure holds its deletion slot and reports cleanup unconfirmed, rather than deleting by guess.

## Migration and whole-build rollback: exact required ordering

The following is the minimum safe conversion contract, not an existing capability:

1. The runtime that will perform the first migration must positively require a conversion-capable owner before
   any secret-bearing legacy document is opened by current core. In particular, an old retained master must
   not admit it and then roll back through its old, converter-unaware `restore` path.
2. Stop admission of new commands, stop/reap core and all legacy writers, and retain the terminal engines.
   Neither taking `registry.json.lock` alone nor waiting for models stops `StoppedAgentStore.save/patch`.
   Claim the same daemon/data-root ownership across conversion and target runtime launch. Record a private,
   durable conversion intent before changing any document. A crash must resume/reconcile that intent before
   *either* old or new runtime opens the data; a reply timeout cannot release this ownership.
3. A retained, verified converter running outside core reads legacy documents in bounded pages. It writes and
   syncs immutable credential objects first. It then prepares reference-only versions of live/stopped files,
   preserves every unrelated byte-level meaning/unknown supported field, and records per-document source
   identity and expected result. Recheck sources before each publication. Never import `Registry` in models.
4. Publish and sync each reference document, recording its actual outcome. Partial migration has one recovery
   rule: do not launch either runtime until all intended documents are reconciled to one supported format.
   Keep the old secret only in unconverted documents or proven recovery temporaries until settlement, then
   remove those copies. Do not leave a second old registry/stopped backup containing secrets indefinitely.
5. On selecting any historical complete build lacking references, use the retained converter under the same
   exclusion *before* executing that build or its master. It reads each reference and current credential object,
   prepares the legacy literal-key image, publishes/syncs it, and verifies every reference has a usable old row.
   Only then may the older complete cohort start. If conversion is unavailable or unconfirmed, hold runtime
   replacement and retain the current safe build/terminal ownership; never launch an old reader over references.
6. Once legacy images are durable, delete the corresponding side objects only when there are no newer reference
   documents or pending conversions. A crash halfway through downgrade retains both transiently and resumes from
   the intent; it cannot strand a reference by deleting its key early. Once old mode is selected, no new-mode
   models writer runs. New upgrade imports any old-writer key edits afresh, without resurrecting a removed API.
7. All startup paths must honor the conversion barrier: initial launcher, retained-master updates, failed
   reexec recovery, Windows pointer rollback, forced/manual older complete-build start, and startup after a
   crash at every prefix above. Merely adding a callback to today's `selfUpdate.restore` misses old code and
   independent old invocations. A converter in the failed new bundle alone is not a recovery owner.

This requires an explicitly reviewed rollout/owner outside the current optional-service contracts. A staged
capability release could establish the barrier first, but a date alone cannot make old executables honor it.
The 30-day public client and stored-data window remains; every adapter removal date must be computed from the
first published capability release. Direct old executables beyond that owner still need a stated supported
entry contract rather than an unannounced rollback-floor change. Root must select this prerequisite explicitly.

### Alternative: preserve old images behind an all-session storage boundary

Keep the current legacy schema as the only durable credential representation during the dated compatibility
window. A trusted session-storage subprocess, used by *all* registry and stopped reads/preparations, parses the
old image, returns only credential-free session metadata plus image-bound opaque references, and prepares new
legacy images from core-selected metadata and models-owned secret resolution. Core retains its exact final
source/ownership/deadline check, rename, durable confirmation and in-memory admission. Historical readers then
need no conversion at rollback; there is no duplicate new plaintext credential file.

This is consistent with the earlier connector Design, but cannot be implemented by renaming today's async
helpers. There is no existing session-storage subprocess. Routing every registry write/read through optional
models would make all sessions depend on models. Routing just known Grid rows still requires reading the old
whole image in core, and no metadata derivative can be trusted after a legacy writer without a source-proof
reader. A `JSON.parse` reviver does not erase the original plaintext string or `persistedContents`.
This alternative therefore needs a separately reviewed session-storage process boundary, not a one-consumer
models broker. It removes plaintext from core state, but keys remain in old row files until the subsequent
reference migration; report that limitation explicitly rather than marking row/file custody complete.

## Design checklist

1. **Growth:** lifecycle above; no age deletion of referenced work; positive retirement exclusion is an explicit
   prerequisite. Import/reconcile slots and per-object bytes bounded. No permanent duplicate plaintext authority.
2. **Concurrency:** immutable credentials, exact import identity, current launch fences and core-owned durable
   session publication. Shared live/stopped/migration exclusion is missing and must be selected before coding.
3. **Read cost:** ordinary resolve reads one at-most-32-KiB object; saved APIs use their existing bounded store.
   No all-record query on a launch. Migration/reconciliation is paged and keeps one current page. Prove bytes/read
   counts in tests; measure IPC, parse/sync, and registry launch/save cost with 16 and 160 rows.
4. **Scale:** measure 160 and 1,600 records, max key sizes and cold/warm resolve, one source image and page at a
   time. First warning is fixed `credential-import/resolve/reconcile` duration/capacity state with no identifiers
   or content. Runtime CPU/RSS/latency acceptance is coordinated by root; no numbers are claimed here.
5. **Compatibility:** public Desktop/CLI payloads stay accepted, including literal unsaved overrides, old missing
   optional MCP/context metadata and removed saved APIs. Metadata frames remain unchanged. Historical whole builds
   require the conversion ordering above; source adapters are not a native old-binary test.
6. **Migration/rollback:** explicit ordered conversion above or the all-session storage alternative; neither is
   silently assumed. No production data/home/credentials have been inspected. Parent prohibits owner-state tests;
   use isolated synthetic histories and named old source fixtures, with production-restore acceptance unresolved.
7. **Audience:** only authenticated core-to-models launch requests resolve credentials. Public frame readers,
   lifecycle observers and logs receive no key/reference authority. Only the explicitly selected engine receives
   its one launch environment. Inline debug keeps its existing co-location exception.
8. **Identity:** same OS owner/data-root and selected provider; guest launches keep their current separate rules.
   Missing credentials refuse; do not fall back to the machine owner's subscription or a similarly named API.
9. **Failure:** missing/unsafe store, stale publication, service loss, capacity, cancellation, lost reply,
   unconfirmed directory durability and conversion crash all have fixed unavailable/held outcomes above.
10. **Platforms:** shared TypeScript affects macOS, Linux and Windows; private paths/ACL and directory fsync follow
    existing rules. Native Windows validation is explicitly deferred by the user, not claimed passed. No mobile work.

## RED preparation and gates

Prepare real Registry/stopped-store assertions that current registered state, current serialized live/stopped
documents and reloaded metadata contain no synthetic canary. Assertions report booleans only, never the canary
or an object diff containing it. Separately preserve baseline restart/resume and historical literal-key-reader
evidence. A passing key-removal test alone is not success: it must be paired with offline resolve and whole-build
rollback producing the same selected provider and usable key.

After root approves the prerequisite/Design: test immutable import replay, conflicting import, every crash prefix,
cancel before/after actual settlement, stopped/live overlap, retarget failure, purged-row retirement, startup with
models unavailable, saved-API rotation/removal and old-writer edits. Fault-inject source replacement, links,
permissions, full disk and directory sync/close failures. Exercise real process and explicit inline seams.
Then run affected unit files, current-source TypeScript, architecture/lean boundary checks and required core/service
coverage selected from the final diff. Native tests use private home/data/tmux and fake engines, never daemon
18473. Root schedules native/cost work and owns integration/review/release.
