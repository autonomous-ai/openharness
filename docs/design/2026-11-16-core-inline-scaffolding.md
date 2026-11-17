# Inline implementation outside the default core

Package 10, after the deletion-only slice merged in #4348. Source inspected:
`8ee115aa029c8d6c7eefb45882b5eb977e8dcb2b`. This is extraction of existing
implementation, not removal of supported inline mode or Harness OS.

## Exact boundary

| Loaded today | Used by default core | Implementation that leaves |
| --- | --- | --- |
| `core/serviceHost.ts` | Fallback markers/readers, `ServiceUnavailableError`, test-fault parsing | `createServiceHost`: inline start, guard, failure bookkeeping and request dispatch |
| `lib/transcriptPages.ts` | `sessions_list` line counting and its incremental index | History page selection, record cursor caches and page scans |
| `lib/sharedMachinesPort.ts` | `answerSharedMachinesOp`: allowed account routes and trust operation | Reply parsing, service-side port and inline port construction |
| `harnessd/services.ts` | Service membership and master capability reports; Browser lifecycle adds held-event metadata | Master `serviceSpecs` selection and updater process budget/name |

The audit already distinguishes line counting from paging and account authority
from reply parsing. Removing these entire files blindly would break real core
callers. The master supervisor has already left `services.ts`; it is not work to
repeat. The host table remains shared because core derives known services and
held lifecycle deliveries from it. This increment adds no duplicate service-name
registry merely to remove unused budget properties.

## Implementation

1. Keep the small service fallback/error contract in `core/serviceHost.ts`.
   Move the existing host factory, without changing its failure rules, to
   `services/inlineHost.ts`, exported only through `services/inline.ts` for runtime
   core composition. The default core constructs no host maps. Its existing
   service-links route remains authoritative; the optional inline route and
   connection-close hook run only when an inline host exists. All existing
   inline starts use that host and retain the five-failures-per-minute guard.
   Tests import the implementation directly from its new owner; no old re-export
   may pull it back into default core.
2. Move `LineIndex` and the existing bounded index cache into
   `lib/transcriptIndex.ts`, shared by the core's line counter and worker pager.
   Keep its append/rewrite, whitespace, CR/LF and missing-file behavior unchanged.
   `TranscriptPager` uses this same cache implementation and remains outside
   default core. Core history receives an already-bound reader and a line-count
   function, not a pager. The existing explicit inline module creates its pager
   and binds it to engine readers. Worker readers already ignore the caller's
   pager; their wire format and version do not change. A small reader interface
   expresses the two-argument core call while engine implementations retain their
   process-owned pager parameter. This removes the need for a fake page method,
   optional unchecked parameter or failure-triggered inline import.
3. Move the existing account interface, peer type and `answerSharedMachinesOp`
   unchanged into `lib/sharedMachinesAccount.ts`. Core query authority imports
   this small module. The existing service port parser imports that contract;
   the inline constructor is exposed through `services/inline.ts`. Update type
   imports to their one canonical owner; keep no compatibility re-export.
4. Move master-only `serviceSpecs`, `UPDATER_HOST` and `UPDATER_PROCESS` into
   `harnessd/servicePlan.ts`. Update master/supervisor callers and tests. Keep
   `serviceProcessesEnv` and capability readers in `services.ts`: the former is
   also used by tmux to remove master-only variables before agent launches.
   Their names, values, PID checks and old-master behavior remain byte-for-byte
   compatible. Preserve Browser's incoming held-event declaration when combined.

## Design

1. Growth: no stored record or queue is introduced. The default core loses the
   empty inline-host maps and page cursor caches. The existing line-index cache
   remains 256 transcripts, worker pager limits stay unchanged, and record cursor
   caches remain 64 per transcript outside core. Existing per-transcript index
   growth is unchanged; this is not a new transcript resource-limit claim.
2. Concurrency: unchanged. Index updates retain their per-file serial chain;
   inline handler requests retain their AbortControllers, connection cancellation
   and settlement cleanup. No await is added to composition after service starts.
3. Read cost: unchanged indexed line counting reads only appended bytes unless
   its existing rewrite detection requires reindexing. Default core no longer
   loads page selection/response parsing or builds an unused inline host. No
   polling, IPC request or per-agent read is added.
4. Scale: request work and cache limits are unchanged; compare startup and
   repeated count/page requests on the same 16/160-session synthetic workload.
   CPU, wall time and peak RSS are recorded separately, not inferred from line
   counts. This does not clear the whole-core idle or 10x target by itself.
5. Compatibility: no public wire, service request, backend route, saved schema
   or capability version changes. Supervised default, selected inline services,
   `HARNESSD_SERVICES=none`, older-master capabilities and `HARNESS_NO_MASTER=1`
   keep the same behavior. A failed supervised service never triggers inline
   loading. Existing internal TypeScript imports are replaced in the same change.
6. Migration/rollback: no data migration or backend deployment; code revert
   restores the old composition against the same records and protocols.
7. Audience: existing core registration and trusted transcript paths remain the
   authority for history. Shared-machine queries still require the same named
   service and allowed operation; no service gains an arbitrary backend route.
8. Identity: no new process, credentials, login or executable selection. All
   existing service and engine owners stay unchanged.
9. Failure: unchanged `SERVICE_UNAVAILABLE`/`SERVICE_FAILED`, retryability,
   engine error conversion, request deadlines and inline failure logs. Tests
   explicitly cover off/failed/default and inline paths. No swallowed error or
   fallback is added to make extraction pass.
10. Platforms: shared TypeScript affects macOS, Linux and Windows. Local native
    proof uses macOS x64/Node 24.22.2 and private daemon/home/tmux fixtures. Linux
    units are automatic CI; native Windows is unverified unless separately run.
    No process-launch implementation or platform-specific code is changed.

## Selected validation before implementation

- First RED: architecture default closure must omit inline host, transcript
  paging and shared-machine reply parser while retaining required contracts;
  default lean bundle must omit corresponding implementation markers. Existing
  caller assertions for history output, line counts, service failure handling,
  shared-machine responses and master capability parsing stay intact.
- Focused units: architecture/lean entry; inline host and fallback API; history,
  engine reader and inline reader binding; index/pager golden behavior; account
  route/port parsing; master service selection and tmux environment stripping.
- Required local gates: core, harnessd and portability (existing DSH socket
  fixtures import the inline host); TypeScript and fresh bundle. Add any other
  gate selected by the final path mapper before running it.
- Native: `services.e2e.ts`, `history.e2e.ts`, plus the engine-reader cases that
  exercise default and explicit inline paging/profiles. Add one private
  no-master smoke if current cases do not cover `HARNESS_NO_MASTER=1`.
- Cost: pin source, toolchain, fixture and bundle hashes before one fixed ABBA;
  report real startup/read CPU, elapsed time and RSS, retain all attempts and
  require actual exit, EOF and fixture cleanup. Source closure counts accompany
  runtime evidence but never substitute for it.

No test, build or benchmark runs during the coordinator's Resume quiet window.
Runtime edits wait for review of this exact scope; the RED execution precedes
the implementation when that window is released.


## Current integration and selected acceptance (17 November)

Integrate Registry `16fd6142ce11ccb5060d9c3282572e45af9c5f08`, which contains
main `3bde21130396d338645e7589cb8ceab640564b53`, into the existing extraction
`6c28d2927d29827c66a21f00f320394cbccbc9eb`. Preserve the new generic frame
parts and held agent-life declarations. Inline frame parts use the optional
inline host's existing disabled state and callbacks; default out-of-process
routing remains on service links. The master selection stays outside core.
Registry ownership, durable publication, hook recovery and detached-result
caller corrections are copied unchanged from that exact parent.

The retained focused and boundary RED receipts describe the original extraction.
The old full-core log lacks a captured process exit and is not a completed gate.
Fresh acceptance selects the mapped core, harnessd and portability gates (two
workers), source and selected E2E types, architecture/environment/lean-entry
checks, and an exact-source bundle. Native acceptance selects the complete
services and history files and six engine-reader cases: inline runtime profiles
(two engines), mixed service mode, no-master mode, default paging/recaps, and
killed/frozen reader recovery. Every run records actual exit, pipe EOF and
private-fixture cleanup. This does not claim Windows native execution.

The fixture helper copies its typed engine configuration into the plain-record
argument expected by fakeEngineShim, matching the already reviewed correction
used by paste and combined-engine validation. No production launch behavior or
engine fixture values change. Cost preparation retains separate startup and
16/160-transcript caller measurements; timings run only in a coordinator-owned
quiet window, after final source and input hashes are frozen.
