# Workspace instructions outside the daemon core

Package 6 of the daemon core plan. A launch currently reads the saved-API metadata
schema and writes the API note in core. Its SCM write helper also imports the whole
Store adapter table for the instruction filenames. Workspaces already owns project
files in the edge process; it will prepare these instructions there.

## Design

Reviewed before product edits, 17 November 2026. Implementation is complete;
the remaining acceptance checks below are still pending.

1. Growth: no new persistent data files, cache, retained launch state, queue or timer. The existing
   API marker remains in the existing instruction file, once. Requests retain only
   a bounded workspace and engine until they settle. At most eight preparation
   calls are admitted by the service; excess calls answer unavailable immediately.
2. Concurrency: the service does SCM preparation first, then performs the existing
   synchronous eligibility/read/append operation without an await inside it. This
   preserves in-process serialization and the marker's idempotence. Core captures
   the launch's existing workspace/engine and rechecks its existing operation and
   binding authority after awaiting preparation, before any pane publication.
   Cancellation prevents launch publication; an already accepted best-effort note
   may have been written, just as a note written before a later launch refusal is
   retained today. This is not a new cancellable file-transaction contract.
3. Read cost: core reads no API metadata or instruction file. The service loads the
   checker and writer lazily, preserving the edge's startup boundary. Metadata is
   still limited to 1 MiB and 100 strict rows; no key store is opened. A request is
   one native absolute path of at most 4096 code units and one declared engine; a reply is a
   fixed acknowledgement. Existing workspace/instruction-file checks are retained.
4. Scale: no work while idle and no whole-agent scan. Ten times the launches adds
   no core cache; service admission remains bounded. Compare actual caller CPU,
   memory and latency on the same fixed launch-preparation workload, reporting the
   IPC cost separately from source-size reduction. Root schedules quiet timing.
5. Compatibility: public create, fork, restart and resume contracts do not change.
   The Workspaces port gains an internal optional preparation operation. An old
   service or a disabled/failed one answers unavailable; ordinary launches continue
   with the instruction file already present. An old core still does its own
   preparation and never asks the new method. Inline/no-master composition calls
   the same Workspaces implementation. The metadata-only list's legacy existence
   fallback through 2026-12-15 remains unchanged.
6. Migration and rollback: none. The metadata list, key store and existing project
   files keep their formats; reverting restores the former owner of preparation.
   No production data migration or backup restore is needed for unchanged formats.
7. Audience: the new service request accepts only authenticated core-origin calls,
   never a client-routed request. It checks bounded path/engine input before lazy
   loading or touching files. Existing private-state and eligible-workspace checks
   remain; keys, paths and file content never enter replies or failure logs.
8. Identity: this is only the computer owner's existing local launch path. Guest
   starts keep their separate launch implementation. The service uses the same
   daemon data directory and native project-root rules as core used; a caller
   cannot choose a different metadata root, account or instruction file.
9. Failure: a missing, old, killed, hung, busy or malformed service answer leaves
   ordinary agents usable. Preparation waits at most five seconds through the
   existing service-call deadline; no retry is scheduled. A fixed named log says
   the note was not confirmed and saved APIs remain accessible with `harness api`.
   A later real launch can try again. The request's slot remains occupied until
   actual settlement; timeout does not admit more unfinished work.
10. Platforms: shared TypeScript on macOS, Linux and Windows, using existing native
    path and private-state checks. No new child process or OS mechanism. Local
    validation is macOS; Linux/Windows execution is reported only when run.

## Boundary and selected checks

`WorkspacesPort.prepareInstructions(workspace, engine)` replaces the two existing
core preparation calls. It carries no file bytes or metadata. SCM environment
contracts remain in `scm/launch.ts`; instruction-write helpers move to a separate
module used only outside the core. Core inventory removes only entries no longer
reachable; Store extraction independently removes its other adapter/schema paths.

Write tests first at create, fork and relaunch callers for deferred preparation and
revoked authority. Cover process-origin/input checks, bounded admission, unavailable
fallbacks, fixed replies/logs, idempotent notes and existing private/legacy/workspace
eligibility. Run source types, architecture and lean-entry checks, the mapped local
gates, and private native service failure/isolation flows. Keep every RED, GREEN,
failed attempt and its actual process/fixture cleanup evidence. Root coordinates
heavy checks, source integration, independent review and release.

## Acceptance so far

Implementation was reviewed by the coordinating agent. Create, fork and relaunch
await the Workspaces port and recheck their existing launch authority. The service
keeps all eight slots occupied until the actual preparation settles, checks request
cancellation before the following file effects, and lazy-loads metadata and file
writers. Its SCM failure log now has a fixed name without error text or paths.

Checks on macOS, Node 24.22.2, with at most two Vitest workers:

- RED: all three actual callers launched after authority was revoked while the
  instruction callback was pending (exit 1). The original three-test patch and
  baseline log are retained. An earlier attempt also failed because the first
  dependency installation lacked two packages; that log is retained separately.
- RED: injected SCM preparation failure leaked the injected error text instead of
  the fixed name (exit 1). The original module, failure log and restore receipt
  are retained.
- GREEN: affected caller, service, port, metadata, eligibility and SCM selection:
  252 tests passed across 14 files (exit 0).
- GREEN: corrected launch composition, Store launch goldens and resume fixtures:
  178 tests passed; six native Windows tests skipped on macOS (exit 0).
- Source types passed (exit 0). The preceding type check found stale test-fixture
  callback names; its failed log is retained. `git diff --check` passed.
- The mapped local check selection is `cli-core` (`npm run test:core`). It has
  been selected, not executed for this extraction yet.

Evidence is retained in `/tmp/core-saved-api-instructions-*` on the validation
machine. The checked test and type selections have all exited; none remains
running. These passing selections are not a full coverage or release receipt.

Still required before acceptance: the mapped core coverage gate, architecture and
lean-entry checks, E2E types, the private native Workspaces/Store instruction and
failure flows, and before/after caller cost measurements. Linux and Windows
execution is not claimed. Root coordinates those checks after its quiet engine
comparison and reviews the final combination with the Store and launch extractions.
This patch removes the API metadata/writer paths; the separate Store extraction
must remove its remaining adapter and schema imports before the combined core
closure can be claimed free of them.
