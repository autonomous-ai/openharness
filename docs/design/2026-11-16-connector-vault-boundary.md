# Secret boundary completion: proposed next increment

**Revised for review after finding a blocking-lock hazard:** the direct move of the old `VaultSync.apply` is rejected. It calls `store.locked`, which blocks synchronously with `Atomics.wait` for up to 35 seconds, then synchronous per-token writes/fsync. Agent-config projection takes the same blocking lock again. The replacement below uses async bounded token-store read/merge/preparation, retains only a bounded non-yielding final publication, and leaves all agent configuration in edge. The root released the quiet benchmark window but requires this revised Design to clear before bounded red tests or runtime edits. No new process or transport is proposed.

Read-only review, 16 November 2026. No tests, builds, profiling, runtime edits or git mutations have run in this continuation. Source is `/tmp/harness-core-secret-custody` at `1b2c6e1e7c956483193913686f55ca443ab2e097`; existing AgentView changes are preserved. Browser/Git have their own adapted projection and must not regain the old Browser lifecycle during integration.

## Decision for coordinator review

Move the existing connected-account vault synchronization into the existing gateway process, beside its identity and encryption, using the async storage boundary below. Keep the local connector bridge, renewal, OAuth flows and profile configuration in the edge-host connectors service. Remove vault envelopes and plaintext seal/open from the new default core's account interface, gateway proxy and connector query. Preserve Refresh using a bounded metadata-only request on the existing connector query. No new process, local endpoint, peer authentication protocol, encryption format, datastore or key migration.

Do not combine the grid-key migration with this increment. Its actual dependency is the remaining registry/stopped storage read/preparation extraction, described below. Keeping grid keys in those files is explicitly unfinished custody work, not a completed security claim.

## Current behavior and why this is smaller

`services/connectors.ts` starts `VaultSync`; `connectorsProcess.ts` supplies `vaultPortOf` using `connector_vault`. `core/connectorsQueries.ts` calls `lib/connectors/vaultOps.ts`, which reads/writes the encrypted envelope through account backend calls, and passes plaintext through `core/gatewayLink.ts` for gateway seal/open. The gateway already owns the identity, verified device log, backend HTTP client, signed-in account lifecycle and backend notice reception. `VaultSync` already synchronizes the same machine-local connector store shared with the CLI and bridge under the store's existing lock. Moving that owner beside crypto avoids a new secret-bearing transport.

The current Refresh handler (`connectors.ts:262`) waits for `shared.run()` for at most 15 seconds, then rewrites agent configuration and returns cards plus `shared`. Ordinary list and connect/disconnect/callback/custom/via operations remain edge-owned.

## Proposed contract

- Retain the existing authenticated `connector_vault` service-query name for this transition, but accept only a metadata operation: `{ op: 'sync', refresh: boolean }`. Reject read/write/seal/open and unexpected fields before dispatch; never echo caller payload or gateway payload. Only the authenticated connectors service may ask it.
- Replace `CoreApi.account.connectorVault` and the default gateway proxy's seal/open methods with a metadata-only synchronization method. Its fixed answer is `{ shared: boolean }` or a fixed content-free unavailable/error code. `refresh: false` asks status only, with no HTTP request; `true` completes one bounded exchange or reports unavailable. A malformed or older gateway answer is unavailable, not success.
- The gateway owns `VaultSync`, uses its local `accountHttp` and existing seal/open implementation directly, and processes connection/device-log notices locally. The core retains its existing metadata-notice forwarding to connectors, now only to tell edge to project agent configuration after local token-store changes. No secrets or envelopes cross in that notice. The gateway keeps forwarding any client-facing notices that already exist.
- `connectorsProcess` asks only this operation and never imports `vaultSync`/`vaultOps`; the inline connectors service calls the same metadata API. Ordinary listing still works from local data while sync is unavailable. An explicit Refresh failure is visible through the existing connector error response rather than silently claiming synchronization succeeded. Signed-out listing reports `shared: false`; Refresh still refreshes local agent configuration.
- No generic service-to-service forwarding mechanism is introduced. This replaces a larger existing feature boundary with a smaller one. Further removal of feature-specific core declarations remains a separate architecture step.

## Gateway lifecycle and account authority

One gateway-local owner manages one `VaultSync` instance per account generation. The generation is the existing `GatewayAccount` tuple `(machineId, autonomousEnv, signIn.epoch, signIn.acct)`; no token or credential is included. Signed out means no background sync or secret access. Starting/signing in creates the instance; gateway stop, sign-out and account-generation changes invalidate it synchronously, clear its timers and release retained snapshots as outstanding bounded work settles.

`VaultSync.stop()` currently only clears timers. Strengthen it so a stopped or invalidated instance cannot apply an old response or continue an old exchange. Check its generation after every await and immediately before local apply, seal and remote write. Account HTTP already checks its generation after token renewal and before fetch; preserve that check. A request already sent under the old account may finish, but its result cannot mutate local stores or initiate another request after account change.

The existing local store is user-scoped, not account-scoped; this increment does not migrate it or redefine which current local connections a user explicitly signed into an account shares. It prevents stale work from the previous account being applied or forwarded under the next sign-in. Device-log verification and frozen/suspended/pending rules remain the existing crypto authority. Sync notifications must follow successful log refresh/registration, not seal using a stale log after an account switch. The initial exchange must wait for the current account's verified log; use the gateway's existing refresh completion and notice hooks rather than a new poll.

Background failure logs carry a fixed operation/state, no backend body, token, plaintext, envelope or connector identifier. An explicit Refresh gets a fixed visible failure. Keep one active exchange and one pending-again bit; notices never attach promise handlers. Admit at most one explicit Refresh waiter to that exchange; another gets a fixed busy/unavailable answer immediately. Status requests do not join the exchange. Keep 4 CAS attempts and a 15-second exchange/caller budget; gateway account HTTP takes the remaining budget for each request. Actual OS-operation settlement may exceed the reply deadline and still retains the one storage slot. No retry begins merely because a reply expired. A new account generation waits for actual old-generation storage settlement, never for the old reply alone. Account invalidation cancels publication authority immediately, independent of that wait.

## Async token-store boundary and exact publication semantics

Add a narrowly scoped async snapshot read/merge writer beside `lib/connectors/store.ts`, used only by synchronization. It is not a second `Store` API or a new store: it reads/writes the same `tokens.json`, `clients.json`, `removed.json` and empty `.lock` protocol that current bridge/CLI/old builds use. Reuse the existing pure token/code/removal validation helpers rather than duplicate their schema. Keep synchronous `Store` for its existing edge/CLI callers; gateway imports no `agents.ts` configuration code through synchronization after this change.

1. Read a snapshot with bounded async private-file reads (each existing 1 MiB cap). Check directory and file identity, private ownership/mode, no links/non-files, and bounded bytes before parse. Read each of the three documents once, not the existing per-token reread of clients.json. Lock waits, content reads, temporary writes and fsync are async; configuration projection stays in edge. Final metadata probes, publication and identity-checked namespace cleanup are the bounded synchronous exceptions described below. Bounded JSON parse/serialization remains ordinary TypeScript work and must be measured at the capacity limit.
2. Backend envelope read/open occurs outside the disk lock. Acquire the SAME `.lock` via async exclusive creation; retry asynchronously under a short fixed budget (5 seconds, within the exchange budget), never `Atomics.wait`. Old writers holding it longer produce an explicit unavailable Refresh; background sync can try on its next existing trigger. Preserve the existing stale-lock threshold/format. Track this acquired file's descriptor/device/inode identity, not just its pathname.
3. Under the acquired lock, reread all three current files and then compute the merge. Do not prepare a merged local snapshot before acquiring the lock. This is the specific fix that preserves a token renewed or disconnected locally while backend work was outstanding. Build at most one replacement per changed document, preserving unused client entries and existing supported legacy code normalization, with unchanged formats and limits.
4. Prepare private temporary files asynchronously: exclusive 0600 creation, complete write, fsync and close. All pending OS operations remain owned until they actually settle, including a failed/deadline-expired caller. The lock stays held through preparation, final publication and settlement. A timeout or account change only revokes the permission to publish; it is not proof an OS write finished. Cleanup removes only this attempt's known temporary files and its own lock, never a later owner's.
5. **Commit point:** once all preparation is complete, one non-yielding section checks the current account generation, exchange deadline, acquired lock identity, directory identity and source-document fingerprints, then calls `renameSync` for at most the three prepared documents. No await occurs between the authority check and the last rename. An account-change callback therefore runs wholly before this section (nothing publishes), or wholly after it (the already-authorized local changes are committed under the old generation). This is the only synchronous filesystem publication work retained in gateway; no lock waiting, content read/write, parsing or fsync is inside it. Its latency must be measured rather than called free.
6. Existing storage has **no atomic transaction across the three files**. Each successful rename is that document's linearization point; do not claim one rename atomically publishes all of them. Publish removal evidence and client material before the token map: a newly published DCR token must not lack the client it needs, and a removal must not lose its tombstone. If a later rename fails, earlier documents may already be visible. Return a named `STORE_WRITE_UNCONFIRMED`/unavailable result, retain the fact that local data changed, and do not pretend nothing happened or roll old data over later writers. A subsequent exchange rereads actual files and merges under lock; tests must prove recovery from every prefix of this write order, including a refreshed client paired with the old token. The existing same-issued-token merge prefers the local entry even if it lacks the remote entry's required client; cover and correct that incomplete-record recovery where token identity agrees, without overriding a newer token. This increment preserves the existing per-document contract rather than introducing a journal/migration. No recovery claim is accepted from a happy-path-only test.
7. Before publication, asynchronously open the directory with `O_DIRECTORY | O_NOFOLLOW` where supported and validate its descriptor identity against the directory originally read. Keep that descriptor through publication and asynchronously fsync that same object afterward; never reopen the root pathname after publication to acknowledge durability. Retain lock/queue ownership through sync and close settlement. If sync fails after rename, visibility is committed but crash durability is uncertain; report unconfirmed and do not acknowledge successful synchronization. The operation has no remaining permission to publish content after a generation change. Windows preserves the existing no-directory-fsync contract. An in-flight remote HTTP write sent before invalidation keeps its original account context; its response is ignored after invalidation, with no follow-up or local apply.
8. After lock release, if any local document was published, emit one metadata change notice to edge. The notice carries no old account content or credential; edge rereads the current local store and performs its existing config projection. It is appropriate even after an uncertain write because files may visibly have changed. A dropped notice is recovered by edge startup/reconnect and explicit Refresh; the owner also emits status/change on gateway reconnect. Do not make edge block on a lock gateway still holds. Ordinary token renewal needs no config rewrite when the set of usable connector codes/projection shape did not change.
9. Cleanup retains at most this attempt's three private temporary files and its one lock, identified by device/inode/birth time. A bounded synchronous metadata probe and unlink remove only the same owned object; missing or replaced paths in the original directory are not deleted. A renamed/replaced root does not discharge ownership: cleanup retains the original directory identity and refuses fresh preparation until that root is restored and reconciled. Failed cleanup reports `STORE_CLEANUP_UNCONFIRMED` and preserves those residuals. Every subsequent merge reconciles them before creating a fresh temporary file or lock, so repeated failures cannot accumulate credentials. An unknown creation identity is refused until the residue is externally resolved; it is never blindly deleted. The actual operation has settled before this cleanup begins, and a metadata notice is withheld until the owned lock is released. This is bounded ownership within the gateway process, not a new crash-recovery journal.

Readiness is an authority epoch as well as an account key. Every observed loss of verified device-log readiness permanently revokes the current exchange, even if readiness returns for the same account while an await is pending. A fresh exchange starts only after the old owner's actual settlement. Gateway refresh/registration/sign-out paths notify this loss immediately; the final writer guard reads cached readiness rather than synchronously rereading a whole device log.

The remote plaintext boundary rejects invalid/reserved connector codes and malformed maps, normalizes existing aliases, and reconstructs only supported scalar client fields through the same store helper. Unknown nested fields cannot enter fingerprints. Plaintext is capped before JSON parsing at the capacity implied by the existing 1,000,000-character encrypted envelope; ciphertext and recipient count are capped before decoding. Local client parsing keeps the existing localhost HTTP allowance used by local OAuth providers; remote client token endpoints still require HTTPS. The stored and encrypted schemas remain v1.

Why a non-yielding final rename is retained: an async `rename` can settle after account invalidation. Checking generation only before or after awaiting it does not prevent a late old-generation mutation. The small synchronous final publish eliminates that event-loop race; async preparation removes the multi-second lock, write and fsync waits. External legacy writers remain governed by the unchanged lock protocol. Revalidation detects a lock stolen while preparation was pending or a document changed outside that lock; it must refuse the stale candidate. This does not claim the old empty-lock protocol is a hostile same-OS-user sandbox.

Synchronization no longer calls `apply(vault)` or `sync(vault)` directly. Replace that production path, remove its now-unused sync mutation helper, and keep only pure snapshot/merge parsing used by tests and compatibility. Keep configuration in edge: its existing notice subscription invokes existing `syncAgents`, and Refresh invokes it after the metadata sync result. Normal callback/renewal/local writes retain their existing edge code and local-store lock. This does not add a second periodic config sweep.

## Compatibility, unchanged data and rollback

- Backend envelope remains v1, existing revision CAS and recipient signatures unchanged. Store JSON files and their lock remain unchanged. No data migration, deletion or backup access is required.
- Desktop/mobile/CLI connector request and card shapes remain the same. Public callers never used `connector_vault`; only the local service did. The existing `shared` boolean remains meaningful and Refresh errors use the existing response mechanism.
- Whole-build rollback starts the older connector synchronization owner against exactly the same local files and backend envelope. No key is stranded and no new field needs an old reader.
- Older core + newer gateway: keep the old `gateway_connector_vault` seal/open handler only inside the gateway as a compatibility adapter for at least 30 days after the first published CLI release containing it. Record that release-derived retirement date before removal. It must not reintroduce a default-core method/import. Concurrent old-edge and new-gateway exchanges use the existing store lock and backend revision CAS; test convergence with both, including rotated tokens and removals.
- New core + older gateway: the new sync operation receives unsupported/unavailable. Local bridge, local lists and all existing agent work remain usable; explicit Refresh reports sync unavailable. No plaintext fallback is permitted. Verify that a normal same-build service restart restores synchronization. The master selects current bundle code for restarted services (`harnessd/leanServices.ts`); do not claim unsupported old peers magically acquired the new owner.
- New connector process + older core: same explicit unavailable behavior for Refresh; local list/bridge continue. If the coordinator requires seamless mixed-build Refresh, that requirement needs an existing safe routing contract or a phased gateway rollout; do not silently preserve plaintext core transit.
- Inline/debug and old-master compositions call the same implementation. The guarantee is default out-of-process core custody; explicit all-inline debug mode still co-locates gateway by design and is not misrepresented as isolation.

## Data checklist

1. Growth: no new durable data. Existing connector files are individually bounded to 1 MiB; backend ciphertext to 1,000,000 characters and recipients to 64. Retain 180-day removal tombstones and existing 4 conflict attempts. Enforce the existing backend envelope bounds before constructing/sending a replacement, reporting capacity failure without token content. A 10x fixture must hit an explicit bound rather than expand the core queue.
2. Concurrency: existing local store lock and backend revision CAS stay authoritative. Merge happens only after acquiring that lock. Gateway-local single flight coalesces triggers and a single Refresh waiter is bounded. Account invalidation fences the non-yielding final publication; prepared IO and uncertain completion retain their writer slot until actual settlement. A metadata Refresh reply is not a new store authority.
3. Read cost: reads and crypto move from edge/core round trips into gateway; no new core store read. Keep the existing local-change and long-refresh cadence for this extraction; removing pre-existing polling is separate work. `refresh: false` does not reread the backend.
4. Scale/measurement: report core IPC bytes and fixed-operation latency for 1/10/100 synthetic connections (and the declared maximum), plus edge/gateway/core idle CPU and RSS. Same fixture, pinned Node, serialized quiet runs. No performance claim before measurement; preserve all earlier failed cost results.
5. Compatibility: matrix above. All old/new public connector readers retain card shapes, same store and v1 envelope. Search production consumers again before implementation.
6. Migration/rollback: none; unchanged documents are fixtures in old-reader tests. Dated gateway-only legacy adapter is explicit, never counted as core code.
7. Audience: same current OS user, owner-only public connector handler, authenticated connectors service query, gateway verified account and device log. Backend authorization unchanged. No broader service access to keys.
8. Identity: original OS login and account generation only; no owner-account substitution. Tests use throwaway homes and synthetic keys.
9. Failure: gateway missing/unsupported/stopped, offline backend, frozen log, unreadable store, capacity and CAS exhaustion have named content-free states. Local agent sessions do not depend on sync availability.
10. Platforms: platform-neutral TypeScript and existing private-store helpers on macOS/Linux/Windows. No new socket/pipe/ACL path. Local evidence will be macOS; CI and Windows must be named separately.

## Failing caller tests before source changes

1. Real `answerConnectorsQuery`: legacy read/write/seal/open and extra-secret payloads are refused, only the connectors service can request sync/status, fixed output cannot carry a gateway-injected canary. Existing code fails on its actual seal/open dispatch; do not use a fake that already implements the new behavior.
2. `runConnectorsService` + real connector handler: capture outgoing core queries during list and Refresh; only fixed metadata operations cross. Local list succeeds disconnected; Refresh surfaces unavailable; reconnect succeeds. No seal/open or plaintext in captured JSON. Signed-out Refresh still performs local config sync and reports `shared:false`.
3. Real gateway-owned exchange using isolated Store and real envelope crypto against a fake revision-CAS backend: account A can synchronize a synthetic token to its second machine; renewals, removals, stranded envelopes, frozen log, recipient changes and CAS contention retain current behavior. Capture all core-facing replies/events and prove neither key nor plaintext traverses them.
4. Deferred backend/key-log calls: sign-out/account replacement/stop while read, open, seal or write is pending; no stale local apply, wrong-account write, late follow-up or timer survives. No sleeps: explicit barriers and fake timers.
   Add storage barriers at lock acquisition, each read, temporary write/fsync/close, immediately before final rename, after a successful rename and before durability sync. Invalidation before commit publishes nothing; invalidation after commit cannot undo the authorized visible write and never allows another old-generation mutation. Deadline expiry cannot admit a second writer before OS settlement. Force each rename and directory-sync failure and verify unconfirmed state plus idempotent fresh-read recovery. A separate process holding the old-format lock cannot stall a gateway heartbeat; a local renewal made before the lock is acquired must survive the merge. Test link/FIFO/oversize/private-mode failures without touching owner state.
5. Mixed-version adapters: old seal/open gateway calls retain old answers only outside core; new core rejects old connector operations; unsupported new operation is unavailable without plaintext fallback. Old/new sync owners converge on same files/envelope and rollback readers decode them unchanged.
6. Architecture import test: default core no longer loads `lib/connectors/vaultOps.ts`; no new crypto/store/sync module enters it. Tests cover direct inline callback and actual gateway/core process proxy, not only helpers.
7. Native isolated process scenario: gateway sync with private homes and fake backend; kill/restart gateway during Refresh, keep a fixture agent turn usable, reconnect and synchronize. No owner daemon, login, home or accounts touched.

Selected gates after Design approval: bounded red subset, same green subset, affected connector/gateway/vault/async-store/architecture unit files, TypeScript, diff check; required per-file core/service coverage and local-check selector on final diff; isolated native scenario and serialized cost measurements. Add maximum-size gateway-loop/lock-contention measurements; baseline and candidate use the same data and no owner files. No extra CI/push/PR/merge from this worker.

## Grid custody dependency and atomic authority that stays

Current `RegisteredSession.gridLaunch` is the entire validated override including `apiKey`; stopped v1 files copy it. `restoreAgents`, `resumeAgentService`, restart/retarget and `buildLaunchOverrides` deliberately refuse missing credentials rather than launch under the vendor login. Saved APIs can refresh a key from `ApiConnections`; unsaved Grid launch keys have no other durable authority. Every supported older core expects the literal key in the old registry/stopped field.

The pending registry async increment changes waiting/preparation behavior but still parses the full registry image in core (`load`, persistence merge), constructs the full serialized image there and supplies it to `prepareRegistryImage`. `StoppedAgentStore.get/list/save/patch` likewise reads/copies complete rows in core. Removing the in-memory property alone loses persistence; placing a reference in the old field breaks rollback; a second store that leaves the original keys is not custody removal.

Required subsequent boundary: an existing appropriate storage/native subprocess performs bounded private image read, parse and preparation, preserving the old disk schema, and returns session metadata with opaque, version-bound credential references to core. Models resolves a specific authorized launch reference inside that subsystem boundary and returns only the engine's one-use launch material. Read/prepare must cover both live registry and stopped documents, including stop/resume/restart, old-writer edits and old-build rollback. It cannot be a models service that imports/owns the live registry or rewrites session authority. Final design must specify authority on the preparation result, exact byte/image freshness, stable lifetime and bounds of opaque references, crash recovery and old-writer conflicts before implementation. No new key-store migration is selected here.

The final session-authority transaction must remain in core: after all async preparation, recheck current live ownership generation, selected conversation identity, command/cancellation authority, durable-image freshness and any prior unconfirmed publication, then atomically publish/rename and update in-memory ownership without yielding. Late/stale worker results must not publish over a newer owner. Stop/Resume is not successful until publication is durably confirmed; reply timeout cannot release the writer while its OS operation may still land. This is mandatory session authority, not credential or feature policy. The worker should own heavy parsing/serialization/private secret bytes; core should own only the bounded final authority/commit decision.

This dependency is concrete remaining work, not an authorization to add competing storage to this branch. Connector extraction can proceed independently while the registry/storage design is completed.

## Implementation checkpoint (2026-11-16)

- The first caller run failed in three actual pre-change behaviors: core accepted the secret-bearing operations, a stopped synchronization applied a late backend result, and an identical token could not recover a missing client. Receipt: `/tmp/core-secret-boundary-red-20261116.log`.
- Gateway ownership is `gateway/connectorSync.ts`, wired by `gateway/start.ts`; its private async writer is `lib/connectors/vaultStore.ts`. `core/api.ts`, `core/connectorsQueries.ts` and `core/gatewayLink.ts` expose only `{refresh:boolean}` / `{shared:boolean}`. Edge `services/connectors.ts` retains agent configuration projection. The default core import list loses `lib/connectors/vaultOps.ts` and gains no replacement secret module.
- The focused native-allowance caller run passed 11 files / 215 tests in 40.45 seconds, covering publication prefixes, late settlement, residual cleanup, same-account trust revocation, metadata projection, typed parse limits, gateway legacy compatibility and edge callers. Receipt: `/tmp/core-secret-boundary-callers-native-20261116.log`. The preceding sandbox run could not bind private test sockets; its failed environment receipt is retained separately. TypeScript passed after the test fixture's union-index typing was corrected (`/tmp/core-secret-boundary-typecheck-final-20261116.log`).
- Native process proof, required coverage/local selector, independent final review and coordinated before/after cost measurements remain pending at this checkpoint. These receipts do not claim final validation or full Grid secret custody completion. Local results are macOS only; Windows/Linux execution is not claimed.
- Independent review found and reproduced two storage bugs before final validation: a late root open could fsync a different directory, and a `__proto__` client issuer could modify a plain map's prototype. Both caller REDs are retained in `/tmp/core-secret-boundary-directory-red-20261116.log`; the same local Store writer case also failed in `/tmp/core-secret-boundary-client-red-20261116.log`. The directory handle is now pinned before publication; cleanup retains directory identity; client documents use null-prototype own-data maps with unchanged JSON format. Storage/owner regressions passed 39 tests before the subsequent wire correction.
- The first two native process attempts exposed real framing rejection: service queries include `query`/`requestId`, and gateway calls include `requestId`. Tests which directly called handlers had omitted those fields. `/tmp/core-secret-boundary-wire-red-20261116.log` reproduces both callers; `/tmp/core-secret-boundary-wire-green-20261116.log` passes all 22 tests after accepting the bounded existing transport framing while still refusing extra secret fields. The first native failure was initially suspected to be readiness timing; the preserved failed retries established the framing cause. No failed native run is counted as passing.

### Validation after those corrections

- Native shipped bundle: `/tmp/core-secret-boundary-e2e-wire-20261116.log`, 1 test passed, 45.27 seconds total (25.68 seconds test). A held Refresh fails visibly when only the private fixture's gateway is killed; a local list and an entire fake-agent turn complete while it is absent; the restarted gateway synchronizes again; core starts exactly once. The synthetic credential is absent from envelope/list/log. The proof uses gateway and connectors out of process; the prepared cost fixture uses the default complete process split.
- Required `npm run test:core -- --maxWorkers=1`: `/tmp/core-secret-boundary-core-gate-20261116.log`, actual exit 0, 251 files / 4,550 tests, 389.85 seconds. Every required file reached 100% statements, branches, functions and lines. Added caller controls exercise metadata notice projection/recovery, no projection rewrite on token-only renewal, signed-out Refresh, service reconnect and malformed metadata replies. The final fixture adds the typed `reason` field to an unrelated notice; runtime source is unchanged from this gate.
- Existing Store/OAuth/REST/schema consumers: `/tmp/core-secret-boundary-store-consumers-20261116.log`, 3 files / 66 tests passed, 10.43 seconds. These include the existing local provider behaviors after shared client validation was reconstructed.
- Final TypeScript receipt: `/tmp/core-secret-boundary-typecheck-covered-final-20261116.log`, exit 0 after correcting that notice fixture's type. `git diff --check` passed. The local-check selector reports only `cli-core` for this diff; final clean-commit attestation remains the integrating coordinator's step.
- No before/after cost claim yet. `/tmp/core-connector-vault-cost/` holds the prepared native and protocol workloads plus the review notes, not a completed measurement. Final independent review, coordinated measurements and clean-commit release evidence remain open. Grid registry/stopped credential custody remains outside this completed connector implementation.

### Unconfirmed descriptor close correction (2026-11-17)

Final review found that a rejected FileHandle.close could release the writer's admission while the
OS descriptor's release remained unknown. All handles opened by this writer use one close helper.
A failed close retains that exact handle and permanently refuses further writes in this writer
instance with STORE_CLEANUP_UNCONFIRMED; it never retries a possibly reused numeric descriptor.
The first failure aborts preparation, with at most the already pinned directory also needing close,
so at most two failed handles remain in the existing single writer instance until the process ends.
Normal filesystem cleanup still attempts every owned temporary and lock; it cannot clear failed
descriptor ownership. There is no new durable state, protocol, retry loop or background work.
Growth, audience, identity, old-file compatibility and publication semantics remain unchanged.
This applies to every platform; caller tests inject lock/read/temp/directory close failures and prove
that a later merge opens no handle. Earlier passing receipts remain scoped to their original source.

The four exact close-failure caller cases failed before the correction because another merge
succeeded and opened fresh handles (`/tmp/core-secret-close-red-exact.log`). With retained ownership,
all five affected suites pass: 79 tests in 8.55 seconds; TypeScript passes. The first read-failure
fixture selected a file that was absent; it was corrected to the existing clients document before
the exact RED. The earlier fixture failure and all original evidence remain retained.


### Observed file watermark correction — Design (2026-11-17)

The fixed ABBA exposed extra gateway work during idle. A separate private diagnostic found no
backend vault reads in either control idle window, but one at the candidate's first five-second
file check and none in its next window. CPU profiles show exchange/merge/decryption only in that
first candidate window. The extracted sync owner no longer records the file versions it has
successfully synchronized. This correction addresses that cause; it does not explain the separate
core CPU delta or replace the pending corrected-source performance comparison.

1. Growth: the existing `filesAt` watermark remains one bounded string for exactly three local
   documents plus its already-owned directory identity. The merge reply gains those versions only for the lifetime of its existing operation;
   no new cache, durable state, timer, process or retention policy.
2. Concurrency: the existing legacy lock and single writer still own reads/publication. A merge
   returns its snapshot and exact observed versions. Unchanged documents retain their verified
   descriptor read versions. Prepared documents record post-write descriptor metadata; immediately
   after each rename, while still in the existing non-yielding publication section, the destination
   must be the same owned file with unchanged content/version metadata (ctime alone may reflect the
   rename). Only that checked version enters the reply. Never sample arbitrary paths after releasing
   the lock and call them synchronized: another writer's unseen edit must trigger the next check.
3. Read cost: no extra content reads. There are at most three additional descriptor metadata reads
   during preparation and at most six bounded prepared/destination metadata checks during publication. The existing
   five-second check uses matching bigint lstat versions and one root lstat to reject directory aliases or ownership/permission changes; no frequency change. A probe whose observed
   watermark was superseded while awaiting metadata is discarded; the next existing check sees any
   subsequent edit. Successful startup, Refresh and backend-triggered publications cause no echo exchange.
4. Scale: the count is always three regardless of connector count, with existing file/plaintext
   limits unchanged. The diagnosed 1,101-connector fixture and the original mixed ABBA remain recorded;
   corrected-source CPU, memory, loop delay and latency must be measured separately before acceptance.
5. Compatibility: this is an internal gateway writer result, never IPC. Stored documents, locks,
   encryption, public clients, old writers and the supported rolling-upgrade contracts are unchanged.
6. Migration/rollback: none, because no persisted format changes. Rolling back restores the redundant
   synchronization but reads the same files.
7. Audience: no versions or content leave the gateway. Existing backend/account and private-file
   checks remain; diagnostics use fixed error codes without paths or contents.
8. Identity: the same current OS owner and verified account generation. The sync owner advances the
   successful watermark only after the exchange completes and its current-authority check passes.
9. Failure: busy, uncertain close/publication, revoked authority, failed backend exchange or failed
   metadata checks never advance the successful watermark. Only ENOENT is absence; another metadata
   error is logged as synchronization unavailable and remains unknown. Existing cleanup ownership,
   actual-settlement admission, bounded retries and visible Refresh failure remain intact.
10. Platforms: shared TypeScript for macOS, Linux and Windows. Use bigint lstat fields already used by
    the writer; ignore only ctime when comparing an owned prepared file across rename, then retain the
    actual post-rename ctime for later checks. Local tests run on macOS; native Linux/Windows are not
    claimed by these local results.

Selected caller checks before implementation: unchanged startup and warm Refresh have no first/second
poll backend read; a successful changed envelope has no publication echo; a concurrent edit is either
included or detected later; a replacement with preserved mtime, removal and missing-to-present file
change are detected; failed or revoked exchanges do not acknowledge metadata. Keep all existing
writer close, cleanup, publication-prefix and account-epoch cases. Focused suites use one worker;
full gates/native/cost acceptance remain the coordinator's work after review.


The initial meaningful caller RED has eight expected failures and three passing controls
(`/tmp/core-connector-watermark-red-callers.log`, exit 1). Earlier ESM-spy setup and recursive-spy
attempts are retained separately and are not behavior evidence. The correction also reproduced a
probe-admission bug before fixing it: a failed metadata read released the check while another read
was held, doubling issued probes from four to eight (`/tmp/core-connector-watermark-probe-retention-red.log`).
All three probes now settle before that check can release its admission.

Final runtime source passes all four selected files: 57 cases
(`/tmp/core-connector-watermark-green-reviewed.log`), followed by the complete observed-version file
with its additional stale-probe/concurrent-publication control: 15 cases
(`/tmp/core-connector-watermark-observed-final.log`). That covers 58 unique cases across the two runs,
not a single 58-case run. Final TypeScript and diff checks pass. The first selected green attempt
retained one old result-shape assertion; it was adapted to the new internal snapshot/version reply,
without weakening its publication assertion. Native platform proof, full gates and a new quiet cost
comparison remain the coordinator's work. The earlier core idle CPU delta is still unexplained.

### Metadata admission across synchronization owners — Design (18 November)

Review found that the metadata check's admission belongs to `VaultSync`, while
account changes and gateway restarts replace that owner. `settled()` waits for
its exchange, not its metadata read. A held filesystem probe can therefore
survive an owner replacement while the new owner starts another four probes.
The shared `VaultStore` already survives those replacements to retain write
ownership; metadata admission belongs to that same object.

Keep one actual version read per shared store. Refuse another with the existing
`STORE_BUSY` code before issuing any OS operation, and release the slot only
after the directory read and all three document probes settle, including the
existing `allSettled` path on failure. This adds no queue, waiter list, timer,
cached version or new retry. A replacement owner may still synchronize through
the existing separately bounded writer; its next ordinary metadata check can
run once the old read actually finishes. Old results retain their existing
generation/watermark checks and cannot acknowledge a new owner's files.

- Growth/concurrency: one boolean on the shared store; at most one metadata
  batch (one directory stat, then three document stats) across owner changes.
  It is cleared only by that batch's `finally`, never by a timeout or stop.
- Read cost/scale: unchanged normal reads and cadence. Repeated owners cannot
  multiply a hung batch. The regression counts actual IO calls across stopped
  and replacement sync owners and verifies recovery after settlement.
- Compatibility/migration/rollback: no file, lock, wire or client contract
  changes. Rolling back restores the unbounded owner-replacement behavior.
- Audience/identity: unchanged gateway ownership and private-file checks; no
  content, path or account identifier enters the fixed failure log.
- Failure: existing metadata-unavailable reporting remains; uncertainty never
  means absence or synchronized success. No descriptor is opened by this path.
- Platforms: shared TypeScript on macOS, Linux and Windows. Local behavior
  tests run on macOS; native platform and existing performance holds remain.

Selected checks before runtime edits: a held metadata read across owner
replacement fails first, then all existing observed-watermark and storage
cases, gateway synchronization lifecycle cases and TypeScript. This bounded
admission correction does not clear the earlier idle-cost hold.
