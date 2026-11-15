# Engine storage outside the core

Package 5, step 3. This change moves existing Hermes close inspection and SQLite checkpoint export to the existing
`engine-others` process. Purge deletion is a separate checkpoint: its worker settlement and rollback boundary must
be reviewed before implementation. No engine store is newly deleted; OpenClaw's store stays kept.

## Design

- Growth: four fixed stage slots in a private checkpoint staging directory; each database export is at most 1 GiB.
  Histories above 1 GiB now refuse Close while keeping the original conversation and previous checkpoint. File-native
  checkpoints retain their existing behavior. The worker retains admission until actual work settles, including a
  caller timeout. Each operation uses bounded SQLite pages and 128 KiB output/hash chunks, never a whole-history array.
  Four exclusive slot directories each contain one stage and one bounded owner record. Before dispatch the core fsyncs
  the exact writer PID into that record. A worker lifetime nonce fences replacement; its PID must match the master's
  existing status push, sourced from the supervisor's child handle. No worker-reported PID alone authorizes cleanup.
  Startup examines only these four slots. Recovery requires positive ESRCH for the owning core and either a durable
  settled record or positive ESRCH for its writer. A live, reused or unreadable PID retains the slot. A crash between
  mkdir and owner-record completion leaves an unknown slot reserved; a fixed diagnostic reports it. Recovery claims
  an exclusive fixed cleanup directory, so two cores cannot reap/reuse the same slot. A crash during cleanup retains
  that slot. No unresolved writer's file is unlinked, including on timeout, disconnect, core/master replacement or
  rollback. Windows open-handle refusal also retains the slot. Thus repeated restarts cannot add a fifth stage or
  orphan open stage bytes outside the four-GiB aggregate limit; small fixed metadata is bounded within those slots.
  Before rename, the core durably records its chosen history basename in that same slot. A crash between rename and
  manifest commit therefore leaves the result charged to the slot. Recovery checks the existing v1 manifest: its
  referenced result stays; an unreferenced result is removed only with the exact recorded inode. Malformed manifests,
  substituted result identities and uncertain cleanup retain the slot. The worker never receives this destination.
- Concurrency: the core creates the stage, owns its descriptor and destination, and sends only the exact stage name
  and identity. The worker chooses no output path. Core validates the completed byte count, hash and file identity,
  fsyncs once, closes its retained descriptor, then synchronously checks fixed-path inode/version and current authority
  immediately before synchronous rename. No await or pathname reopen separates that final fence from publication.
  It publishes the existing manifest only while the captured Close/Stop operation is still current. Cancellation,
  rebinding and a retired worker generation cannot publish a late result. No retry of a failed worker selects inline code.
- Read cost: only this conversation's existing indexed, bounded SQLite pages are read. Schema and row parsing and JSON
  serialization run in the worker. The core streams the stage once to verify its digest; no row parser enters the core.
- Scale: at most four operations and four GiB of admitted stage bytes per worker, including open unlinked stages.
  Named admission, timeout and history-not-saved failures expose the first pressure. Measure the same export workload's
  core CPU and latency before and after; record default and warmed import closures separately.
- Compatibility: the public Close API, version-1 checkpoint bytes and manifests remain unchanged. A new private worker
  capability selects the new route; explicit inline mode and older masters use the same implementation through
  `services/inline.ts` only (review removal after 2026-12-15). Hermes failures still mean unknown (`null`), never zero.
  The whole storage step ships as engine-others version 4, including the master's service-process evidence. The earlier
  local version-4 Hermes checkpoint was never published; it is not another compatibility contract.
  Hermes inspection no longer single-flights profile discovery or persists a discovered home into the registry; live
  attachment remains the existing owner of that update. Inspection uses the captured home when present, otherwise a
  bounded read in the worker, under the shared four-operation admission limit.
- Migration/rollback: no stored conversation or manifest migration. New cores never age out an unresolved slot. Older
  cores ignore this new staging directory and use their existing temporary files, so they cannot unlink a live stage.
  Reverting leaves committed checkpoints readable. The maximum export above is intentionally new; existing histories
  above 32 MiB remain supported through bounded pages, while above 1 GiB now refuses Close without deleting anything.
- Audience: only authenticated local core service requests reach the worker handlers; client connections are rejected.
- Identity: input is the captured registered engine/session/profile, under the same user's login. No worker result grants
  registry, terminal, destination or manifest authority.
- Failure: bounded waits, fixed diagnostic codes and existing `HISTORY_NOT_SAVED` behavior. A failed export retains original
  history and the preceding checkpoint. Exhausted retained slots report HISTORY_NOT_SAVED: history saving is held by
  unfinished operations; stop/restart Harness and contact support if it remains held. Restart never promises release of
  live/uncertain writers. Missing/invalid ownership remains reserved and the fixed STAGE_CLEANUP_UNAVAILABLE diagnostic
  identifies the need for inspection. Hermes inspection never throws or hangs Close. Master service evidence is pushed on
  existing want/lifecycle events; first use waits boundedly for that push inside its original operation deadline.
  Database checkpoints share one absolute 30-second deadline from stage acquisition through export, verification and
  publication. There is no timer per chunk. Acquisition, hashing and descriptor close race that deadline, and core
  checks it synchronously at publication. Timeout reports HISTORY_NOT_SAVED promptly and issues no new reads or rename.
  The same four slots keep any pending OS operation charged: cleanup runs only after the actual read and descriptor
  close settle. A stage acquired after its caller timed out is explicitly closed through that same bounded cleanup.
  No unbounded cleanup queue is added; at most the four reserved slots can carry unfinished work. A hung close or
  unreadable ownership retains its slot; positive core death remains necessary for recovery after replacement.
- Platforms: TypeScript behavior affects macOS, Linux and Windows. Local native acceptance is macOS on pinned Node 24.22.2;
  no new process-spawn implementation. Native Windows/Linux acceptance is not claimed by local tests.

## Purge design still under review

The existing stopped-agent `.resume` reservation is durable, but its stale takeover is based on age. A timeout or lost
service connection does not prove that a frozen writer has stopped. Worker deletion cannot ship until the reservation
remains effective through confirmed commit/rollback or process termination, including replacement by an older core.
Preflight and a one-use grant alone do not close that gap.

The directory form of `.resume` fails closed in older `finishResume`: `readPrivateStateFile` refuses a directory.
The regular-file check predates the supported 30-day window (2026-09-24, `07863c70162`). Direct Resume therefore cannot
retake this directory by age. External-resume admission checks stopped reservations, and discovery revives a stopped
owner only when `resumeReservedAt` is null. A legacy supersede can rename archive metadata before refusing the marker;
that metadata change does not itself launch an engine. Adoption of an already-running externally launched engine is a
separate race that the existing synchronous purge also cannot atomically exclude.

Strict durable registry absence would fix `removeAgent`'s best-effort persistence gap, but does not fence every older
launcher. In the 2026-10-21 source (`8eb94821d3`), `core/main.ts` checks for a serving daemon at line 520, loads registry
at 544, binds the local socket at 2034, restores at 2376, and subscribes to remembered master loss at 2884. On macOS or
Linux, an older startup can load a row and pause before binding. A new core can win the bind, remove that row durably,
dispatch a purge, then die with its writer frozen. The older startup can claim the freed socket and launch from its
stale memory before handling master loss. `restoreOwner` checks memory, and changed stale rows can be saved again.
Windows' earlier data-folder claim narrows this specific path; it does not supply a cross-platform lifetime proof.
The registry owner is reviewing an absence barrier, but it must not be described as permanent exclusion.

An alternative under review keeps only an atomic commit primitive within the core process. Vendor discovery, schema
inspection, parent/trigger/FK analysis and sizing run outside it. The core derives the database target from the captured
engine/profile and checks its reviewed inode. A small trusted declaration set describes the existing five layouts
(OpenCode legacy/v2, Kilo, Hermes, Devin), their child predicates, and parent/schema guards. Worker output contains
bounded data such as layout and schema version, never executable SQL or destination authority. OpenClaw remains kept.

Running that commit in a core-owned `worker_thread` could preserve responsiveness while ensuring the writer cannot
survive core process death. This is a thread in the core process, not independent process isolation. SQLite busy timeout
bounds lock waiting only; it does not bound query execution or filesystem I/O. A 15-second caller deadline therefore
cannot release authority: admission and the stopped reservation remain held through actual commit/rollback or confirmed
thread termination. Shutdown/update must settle that writer, or end the core process, before releasing the listening
authority to an older startup. No bounded SQLite termination is claimed. The thread has its own JS heap but shares the
process's native address space and SQLite page/cache allocations; thread resource limits alone do not bound native
memory. Exact row/page/cache limits, index requirements, core declaration size, and same-workload latency/CPU/RSS need
measurement and review before this alternative is approved. No destructive implementation is included in this checkpoint.
