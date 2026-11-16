# Store lookup must not change an attachment's authority

A Hermes attach snapshots its pane identity before it asks the engine worker for the conversation's store.
The composition root then fills `hermesHome` from that optional lookup. Since the pane identity includes
`hermesHome`, the attach rejects its own result and installs no stream. This includes a resumed session whose
saved row has no home: native discovery deliberately leaves the configured default implicit.

Keep the lookup read-only. Its returned store still selects the worker's reader, including a discovered profile
store. Persistent home ownership stays with native discovery, binding and hooks. Do not change the attach's
identity or lifetime checks: a real rebind, source change, home change or Close must still revoke an old read.

## Design

- Growth: no new core records, fields, caches or queues. The removed optional registry write creates no data to delete.
  The worker's bounded, temporary successful-lookup memo is specified in the reviewed follow-up below.
- Concurrency: retain the existing per-session attach serialization and immutable pane/lifetime checks. An optional
  reader no longer mutates the authority it was asked to read under.
- Read cost: each cold lookup uses the same indexed discovery and returned store. Removing the registry write alone
  repeated that work on subsequent null-home reads and regressed the measured workload; the worker follow-up below
  reuses successful discovery within fixed bounds. Explicit profile homes still supply the store directly.
- Scale: no new core limit or background work. Native live acceptance checks repeated Close/Resume with an implicit
  default home. Explicit native stopped-history reads and implicit/explicit/discovered-profile caller tests are
  separate evidence; parent coordinates the matched performance workload and required gates.
- Compatibility: no backend, wire, request or saved-row schema change. Existing home fields remain authoritative;
  old and current clients see the same contract.
- Migration and rollback: none required; reverting restores the optional write and its attachment race.
- Audience: unchanged; this is the core's internal worker request, with no new client access.
- Identity: no process, conversation, source or cancellation guard changes. A worker result cannot claim a home for
  the native session, or overwrite a concurrently supplied home.
- Failure: retain the existing unavailable-reader hold/log. A successful lookup no longer silently invalidates the
  attach that requested it.
- Platforms: shared TypeScript core code on macOS, Linux and Windows. Focused caller tests run on macOS; the root task
  coordinates required gates and native validation. No process-launch code changes.

## Regression evidence

The deterministic caller test evaluates the actual `createStoreOf` composition from `main.ts` with private fixture
dependencies, then invokes real `createAttach` against a real isolated registry. It checks implicit default and
discovered profile stores, explicit profile ownership, and revocation while the store answer is delayed. This tests
the composition responsible for the race without starting the owner's daemon or duplicating its callback.

Before the runtime edit, three of nine caller cases failed: default and discovered-profile attachment returned
`false`, and a lookup arriving after `attach.forget` still changed the native home. The explicit-profile and four
changed-authority controls, plus unavailable-store handling, passed. After removing the optional write, all nine
passed; the focused attach, store and native Hermes discovery group passed 205 tests. TypeScript also passed.

Native acceptance extends the existing private `readerClose.e2e.ts` fixture: assert the saved default home stays null
after a real history request and each same-conversation Close/Resume, then assert fresh live turn delivery after the
last Resume. Against the retained baseline bundle (source tree identical to `8fcfa7de5c`), this fails after the history
request: the saved home is the private fixture's default path instead of null. Candidate native validation and broader
required gates are recorded with the root task's validation evidence.

## Worker lookup cost follow-up — reviewed Design

Root reviewed and approved this Design before test or runtime implementation on 2026-11-16.

The frozen stopped-history workload found a regression after the registry write was removed: over 3,000 reads,
implicit-home median p95 rose from 1.3491 to 1.5905 ms and combined core/worker CPU from 3.58 to 3.985 s. Both
matched pairs were slower. Explicit-home controls did not regress. The removed write had also remembered successful
discovery for later reads; without it, each null-home read repeats the indexed `sessions.id` lookup. Thus the first
Design originally considered one request only, not repeated reads, and did not establish acceptance.
All v1–v4 source, bundles, functional receipts and timed results remain frozen. The worker follow-up is not measured yet.

Keep successful lookup reuse inside the existing `engine-others` request handler. Its live-stream maps cannot
serve this workload because stopped conversations have no stream. The existing home-list cache avoids directory
listing only. Add one private memo to `otherStreamRequests`; add no core state, queue, registry write or protocol.

1. **Growth.** Remember only a successful `findHermesHomeForSession` result for a request without an explicit home.
   Keys are session IDs, values are homes plus a fixed expiry. Limit it to 512 entries and 1 MiB of string payload,
   counted conservatively as twice the ID and home's UTF-16 lengths; map/entry overhead is additionally bounded by
   512 entries. Admit only existing protocol-bounded IDs and homes; any one admitted entry fits within the byte cap.
   Evict oldest insertions until both bounds fit. Out-of-protocol results are not remembered. Hits do not reorder
   entries or extend expiry. An expired
   entry is removed when that ID is asked again; unrelated expired entries may occupy the bounded map until FIFO
   eviction. Process exit destroys all entries. No timer, sweep, persistence, negative result or default fallback
   is remembered. Inline compatibility owns the same bounded map for its handler lifetime.
2. **Concurrency.** Use a monotonic 30-second expiry measured from lookup start, matching the existing home-list
   reuse interval without extending a slow lookup's life. A completed lookup inserts only if its request is still
   connected, its expiry has not passed, and no unexpired success is already present. Map reads/edits are synchronous
   within the worker event loop. Concurrent misses keep the existing independent lookups; no new pending queue or
   coalescing map. The first completed, still-valid success wins the memo; each request still returns its own lookup
   result. A late completion cannot overwrite an unexpired entry. Replies remain snapshots under the core's existing
   identity/cancellation checks.
3. **Read cost.** Explicit native homes always bypass discovery and this memo, and never populate it. A hit performs
   no filesystem or SQLite work; a miss runs the unchanged default-first indexed discovery over at most 65 homes.
   Missing, unavailable and thrown lookup results are retried on the next request, using existing fallback/error
   behavior. The memo removes repeated successful home queries for 30 seconds; actual history/last-turn reads and
   their response bounds remain unchanged. Caller tests count the real indexed query, rather than time an imitation.
4. **Scale.** At 10x the 16-session reference workload, 160 ordinary home paths fit below the 512-entry cap; the byte
   cap can evict earlier for long paths, with correctness unchanged and discovery cost returning. This is a bounded
   optimization, not an admission limit. The acceptance measures remain stopped-history p95, core and worker CPU,
   and RSS on the same frozen 20-turn/3,000-request workload, plus its explicit-home control. No new background
   measurement or public metric is introduced. A newly affected bound or slower acceptance result requires review.
5. **Compatibility.** No backend, saved-row, wire or client change. Only `STREAM_STORE` reads this private memo;
   history, last-turn and attachment callers keep receiving the same store/home answer. A moved/deleted/reused ID
   may use its previously discovered home until the fixed memo expiry, then discovery runs again (with the existing
   home-list cache's own 30-second semantics). No extra store validation query runs on hits. An explicit native home
   wins immediately, including the same ID in different profiles. Implicit duplicate IDs retain discovery's existing
   first-home behavior; the memo supplies no evidence of unique native ownership. This is weaker freshness than the
   uncached candidate during that interval, but bounded more tightly than the baseline's indefinitely persisted
   discovered home. Worker restart or FIFO eviction also removes the remembered location.
6. **Migration and rollback.** No stored data or migration. Restart discards the optimization. Reverting only this
   follow-up restores the measured repeated-lookup cost while retaining the attachment correctness fix; restoring
   the original core registry write would restore the race and is not the rollback.
7. **Audience.** The existing owner/local/no-client-connection check precedes every memo read or edit. No new access
   surface, log content or telemetry; private session IDs and paths remain in worker memory only.
8. **Identity.** This is a reader hint, never native session authority. No binding, source, runtime, login or pane
   guard changes. Explicit profile reads neither consume nor alter an implicit hint for the same ID. The core still
   rejects replies invalidated by forget, rebind, owner change or cancellation.
9. **Failure.** Preserve existing fallback and named unavailable response/log. No failed lookup poisons later reads;
   eviction/expiry only costs another lookup. A deleted/moved store can yield existing empty/unavailable reader
   behavior during the bounded hint lifetime; the memo does not hide or reinterpret the reader's result.
10. **Platforms.** Shared TypeScript worker on macOS, Linux and Windows, including the existing inline compatibility
    path. No process-launch change or new dependency. Initial caller proof uses private fixtures on macOS; native,
    performance and required gates wait for root approval.

### Caller RED and acceptance

The request-level spec calls real `otherStreamRequests[STREAM_STORE]` and real Hermes discovery with private
SQLite stores and observes `sqliteReadAll` calls. Repeated successful implicit default and discovered-profile reads
must return the same correct path with only the first indexed lookup. Before the worker runtime edit, 13 of 16
cases failed and three controls passed. Three default reads made three indexed queries instead of one; repeated
profile reads made ten instead of five. The FIFO, byte-bound, fixed-expiry and concurrent-result expectations also
failed as expected. After the worker edit, all 16 pass. The focused worker, Hermes discovery, core worker-port and
attachment-caller group passed 138 tests in seven files with one worker; TypeScript also passed. RED/GREEN logs are
retained with the task's local validation evidence.
Controls cover missing rows becoming visible, unavailable reads recovering, thrown lookups, explicit profiles with
the same ID, distinct discovered-profile IDs, unknown IDs, rejected callers, and separate handler instances.
Deterministic deferred lookups and a controlled monotonic clock cover late replies, abort, fixed expiry, moved stores
after expiry, and oldest-entry/byte-budget eviction through returned paths and lookup counts. Bounds tests may mock
the discovery result to construct protocol-sized long paths without creating invalid platform filesystem fixtures.
No test-only production factory, cache inspection API or exported tuning option is needed.

Freeze this candidate and send its diff/evidence before any native test, timed work or full suite. The earlier native
live test proves the implicit default only;
the four stopped-history preflights also prove explicit profile reads. Discovered-profile attachment has deterministic
caller coverage. Neither that correctness evidence nor the rejected pre-memo timings proves the next candidate's cost.

## Integrating the default-home repair from main

Design recorded before resolving the merge of `1119380c173e2bdf36d702608dd0304c66c85323`
into `d9bf670a722ad2024ae3b657cf2e3e9dd5134dce`. Main's #4361 repair changes the same
worker request as the positive lookup memo. Keep both: explicit native homes bypass discovery and
answer only the store; implicit requests reuse successful discovery but answer a home only when
`sameHermesHome` says it differs from the default. Missing discovery remains null inside the helper,
so the caller applies the default store fallback without treating it as a discovery.

Growth, concurrency and scale retain the existing 512-entry/1 MiB/30-second memo bounds, fixed expiry,
positive-only insertion and per-handler lifetime. There is no new cache, timer, queue, record or lock.
Read cost changes relative to the pre-integration candidate: memo hits still avoid indexed discovery,
but main's canonical home comparison performs filesystem checks for a discovered home, including
a memo hit. Thus the earlier no-filesystem-work-on-hit statement describes the earlier checkpoint
only. The new comparison must use main's current behavior on both measured sides.

Compatibility retains main's repaired answer shape: no redundant explicit/default `home`, and a
discovered profile remains present. The current core deliberately consumes only `store`; the worker
hint cannot mutate native ownership, revoke its own attach, or bypass the completed-reader guard.
`keepReader` still compares the full pane identity before and after native confirmation and rejects
an actual home change. No saved-row, backend or client migration is needed. Rollback reverts the
memo/attachment changes while retaining main's #4361 repair. Audience, identity and failure checks
are unchanged; no new telemetry or content is exposed. Shared TypeScript affects macOS, Linux and
Windows, with no process-launch change.

The package's request spec must use a new private default home for every case and restore `env`
afterward. Its previous capture of `env.HERMES_HOME` was unsafe on Windows, where the test-wide
throwaway `HOME` does not replace `%LOCALAPPDATA%`. Only the newly created folder may be deleted.
Update reply expectations to main's contract while retaining actual SQLite query-count controls;
cover a differently spelled default home on both a cold request and a memo hit.

No tests, builds or workloads have run for this integration. Root schedules the worker store/memo
specs, Hermes home and identity controls, attachment/native-confirmation caller tests, TypeScript,
the required core and Resume gates, and private native Close/Resume checks before acceptance.
Native cost must freeze the integrated candidate and current-main baseline with matching helpers
and bundles. Prior native v2 cost FAIL and diagnostic v3/v5 evidence stay scoped to their original
heads; this merge neither supersedes that failure nor establishes performance acceptance.
