# Registry image reads during initialization

## Design

The startup profile at `b3ac09ec33` measured 6.627 ms reading and decoding the 1.8 MB,
1,600-row Registry image. Startup and corruption recovery still call the synchronous
private-file reader even though Registry loading and its writer already have asynchronous
admission. Reuse `readPrivateRegistryFile` for those two whole-image reads. This removes
disk waiting from the event loop without adding a worker, store or alternate reader.

Initialization owns its existing promise until the read, descriptor close, validation and
required migration settle. Public reads remain unavailable once private initialization
starts; mutations are refused from load admission. Exit waits for the same owned load.
Quarantine reads the current image under the existing cross-process lock, compares the
complete original contents, then checks lock ownership immediately before the synchronous
rename. A changed peer image is preserved and recovery refuses.

- Growth: no new retained state. Existing complete-image and row growth remain unresolved;
  this change introduces no guessed cap, eviction, hidden rows or memory acceptance claim.
- Concurrency: existing initialization admission and Registry file lock. The asynchronous
  reader keeps its descriptor through actual close; native binding proof still starts later.
- Read cost: one existing startup image read and one existing recovery comparison. No poll,
  retry, duplicate read, new serialization or cache.
- Scale: the recorded 1,600-row profile motivates removing disk waits; JSON parsing and schema
  passes remain synchronous. Compare the unchanged 16/160/1,600-row startup workload on the
  same toolchain; report elapsed, CPU, loop hold and memory without claiming this closes growth.
- Compatibility: bytes, schemas, old readers, migration order and public APIs are unchanged.
  The existing asynchronous reader is already used by Registry persistence on all platforms.
- Migration and rollback: no data migration; rollback restores the former read implementation.
- Audience and identity: the same private root, owner, permission and no-follow checks apply.
  No other account, process environment, user content or path enters new logs or metrics.
- Failure: unreadable images retain the existing write-blocked state; missing images retain
  the empty-start behavior. A changed recovery image still throws before rename.
- Platforms: common TypeScript on macOS, Linux and Windows; native Windows evidence remains
  separate. Process creation, launch policy and dependencies are untouched.

Checks selected before implementation: RED caller tests for held initial I/O and held
quarantine I/O; existing initialization, Registry and persistence/security cases; types.
Keep real lock/native identity checks on the unsandboxed, isolated test path. Cost and final
combined-source validation are coordinator-owned; do not repeat unchanged broad gates.

## Caller validation

Both new held-I/O caller tests failed on `787c737db6`: startup and quarantine completed
through their synchronous reader instead of waiting for the owned asynchronous read. With
the two read sites changed, initialization, Registry, persistence and private-file security
tests pass 185 cases (two existing skips); recovery and growing-file cases pass another
23 (one existing skip). Typechecking passes. All commands settled normally with actual exit
zero. Logs: `/tmp/registry-image-read-{red,green,recovery,types}.log`. Fixed startup cost
comparison, independent review and combined integration are still pending.
