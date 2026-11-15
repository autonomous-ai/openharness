# Engine storage outside the core

Package 5, step 3. This change moves existing Hermes close inspection and SQLite checkpoint export to the existing
`engine-others` process. Purge deletion is a separate checkpoint: its worker settlement and rollback boundary must
be reviewed before implementation. No engine store is newly deleted; OpenClaw's store stays kept.

## Design

- Growth: four fixed stage slots in a private checkpoint staging directory; each database export is at most 1 GiB.
  Histories above 1 GiB now refuse Close while keeping the original conversation and previous checkpoint. File-native
  checkpoints retain their existing behavior. The worker retains admission until actual work settles, including a
  caller timeout. Each operation uses bounded SQLite pages and 128 KiB output/hash chunks, never a whole-history array.
  Core startup examines only the four known stage names. It removes a stage only after private regular-file identity
  checks; a Windows open-handle removal refusal keeps that slot unavailable. A removed open descriptor cannot become
  a publication target; a delayed open must match the exact precreated inode. Worker exit closes retained descriptors.
- Concurrency: the core creates the stage, owns its descriptor and destination, and sends only the exact stage name
  and identity. The worker chooses no output path. Core validates the completed byte count, hash and file identity,
  fsyncs, and publishes the existing manifest only while the captured Close/Stop operation is still current. Cancellation,
  rebinding and a retired worker generation cannot publish a late result. No retry of a failed worker selects inline code.
- Read cost: only this conversation's existing indexed, bounded SQLite pages are read. Schema and row parsing and JSON
  serialization run in the worker. The core streams the stage once to verify its digest; no row parser enters the core.
- Scale: at most four operations and four GiB of admitted stage bytes per worker, including open unlinked stages.
  Named admission, timeout and history-not-saved failures expose the first pressure. Measure the same export workload's
  core CPU and latency before and after; record default and warmed import closures separately.
- Compatibility: the public Close API, version-1 checkpoint bytes and manifests remain unchanged. A new private worker
  capability selects the new route; explicit inline mode and older masters use the same implementation through
  `services/inline.ts` only (review removal after 2026-12-15). Hermes failures still mean unknown (`null`), never zero.
- Migration/rollback: no stored conversation or manifest migration. The fixed temporary slots are disposable only after
  identity validation. Reverting restores the old export implementation and leaves committed checkpoints readable.
- Audience: only authenticated local core service requests reach the worker handlers; client connections are rejected.
- Identity: input is the captured registered engine/session/profile, under the same user's login. No worker result grants
  registry, terminal, destination or manifest authority.
- Failure: bounded waits, fixed diagnostic codes and existing `HISTORY_NOT_SAVED` behavior. A failed export retains original
  history and the preceding checkpoint. Hermes inspection never throws or hangs Close.
- Platforms: TypeScript behavior affects macOS, Linux and Windows. Local native acceptance is macOS on pinned Node 24.22.2;
  no new process-spawn implementation. Native Windows/Linux acceptance is not claimed by local tests.

## Purge design still under review

The existing stopped-agent `.resume` reservation is durable, but its stale takeover is based on age. A timeout or lost
service connection does not prove that a frozen writer has stopped. Worker deletion cannot ship until the reservation
remains effective through confirmed commit/rollback or process termination, including replacement by an older core.
Preflight and a one-use grant alone do not close that gap.
