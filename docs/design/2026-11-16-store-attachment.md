# Store lookup must not change an attachment's authority

A Hermes attach snapshots its pane identity before it asks the engine worker for the conversation's store.
The composition root then fills `hermesHome` from that optional lookup. Since the pane identity includes
`hermesHome`, the attach rejects its own result and installs no stream. This includes a resumed session whose
saved row has no home: native discovery deliberately leaves the configured default implicit.

Keep the lookup read-only. Its returned store still selects the worker's reader, including a discovered profile
store. Persistent home ownership stays with native discovery, binding and hooks. Do not change the attach's
identity or lifetime checks: a real rebind, source change, home change or Close must still revoke an old read.

## Design

- Growth: no new records, fields, caches or queues. The removed optional registry write creates no data to delete.
- Concurrency: retain the existing per-session attach serialization and immutable pane/lifetime checks. An optional
  reader no longer mutates the authority it was asked to read under.
- Read cost: the same worker lookup and returned store; no additional reads, retries or fan-out. Rows already carrying
  a profile home still supply it directly. A row without one may repeat the existing indexed home lookup on a later
  read until native discovery supplies its home.
- Scale: no new limit or background work. Native acceptance checks repeated Close/Resume with both implicit default
  and explicit profile homes; parent coordinates the existing core performance workload.
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
